import path from "node:path";
import { filterSecretValues, loadEnvFile } from "../../env/index.js";
import type { AdapterServer } from "../adapters/types.js";
import { resolveAdapter } from "../adapters/detect.js";
import { FunctionRegistry } from "./FunctionRegistry.js";
import { WorkerPool } from "./WorkerPool.js";
import { AuthMiddleware } from "./AuthMiddleware.js";
import { authenticateRequest } from "./authenticateRequest.js";
import { WorkerRequestHandler } from "./WorkerRequestHandler.js";
import { FileWatcher } from "./FileWatcher.js";
import { WebSocketProxyHandler } from "./WebSocketProxyHandler.js";
import type {
  NodeUpgradeHandler,
  RelayUpgradeHandler,
  HostWebSocket,
} from "./WebSocketTypes.js";
import type {
  EdgeFunctionServerOptions,
  Middleware,
  RequestContext,
} from "../utils/types.js";

export class EdgeFunctionServer {
  #options: EdgeFunctionServerOptions;
  #registry: FunctionRegistry;
  #pool: WorkerPool | undefined;
  #requestHandler: WorkerRequestHandler | undefined;
  #fileWatcher: FileWatcher | undefined;
  #server: AdapterServer | undefined;
  #middleware: Middleware[] = [];
  #wsProxyHandler: WebSocketProxyHandler;

  constructor(options: EdgeFunctionServerOptions) {
    this.#options = options;
    this.#registry = new FunctionRegistry({
      functionsDir: options.functionsDir,
      permissionProfiles: options.permissionProfiles,
      onFunctionError: options.onFunctionError,
    });
    this.#wsProxyHandler = new WebSocketProxyHandler({
      maxWebSocketConnections: options.maxWebSocketConnections ?? 100,
      onWebSocketConnect: options.onWebSocketConnect,
      onWebSocketClose: options.onWebSocketClose,
      onWebSocketError: options.onWebSocketError,
    });
  }

  async start(): Promise<void> {
    await this.#registry.scan();
    await this.#registry.generateImportMap(
      this.#options.importMapPath,
      this.#options.configPath
    );
    const { envBase, secretValues } = await this.#loadEnv();

    this.#pool = new WorkerPool({
      registry: this.#registry,
      serverOptions: this.#options,
      envBase,
      secretValues,
    });
    this.#pool.setWebSocketProxyHandler(this.#wsProxyHandler);

    this.#requestHandler = new WorkerRequestHandler(this.#pool, {
      onFunctionError: this.#options.onFunctionError,
      onRequestStats: this.#options.onRequestStats,
    });

    // Build middleware chain
    this.#middleware = [];
    if (this.#options.auth) {
      const auth = new AuthMiddleware({
        auth: this.#options.auth,
        registry: this.#registry,
        publicFunctions: this.#options.publicFunctions,
        onAuthFailure: this.#options.onAuthFailure,
      });
      this.#middleware.push(auth.middleware());
    }
    this.#middleware.push(this.#requestHandler.middleware());

    const adapter = await resolveAdapter(this.#options.adapter);
    this.#server = adapter.createServer((request) =>
      this.#handleRequest(request).catch((err) => {
        this.#options.onFunctionError?.("unknown", err);
        return new Response(
          JSON.stringify({ error: "Internal Server Error" }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      })
    );

    // Set auth check on adapter for Bun/Deno WebSocket upgrades
    if (this.#options.auth && this.#server.setAuthCheck) {
      this.#server.setAuthCheck(async (request, functionName) => {
        return authenticateRequest({
          request,
          functionName,
          auth: this.#options.auth!,
          registry: this.#registry,
          publicFunctions: this.#options.publicFunctions ?? [],
          onAuthFailure: this.#options.onAuthFailure,
        });
      });
    }

    // Register WebSocket upgrade handler if the adapter supports it
    if (this.#server.onUpgrade) {
      if (this.#server.supportsRawUpgrade) {
        // Node.js splice mode: raw socket access
        const nodeHandler: NodeUpgradeHandler = (
          req,
          clientSocket,
          head,
          functionName
        ) => {
          const authGate = this.#options.auth
            ? (async () => {
                const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
                const headers = new Headers();
                for (const [key, value] of Object.entries(req.headers)) {
                  if (value !== undefined) {
                    headers.set(
                      key,
                      Array.isArray(value) ? value.join(", ") : value
                    );
                  }
                }
                const request = new Request(url, { method: "GET", headers });

                const result = await authenticateRequest({
                  request,
                  functionName,
                  auth: this.#options.auth!,
                  registry: this.#registry,
                  publicFunctions: this.#options.publicFunctions ?? [],
                });

                if (!result.authenticated) {
                  const body = JSON.stringify({ error: "Unauthorized" });
                  clientSocket.write(
                    `HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
                  );
                  clientSocket.destroy();
                  return;
                }

                if (result.claims) {
                  const encoded = Buffer.from(
                    JSON.stringify(result.claims)
                  ).toString("base64url");
                  req.headers["x-auth-claims"] = encoded;
                }
              })()
            : Promise.resolve();

          authGate
            .then(() => {
              if (clientSocket.destroyed) return;
              return this.#pool!.getOrCreate(functionName);
            })
            .then((instance) => {
              if (!instance) return;
              const socketPath = instance.worker.socketPath;
              return this.#wsProxyHandler.handleRawUpgrade(
                req,
                clientSocket,
                head,
                functionName,
                socketPath,
                instance.id
              );
            })
            .catch(() => {
              if (!clientSocket.destroyed) {
                clientSocket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
                clientSocket.destroy();
              }
            });
        };
        this.#server.onUpgrade(nodeHandler);
      } else {
        // Bun/Deno relay mode: HostWebSocket abstraction
        const relayHandler: RelayUpgradeHandler = (
          functionName: string,
          hostSocket: HostWebSocket,
          extraHeaders?: Record<string, string>
        ) => {
          this.#pool!.getOrCreate(functionName)
            .then((instance) => {
              const socketPath = instance.worker.socketPath;
              return this.#wsProxyHandler.handleRelayUpgrade(
                functionName,
                hostSocket,
                socketPath,
                instance.id,
                `ws://localhost/${functionName}`,
                "localhost",
                extraHeaders
              );
            })
            .catch(() => {
              hostSocket.close(1013, "Try again later");
            });
        };
        this.#server.onUpgrade(relayHandler);
      }
    }

    const hostname = this.#options.hostname ?? "127.0.0.1";
    await this.#server.listen(this.#options.port, hostname);

    if (this.#options.hotReload) {
      this.#fileWatcher = new FileWatcher({
        functionsDir: this.#options.functionsDir,
        watchSharedFolders: this.#options.watchSharedFolders !== false,
      });
      this.#fileWatcher.start(
        async (name) => {
          // Re-scan to detect new/removed functions
          await this.#registry.scan();
          if (this.#pool!.getActiveWorkerNames().includes(name)) {
            await this.#pool!.restart(name);
          }
        },
        async () => {
          // Re-scan to detect new/removed functions and shared folders
          await this.#registry.scan();
          // Regenerate import map and restart all workers
          await this.#registry.generateImportMap(
            this.#options.importMapPath,
            this.#options.configPath
          );
          const workerNames = this.#pool!.getActiveWorkerNames();
          await Promise.all(workerNames.map((n) => this.#pool!.restart(n)));
        }
      );
    }

    await this.#pool.eagerSpawn(this.#registry.listFunctions());
  }

  async stop(): Promise<void> {
    this.#fileWatcher?.stop();

    // Close all WebSocket connections before terminating workers
    for (const name of this.listFunctions()) {
      this.#wsProxyHandler.closeAllConnectionsForFunction(
        name,
        1001,
        "Going Away"
      );
    }

    this.#pool?.stopAllHealthChecks();
    this.#pool?.terminateAll();

    // Clean up generated import map
    await this.#registry.cleanupImportMap();

    if (this.#server) {
      await this.#server.close();
      this.#server = undefined;
    }
  }

  get port(): number {
    if (!this.#server) {
      throw new Error("Server is not listening");
    }
    return this.#server.port;
  }

  listFunctions(): string[] {
    return this.#registry.listFunctions();
  }

  async restartFunction(name: string): Promise<void> {
    if (!this.#pool) throw new Error("Server is not started");
    await this.#pool.restart(name);
  }

  getWorkerStats(name: string): {
    totalRequests: number;
    uptimeMs: number;
    restartCount: number;
  } {
    if (!this.#pool) throw new Error("Server is not started");
    const stats = this.#pool.getStats(name);
    // Backward-compatible: return flat stats
    return {
      totalRequests: stats.totalRequests,
      uptimeMs:
        stats.instances.length > 0
          ? Math.max(...stats.instances.map((i) => i.uptimeMs))
          : 0,
      restartCount: stats.restartCount,
    };
  }

  async #handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const functionName = segments[0];

    if (!functionName || !this.#registry.hasFunction(functionName)) {
      return new Response(JSON.stringify({ error: "Function not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const ctx: RequestContext = { request, functionName, url };
    const run = this.#middleware.reduceRight(
      (next: () => Promise<Response>, mw: Middleware) => () => mw(ctx, next),
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "No handler" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        )
    );
    return run();
  }

  async #loadEnv(): Promise<{
    envBase: Record<string, string>;
    secretValues: string[];
  }> {
    // Layer 2: global .env
    const globalEnv = await loadEnvFile(
      path.join(this.#options.functionsDir, ".env")
    );

    // Layer 3: additional envFiles
    let envFilesEnv: Record<string, string> = {};
    if (this.#options.envFiles) {
      for (const filePath of this.#options.envFiles) {
        const loaded = await loadEnvFile(filePath);
        envFilesEnv = { ...envFilesEnv, ...loaded };
      }
    }

    // Layer 4: programmatic env
    const envBase = {
      ...globalEnv,
      ...envFilesEnv,
      ...(this.#options.env ?? {}),
    };

    // Collect secret values for masking (only keys matching secret-like patterns)
    let secretValues: string[] = [];
    if (this.#options.maskSecrets !== false) {
      secretValues = filterSecretValues(envBase);
    }

    return { envBase, secretValues };
  }
}

/** Convenience factory */
export function newEdgeFunctionServer(
  options: EdgeFunctionServerOptions
): EdgeFunctionServer {
  return new EdgeFunctionServer(options);
}

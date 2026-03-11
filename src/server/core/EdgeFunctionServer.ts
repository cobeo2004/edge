import path from "node:path";
import { filterSecretValues, loadEnvFile } from "../../env/index.js";
import type { AdapterServer } from "../adapters/types.js";
import { resolveAdapter } from "../adapters/detect.js";
import { FunctionRegistry } from "./FunctionRegistry.js";
import { WorkerPool } from "./WorkerPool.js";
import { AuthMiddleware } from "./AuthMiddleware.js";
import { WorkerRequestHandler } from "./WorkerRequestHandler.js";
import { FileWatcher } from "./FileWatcher.js";
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

  constructor(options: EdgeFunctionServerOptions) {
    this.#options = options;
    this.#registry = new FunctionRegistry({
      functionsDir: options.functionsDir,
      permissionProfiles: options.permissionProfiles,
      onFunctionError: options.onFunctionError,
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

    if (this.#options.eagerSpawn) {
      await Promise.all(
        this.#registry
          .listFunctions()
          .map((name) => this.#pool!.getOrCreate(name))
      );
    }
  }

  async stop(): Promise<void> {
    this.#fileWatcher?.stop();

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
    return this.#pool.getStats(name);
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

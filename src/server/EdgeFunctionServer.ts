import fs from "node:fs";
import path from "node:path";
import type { DenoHTTPWorker } from "../worker/index.js";
import { loadEnvFile } from "../env/index.js";
import type { AuthResult } from "../auth/types.js";
import type { AdapterServer } from "./adapters/types.js";
import { resolveAdapter } from "./adapters/detect.js";
import type { EdgeFunctionServerOptions } from "./types.js";
import { FunctionRegistry } from "./FunctionRegistry.js";
import { WorkerPool } from "./WorkerPool.js";

const SECRET_KEY_PATTERN = /SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL|AUTH|PRIVATE/i;

function filterSecretValues(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([key]) => SECRET_KEY_PATTERN.test(key))
    .map(([, value]) => value);
}

export class EdgeFunctionServer {
  #options: EdgeFunctionServerOptions;
  #registry: FunctionRegistry;
  #pool!: WorkerPool;
  #server: AdapterServer | undefined;
  #watcher: fs.FSWatcher | undefined;
  #debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #envBase: Record<string, string> = {};
  #secretValues: string[] = [];

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
    await this.#registry.generateImportMap(this.#options.importMapPath, this.#options.configPath);
    await this.#loadEnv();

    this.#pool = new WorkerPool({
      registry: this.#registry,
      serverOptions: this.#options,
      envBase: this.#envBase,
      secretValues: this.#secretValues,
    });

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
      this.#startWatcher();
    }

    if (this.#options.eagerSpawn) {
      await Promise.all(
        this.#registry.listFunctions().map((name) => this.#pool.getOrCreate(name))
      );
    }
  }

  async stop(): Promise<void> {
    if (this.#watcher) {
      this.#watcher.close();
      this.#watcher = undefined;
    }
    for (const timer of this.#debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.#debounceTimers.clear();

    this.#pool.stopAllHealthChecks();
    this.#pool.terminateAll();

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
    await this.#pool.restart(name);
  }

  async #loadEnv(): Promise<void> {
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
    this.#envBase = {
      ...globalEnv,
      ...envFilesEnv,
      ...(this.#options.env ?? {}),
    };

    // Collect secret values for masking (only keys matching secret-like patterns)
    if (this.#options.maskSecrets !== false) {
      this.#secretValues = filterSecretValues(this.#envBase);
    }
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

    // Auth check
    let authClaims: Record<string, unknown> | undefined;
    if (this.#options.auth) {
      const isPublic =
        this.#options.publicFunctions?.includes(functionName) ||
        this.#registry.getFunctionConfig(functionName)?.auth === false;

      if (!isPublic) {
        let credentials: string | null;
        try {
          credentials = await this.#options.auth.extractCredentials(request);
        } catch (err) {
          const result: AuthResult = {
            valid: false,
            error:
              err instanceof Error
                ? err.message
                : "Credential extraction failed",
          };
          if (this.#options.onAuthFailure) {
            return this.#options.onAuthFailure(request, result);
          }
          return new Response(
            JSON.stringify({
              error: "Unauthorized",
              message: result.error,
            }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        if (!credentials) {
          const result: AuthResult = {
            valid: false,
            error: "No credentials provided",
          };
          if (this.#options.onAuthFailure) {
            return this.#options.onAuthFailure(request, result);
          }
          return new Response(
            JSON.stringify({
              error: "Unauthorized",
              message: result.error,
            }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        let authResult: AuthResult;
        try {
          authResult = await this.#options.auth.verify(credentials);
        } catch (err) {
          authResult = {
            valid: false,
            error: err instanceof Error ? err.message : "Verification failed",
          };
        }

        if (!authResult.valid) {
          if (this.#options.onAuthFailure) {
            return this.#options.onAuthFailure(request, authResult);
          }
          return new Response(
            JSON.stringify({
              error: "Unauthorized",
              message: authResult.error,
            }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        authClaims = authResult.claims;
      }
    }

    let worker: DenoHTTPWorker;
    try {
      worker = await this.#pool.getOrCreate(functionName);
    } catch (err) {
      this.#options.onFunctionError?.(functionName, err as Error);
      return new Response(
        JSON.stringify({ error: "Failed to start function worker" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    // Rewrite URL: strip the function name prefix
    const remainingPath = `/${segments.slice(1).join("/")}`;
    const rewrittenUrl = `${url.protocol}//${url.host}${remainingPath}${url.search}`;

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    // Always strip x-auth-claims to prevent spoofing from clients
    delete headers["x-auth-claims"];
    if (authClaims) {
      headers["x-auth-claims"] = Buffer.from(
        JSON.stringify(authClaims)
      ).toString("base64url");
    }

    const startTime = Date.now();
    this.#pool.incrementRequestCount(functionName);

    return new Promise<Response>((resolve, reject) => {
      const proxyReq = worker.request(
        rewrittenUrl,
        { method: request.method, headers },
        (proxyRes) => {
          const statusCode = proxyRes.statusCode ?? 200;
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(proxyRes.headers)) {
            if (value === undefined) continue;

            const headerName = key.toLowerCase();
            if (Array.isArray(value)) {
              if (headerName === "set-cookie") {
                for (const v of value) {
                  responseHeaders.append(key, v);
                }
              } else {
                responseHeaders.set(key, value.join(", "));
              }
            } else {
              if (headerName === "set-cookie") {
                responseHeaders.append(key, value);
              } else {
                responseHeaders.set(key, value);
              }
            }
          }
          let statsEmitted = false;
          const emitStats = (status: number, timedOut: boolean) => {
            if (statsEmitted) return;
            statsEmitted = true;
            this.#emitStats(functionName, startTime, status, timedOut);
          };
          const body = new ReadableStream({
            start(controller) {
              proxyRes.on("data", (chunk: Buffer) => controller.enqueue(chunk));
              proxyRes.on("end", () => {
                controller.close();
                emitStats(statusCode, false);
              });
              proxyRes.on("error", (err) => {
                emitStats(statusCode, false);
                controller.error(err);
              });
            },
          });
          resolve(
            new Response(body, {
              status: statusCode,
              headers: responseHeaders,
            })
          );
        }
      );

      proxyReq.on("error", (err) => {
        this.#options.onFunctionError?.(functionName, err);
        const timedOut = (err as any).code === "ERR_REQUEST_TIMEOUT";
        const status = timedOut ? 504 : 502;
        const errorMsg = timedOut
          ? "Request timed out"
          : "Worker request failed";
        this.#emitStats(functionName, startTime, status, timedOut);
        resolve(
          new Response(JSON.stringify({ error: errorMsg }), {
            status,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      if (request.body) {
        const reader = request.body.getReader();
        const pump = (): void => {
          reader
            .read()
            .then(({ done, value }) => {
              if (done) {
                proxyReq.end();
                return;
              }
              proxyReq.write(value);
              pump();
            })
            .catch((err) => {
              proxyReq.destroy(err);
              reject(err);
            });
        };
        pump();
      } else {
        proxyReq.end();
      }
    });
  }

  #emitStats(
    functionName: string,
    startTime: number,
    statusCode: number,
    timedOut: boolean
  ): void {
    if (!this.#options.onRequestStats) return;
    const endTime = Date.now();
    this.#options.onRequestStats({
      functionName,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      statusCode,
      timedOut,
    });
  }

  getWorkerStats(name: string): {
    totalRequests: number;
    uptimeMs: number;
    restartCount: number;
  } {
    return this.#pool.getStats(name);
  }

  #startWatcher(): void {
    const watchShared = this.#options.watchSharedFolders !== false;

    this.#watcher = fs.watch(
      this.#options.functionsDir,
      { recursive: true },
      (_event, filename) => {
        if (!filename) return;
        // filename is relative to functionsDir, e.g. "hello/index.ts" or "_shared/cors.ts"
        const topDir = filename.split(path.sep)[0]!;
        const isSharedChange = topDir.startsWith("_");

        // Skip shared folder changes if watchSharedFolders is disabled
        if (isSharedChange && !watchShared) return;

        // Debounce key: use the top-level dir for function changes,
        // use "__shared__" for all shared changes (so they coalesce)
        const debounceKey = isSharedChange ? "__shared__" : topDir;

        const existing = this.#debounceTimers.get(debounceKey);
        if (existing) clearTimeout(existing);

        this.#debounceTimers.set(
          debounceKey,
          setTimeout(async () => {
            this.#debounceTimers.delete(debounceKey);
            // Re-scan to detect new/removed functions and shared folders
            await this.#registry.scan();

            if (isSharedChange) {
              // Regenerate import map and restart all workers
              await this.#registry.generateImportMap(this.#options.importMapPath, this.#options.configPath);
              const workerNames = this.#pool.getActiveWorkerNames();
              await Promise.all(
                workerNames.map((name) => this.#pool.restart(name))
              );
            } else if (this.#pool.getActiveWorkerNames().includes(topDir)) {
              await this.#pool.restart(topDir);
            }
          }, 200)
        );
      }
    );
  }
}

/** Convenience factory */
export function newEdgeFunctionServer(
  options: EdgeFunctionServerOptions
): EdgeFunctionServer {
  return new EdgeFunctionServer(options);
}

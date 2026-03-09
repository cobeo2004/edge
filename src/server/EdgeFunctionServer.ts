import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DenoHTTPWorker,
  type DenoWorkerOptions,
  type LogLevel,
  type RequestStats,
  newDenoHTTPWorker,
} from "../worker/index.js";
import { loadEnvFile, createSecretMasker } from "../env/index.js";
import type { AdapterServer, ServerAdapter } from "./adapters/types.js";
import type { RuntimeName } from "./adapters/detect.js";
import { resolveAdapter } from "./adapters/detect.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVE_BOOTSTRAP_PATH = path.resolve(
  __dirname,
  "../../deno-bootstrap/serve.ts"
);

const ENTRYPOINT_NAMES = ["index.ts", "index.tsx", "index.js", "index.mjs"];

const SECRET_KEY_PATTERN = /SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL|AUTH|PRIVATE/i;

function filterSecretValues(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([key]) => SECRET_KEY_PATTERN.test(key))
    .map(([, value]) => value);
}

export interface EdgeFunctionServerOptions {
  /** Absolute path to the functions directory */
  functionsDir: string;
  /** Port to listen on */
  port: number;
  /** Hostname to bind to. Defaults to "127.0.0.1" */
  hostname?: string;
  /** Options forwarded to each DenoHTTPWorker */
  workerOptions?: Partial<DenoWorkerOptions>;
  /** Spawn all workers at startup. Default: false */
  eagerSpawn?: boolean;
  /** Watch & restart on file changes. Default: false */
  hotReload?: boolean;
  /** Called when a function worker is ready */
  onFunctionReady?: (name: string) => void;
  /** Called when a function worker encounters an error */
  onFunctionError?: (name: string, error: Error) => void;
  /** Path to an import map file passed to each worker */
  importMapPath?: string;
  /** Path to a Deno config file (deno.json) passed to each worker */
  configPath?: string;
  /** Server adapter: 'node' | 'bun' | 'deno' or a custom ServerAdapter. Default: auto-detect */
  adapter?: RuntimeName | ServerAdapter;
  /** Log level for worker output. Defaults to "silent" */
  logLevel?: LogLevel;
  /** Custom log handler for worker output, receives the function name */
  onLog?: (
    functionName: string,
    level: LogLevel,
    source: "stdout" | "stderr" | "command",
    message: string
  ) => void;
  /** Environment variables applied to all workers */
  env?: Record<string, string>;
  /** Additional .env file paths loaded at start() */
  envFiles?: string[];
  /** Mask secret values in log output. Defaults to true */
  maskSecrets?: boolean;
  /** Maximum heap memory in MB for each worker's V8 isolate */
  memoryLimitMb?: number;
  /** Per-request timeout in ms. Returns 504 on timeout */
  requestTimeout?: number;
  /** Maximum wall-clock time in ms for each worker. Worker respawns on next request */
  workerMaxDuration?: number;
  /** Called after each request completes with timing and status info */
  onRequestStats?: (stats: RequestStats) => void;
  /** Interval in ms between health-check pings. Disabled when not set */
  healthCheckInterval?: number;
  /** Timeout in ms for each health-check ping. Defaults to 5000 */
  healthCheckTimeout?: number;
  /** Consecutive failures before auto-restart. Defaults to 3 */
  healthCheckMaxFailures?: number;
  /** Called when a worker is restarted due to failed health checks */
  onWorkerUnhealthy?: (name: string, consecutiveFailures: number) => void;
}

export class EdgeFunctionServer {
  #options: EdgeFunctionServerOptions;
  #workers = new Map<string, DenoHTTPWorker>();
  #workerPromises = new Map<string, Promise<DenoHTTPWorker>>();
  #functions = new Map<string, string>();
  #server: AdapterServer | undefined;
  #watcher: fs.FSWatcher | undefined;
  #debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #envBase: Record<string, string> = {};
  #secretValues: string[] = [];
  #requestCounts = new Map<string, number>();
  #workerSpawnTimes = new Map<string, number>();
  #restartCounts = new Map<string, number>();
  #healthCheckTimers = new Map<string, ReturnType<typeof setInterval>>();
  #healthCheckFailures = new Map<string, number>();

  constructor(options: EdgeFunctionServerOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    await this.#scanFunctions();
    await this.#loadEnv();

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
        [...this.#functions.keys()].map((name) => this.#getOrCreateWorker(name))
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

    for (const name of [...this.#healthCheckTimers.keys()]) {
      this.#stopHealthCheck(name);
    }

    for (const worker of this.#workers.values()) {
      worker.terminate();
    }
    this.#workers.clear();
    this.#workerPromises.clear();

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
    return [...this.#functions.keys()].sort();
  }

  async restartFunction(name: string): Promise<void> {
    this.#stopHealthCheck(name);
    const existing = this.#workers.get(name);
    if (existing) {
      existing.terminate();
      this.#workers.delete(name);
    }
    this.#workerPromises.delete(name);
    if (this.#functions.has(name)) {
      await this.#getOrCreateWorker(name);
    }
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

  async #scanFunctions(): Promise<void> {
    this.#functions.clear();
    let entries: string[];
    try {
      entries = await fsp.readdir(this.#options.functionsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const dirPath = path.join(this.#options.functionsDir, entry);
      const stat = await fsp.stat(dirPath);
      if (!stat.isDirectory()) continue;

      for (const name of ENTRYPOINT_NAMES) {
        const candidate = path.join(dirPath, name);
        try {
          await fsp.stat(candidate);
          this.#functions.set(entry, candidate);
          break;
        } catch {
          // try next
        }
      }
    }
  }

  async #handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const functionName = segments[0];

    if (!functionName || !this.#functions.has(functionName)) {
      return new Response(JSON.stringify({ error: "Function not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    let worker: DenoHTTPWorker;
    try {
      worker = await this.#getOrCreateWorker(functionName);
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

    const startTime = Date.now();
    this.#requestCounts.set(
      functionName,
      (this.#requestCounts.get(functionName) ?? 0) + 1
    );

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
          const emitStats = () =>
            this.#emitStats(functionName, startTime, statusCode, false);
          const body = new ReadableStream({
            start(controller) {
              proxyRes.on("data", (chunk: Buffer) => controller.enqueue(chunk));
              proxyRes.on("end", () => {
                controller.close();
                emitStats();
              });
              proxyRes.on("error", (err) => controller.error(err));
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
        const timedOut = err.message.includes("timed out");
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

  #resolveHealthCheckConfig(): {
    interval: number;
    timeout: number;
    maxFailures: number;
  } | null {
    const workerOpts = this.#options.workerOptions ?? {};
    const interval =
      workerOpts.healthCheckInterval ?? this.#options.healthCheckInterval;
    if (interval === undefined) return null;

    return {
      interval,
      timeout:
        workerOpts.healthCheckTimeout ??
        this.#options.healthCheckTimeout ??
        5000,
      maxFailures:
        workerOpts.healthCheckMaxFailures ??
        this.#options.healthCheckMaxFailures ??
        3,
    };
  }

  #startHealthCheck(name: string, worker: DenoHTTPWorker): void {
    const config = this.#resolveHealthCheckConfig();
    if (!config) return;

    this.#healthCheckFailures.set(name, 0);

    const timer = setInterval(async () => {
      // Skip if this worker has been replaced
      if (this.#workers.get(name) !== worker) return;

      const healthy = await new Promise<boolean>((resolve) => {
        const timeoutId = setTimeout(() => resolve(false), config.timeout);
        try {
          const req = worker.request(
            "http://deno/__health",
            { method: "GET" },
            (res) => {
              res.on("data", () => {});
              res.on("end", () => {
                clearTimeout(timeoutId);
                resolve(true);
              });
              res.on("error", () => {
                clearTimeout(timeoutId);
                resolve(false);
              });
            }
          );
          req.on("error", () => {
            clearTimeout(timeoutId);
            resolve(false);
          });
          req.end();
        } catch {
          clearTimeout(timeoutId);
          resolve(false);
        }
      });

      if (healthy) {
        this.#healthCheckFailures.set(name, 0);
        return;
      }

      const failures = (this.#healthCheckFailures.get(name) ?? 0) + 1;
      this.#healthCheckFailures.set(name, failures);

      if (failures >= config.maxFailures) {
        this.#stopHealthCheck(name);
        this.#options.onWorkerUnhealthy?.(name, failures);
        const existing = this.#workers.get(name);
        if (existing) {
          existing.terminate();
          this.#workers.delete(name);
        }
        this.#workerPromises.delete(name);
        if (this.#functions.has(name)) {
          this.#getOrCreateWorker(name).catch((err) => {
            this.#options.onFunctionError?.(name, err as Error);
          });
        }
      }
    }, config.interval);

    this.#healthCheckTimers.set(name, timer);
  }

  #stopHealthCheck(name: string): void {
    const timer = this.#healthCheckTimers.get(name);
    if (timer) {
      clearInterval(timer);
      this.#healthCheckTimers.delete(name);
    }
    this.#healthCheckFailures.delete(name);
  }

  getWorkerStats(name: string): {
    totalRequests: number;
    uptimeMs: number;
    restartCount: number;
  } {
    const spawnTime = this.#workerSpawnTimes.get(name);
    return {
      totalRequests: this.#requestCounts.get(name) ?? 0,
      uptimeMs: spawnTime ? Date.now() - spawnTime : 0,
      restartCount: this.#restartCounts.get(name) ?? 0,
    };
  }

  async #getOrCreateWorker(name: string): Promise<DenoHTTPWorker> {
    const existing = this.#workers.get(name);
    if (existing) return existing;

    const inflight = this.#workerPromises.get(name);
    if (inflight) return inflight;

    const entrypoint = this.#functions.get(name);
    if (!entrypoint) {
      throw new Error(`Function "${name}" not found`);
    }

    const promise = this.#spawnWorker(name, entrypoint);
    this.#workerPromises.set(name, promise);

    try {
      const worker = await promise;
      this.#workers.set(name, worker);
      this.#workerPromises.delete(name);

      // Track spawn time; increment restart count if not first spawn
      if (this.#workerSpawnTimes.has(name)) {
        this.#restartCounts.set(name, (this.#restartCounts.get(name) ?? 0) + 1);
      }
      this.#workerSpawnTimes.set(name, Date.now());

      // Auto-remove on exit so next request respawns
      worker.addEventListener("exit", () => {
        this.#stopHealthCheck(name);
        this.#workers.delete(name);
      });

      this.#options.onFunctionReady?.(name);
      this.#startHealthCheck(name, worker);
      return worker;
    } catch (err) {
      this.#workerPromises.delete(name);
      throw err;
    }
  }

  async #spawnWorker(
    name: string,
    entrypoint: string
  ): Promise<DenoHTTPWorker> {
    const userOptions = this.#options.workerOptions ?? {};
    const defaultRunFlags = ["--allow-net", "--allow-env"];
    const runFlags = userOptions.runFlags ?? defaultRunFlags;

    // Layer 5: per-function .env
    const functionDir = path.dirname(entrypoint);
    const perFunctionEnv = await loadEnvFile(path.join(functionDir, ".env"));

    // Merge all layers: base (global + envFiles + programmatic) → per-function → workerOptions.env
    const mergedEnv: Record<string, string> = {
      ...this.#envBase,
      ...perFunctionEnv,
      ...(userOptions.env ?? {}),
    };

    // Collect per-function secrets for masking
    let secretValues = this.#secretValues;
    if (this.#options.maskSecrets !== false) {
      const perFunctionSecrets = filterSecretValues(perFunctionEnv);
      const workerSecrets = userOptions.env
        ? filterSecretValues(userOptions.env)
        : [];
      secretValues = [...secretValues, ...perFunctionSecrets, ...workerSecrets];
    }

    const logLevel =
      this.#options.logLevel ?? userOptions.logLevel ?? undefined;
    let onLog = userOptions.onLog;

    if (this.#options.onLog) {
      const serverOnLog = this.#options.onLog;
      onLog = (level, source, message) =>
        serverOnLog(name, level, source, message);
    } else if (logLevel && logLevel !== "silent" && !onLog) {
      onLog = (_level, source, message) => {
        if (source === "stderr") {
          console.error(`[deno:${name}]`, message);
        } else {
          console.log(`[deno:${name}]`, message);
        }
      };
    }

    // Wrap onLog with secret masker
    if (this.#options.maskSecrets !== false && onLog) {
      const mask = createSecretMasker(secretValues);
      const originalOnLog = onLog;
      onLog = (level, source, message) =>
        originalOnLog(level, source, mask(message));
    }

    return newDenoHTTPWorker(new URL(`file://${entrypoint}`), {
      ...userOptions,
      denoBootstrapScriptPath:
        userOptions.denoBootstrapScriptPath ?? SERVE_BOOTSTRAP_PATH,
      runFlags,
      importMapPath: this.#options.importMapPath ?? userOptions.importMapPath,
      configPath: this.#options.configPath ?? userOptions.configPath,
      env: mergedEnv,
      ...(logLevel ? { logLevel } : {}),
      ...(onLog ? { onLog } : {}),
      ...(this.#options.memoryLimitMb
        ? { memoryLimitMb: this.#options.memoryLimitMb }
        : {}),
      ...(this.#options.requestTimeout
        ? { requestTimeout: this.#options.requestTimeout }
        : {}),
      ...(this.#options.workerMaxDuration
        ? { workerMaxDuration: this.#options.workerMaxDuration }
        : {}),
    });
  }

  #startWatcher(): void {
    this.#watcher = fs.watch(
      this.#options.functionsDir,
      { recursive: true },
      (_event, filename) => {
        if (!filename) return;
        // filename is relative to functionsDir, e.g. "hello/index.ts"
        const functionName = filename.split(path.sep)[0]!;

        // Debounce per function
        const existing = this.#debounceTimers.get(functionName);
        if (existing) clearTimeout(existing);

        this.#debounceTimers.set(
          functionName,
          setTimeout(async () => {
            this.#debounceTimers.delete(functionName);
            // Re-scan to detect new/removed functions
            await this.#scanFunctions();
            if (this.#workers.has(functionName)) {
              await this.restartFunction(functionName);
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

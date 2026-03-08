import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DenoHTTPWorker,
  type DenoWorkerOptions,
  type LogLevel,
  newDenoHTTPWorker,
} from "../worker/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVE_BOOTSTRAP_PATH = path.resolve(
  __dirname,
  "../../deno-bootstrap/serve.ts"
);

const ENTRYPOINT_NAMES = ["index.ts", "index.tsx", "index.js", "index.mjs"];

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
  /** Log level for worker output. Defaults to "silent" */
  logLevel?: LogLevel;
  /** Custom log handler for worker output, receives the function name */
  onLog?: (
    functionName: string,
    level: LogLevel,
    source: "stdout" | "stderr" | "command",
    message: string
  ) => void;
}

export class EdgeFunctionServer {
  #options: EdgeFunctionServerOptions;
  #workers = new Map<string, DenoHTTPWorker>();
  #workerPromises = new Map<string, Promise<DenoHTTPWorker>>();
  #functions = new Map<string, string>();
  #server: http.Server | undefined;
  #watcher: fs.FSWatcher | undefined;
  #debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: EdgeFunctionServerOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    await this.#scanFunctions();

    this.#server = http.createServer((req, res) => {
      this.#handleRequest(req, res).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
        this.#options.onFunctionError?.("unknown", err);
      });
    });

    const hostname = this.#options.hostname ?? "127.0.0.1";
    await new Promise<void>((resolve) => {
      this.#server!.listen(this.#options.port, hostname, resolve);
    });

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

    for (const worker of this.#workers.values()) {
      worker.terminate();
    }
    this.#workers.clear();
    this.#workerPromises.clear();

    if (this.#server) {
      await new Promise<void>((resolve, reject) => {
        this.#server!.close((err) => (err ? reject(err) : resolve()));
      });
      this.#server = undefined;
    }
  }

  listFunctions(): string[] {
    return [...this.#functions.keys()].sort();
  }

  async restartFunction(name: string): Promise<void> {
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

  async #handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`
    );
    const segments = url.pathname.split("/").filter(Boolean);
    const functionName = segments[0];

    if (!functionName || !this.#functions.has(functionName)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Function not found" }));
      return;
    }

    let worker: DenoHTTPWorker;
    try {
      worker = await this.#getOrCreateWorker(functionName);
    } catch (err) {
      this.#options.onFunctionError?.(functionName, err as Error);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to start function worker" }));
      return;
    }

    // Rewrite URL: strip the function name prefix
    const remainingPath = `/${segments.slice(1).join("/")}`;
    const rewrittenUrl = `${url.protocol}//${url.host}${remainingPath}${url.search}`;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
    }

    const proxyReq = worker.request(
      rewrittenUrl,
      { method: req.method, headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", (err) => {
      this.#options.onFunctionError?.(functionName, err);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Worker request failed" }));
      }
    });

    req.pipe(proxyReq);
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

      // Auto-remove on exit so next request respawns
      worker.addEventListener("exit", () => {
        this.#workers.delete(name);
      });

      this.#options.onFunctionReady?.(name);
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

    return newDenoHTTPWorker(new URL(`file://${entrypoint}`), {
      ...userOptions,
      denoBootstrapScriptPath:
        userOptions.denoBootstrapScriptPath ?? SERVE_BOOTSTRAP_PATH,
      runFlags,
      importMapPath: this.#options.importMapPath ?? userOptions.importMapPath,
      configPath: this.#options.configPath ?? userOptions.configPath,
      ...(logLevel ? { logLevel } : {}),
      ...(onLog ? { onLog } : {}),
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

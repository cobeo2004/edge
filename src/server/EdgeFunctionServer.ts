import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DenoHTTPWorker,
  newDenoHTTPWorker,
} from "../worker/index.js";
import { loadEnvFile, createSecretMasker } from "../env/index.js";
import type { AuthResult } from "../auth/types.js";
import { loadFunctionConfig } from "../permissions/config.js";
import {
  BUILT_IN_PROFILES,
  resolvePermissionFlags,
} from "../permissions/profiles.js";
import type { FunctionConfig } from "../permissions/types.js";
import type { AdapterServer } from "./adapters/types.js";
import { resolveAdapter } from "./adapters/detect.js";
import type { EdgeFunctionServerOptions } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVE_BOOTSTRAP_PATH = path.resolve(
  __dirname,
  "../../deno-bootstrap/serve.ts"
);

const ENTRYPOINT_NAMES = ["index.ts", "index.tsx", "index.js", "index.mjs"];

const SHARED_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".json",
]);

const SECRET_KEY_PATTERN = /SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL|AUTH|PRIVATE/i;

function filterSecretValues(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([key]) => SECRET_KEY_PATTERN.test(key))
    .map(([, value]) => value);
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
  #healthCheckInFlight = new Set<string>();
  #functionConfigs = new Map<string, FunctionConfig>();
  #sharedFolderPaths: string[] = [];
  #importMapFile: string | undefined;

  constructor(options: EdgeFunctionServerOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    await this.#scanFunctions();
    await this.#generateImportMap();
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

    // Clean up generated import map
    if (this.#importMapFile) {
      await fsp.rm(this.#importMapFile, { force: true });
      this.#importMapFile = undefined;
    }

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
    this.#functionConfigs.clear();
    this.#sharedFolderPaths = [];
    let entries: string[];
    try {
      entries = await fsp.readdir(this.#options.functionsDir);
    } catch {
      return;
    }

    // Build lookup of all known profile names for validation
    const allProfiles: Record<string, string[]> = {
      ...BUILT_IN_PROFILES,
      ...this.#options.permissionProfiles,
    };

    for (const entry of entries) {
      const dirPath = path.join(this.#options.functionsDir, entry);
      const stat = await fsp.stat(dirPath);
      if (!stat.isDirectory()) continue;

      // Collect underscore-prefixed dirs as shared folders, skip function discovery
      if (entry.startsWith("_")) {
        this.#sharedFolderPaths.push(dirPath);
        continue;
      }

      for (const name of ENTRYPOINT_NAMES) {
        const candidate = path.join(dirPath, name);
        try {
          await fsp.stat(candidate);
          this.#functions.set(entry, candidate);
          const fnConfig = await loadFunctionConfig(dirPath, (err) => {
            this.#options.onFunctionError?.(
              entry,
              new Error(`Invalid function.json: ${err.message}`)
            );
          });
          this.#functionConfigs.set(entry, fnConfig);

          // Validate permission profile name at scan time
          if (typeof fnConfig.permissions === "string") {
            if (!allProfiles[fnConfig.permissions]) {
              this.#options.onFunctionError?.(
                entry,
                new Error(
                  `Unknown permission profile "${fnConfig.permissions}" in function.json`
                )
              );
            }
          }

          break;
        } catch {
          // try next
        }
      }
    }
  }

  async #scanSharedFiles(): Promise<Map<string, string>> {
    const entries = new Map<string, string>();

    const scan = async (dir: string, prefix: string): Promise<void> => {
      let items: string[];
      try {
        items = await fsp.readdir(dir);
      } catch {
        return;
      }
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = await fsp.stat(fullPath);
        if (stat.isDirectory()) {
          await scan(fullPath, `${prefix}${item}/`);
        } else if (SHARED_FILE_EXTENSIONS.has(path.extname(item))) {
          const key = `${prefix}${item}`;
          const fileUrl = `file://${fullPath}`;
          entries.set(key, fileUrl);
        }
      }
    };

    for (const folderPath of this.#sharedFolderPaths) {
      const folderName = path.basename(folderPath);
      await scan(folderPath, `${folderName}/`);
    }

    return entries;
  }

  async #generateImportMap(): Promise<void> {
    // Clean up previous temp file (from hot-reload regeneration)
    if (this.#importMapFile) {
      await fsp.rm(this.#importMapFile, { force: true });
      this.#importMapFile = undefined;
    }

    const sharedEntries = await this.#scanSharedFiles();
    if (
      sharedEntries.size === 0 &&
      !this.#options.importMapPath &&
      !this.#options.configPath
    )
      return;

    // Start with auto-generated entries
    const imports: Record<string, string> = {};
    for (const [key, value] of sharedEntries) {
      imports[key] = value;
    }

    // Merge user import map (user takes precedence, errors propagate — fail fast)
    let scopes: Record<string, Record<string, string>> | undefined;
    if (this.#options.importMapPath) {
      const content = await fsp.readFile(this.#options.importMapPath, "utf-8");
      const parsed = JSON.parse(content);
      const baseDir = path.dirname(path.resolve(this.#options.importMapPath));
      if (parsed.imports) {
        for (const [key, value] of Object.entries(parsed.imports)) {
          if (
            typeof value === "string" &&
            (value.startsWith("./") || value.startsWith("../"))
          ) {
            imports[key] = `file://${path.resolve(baseDir, value)}`;
          } else {
            imports[key] = value as string;
          }
        }
      }
      if (parsed.scopes) {
        scopes = parsed.scopes;
      }
    }

    // Merge config imports if present (errors caught — configPath may not contain imports)
    if (this.#options.configPath) {
      try {
        const content = await fsp.readFile(this.#options.configPath, "utf-8");
        const parsed = JSON.parse(content);
        const baseDir = path.dirname(path.resolve(this.#options.configPath));
        if (parsed.imports) {
          for (const [key, value] of Object.entries(parsed.imports)) {
            if (
              typeof value === "string" &&
              (value.startsWith("./") || value.startsWith("../"))
            ) {
              imports[key] = `file://${path.resolve(baseDir, value)}`;
            } else {
              imports[key] = value as string;
            }
          }
        }
        if (parsed.scopes && !scopes) {
          scopes = parsed.scopes;
        }
      } catch {
        // configPath may not contain import map fields — skip gracefully
      }
    }

    const importMap: Record<string, unknown> = { imports };
    if (scopes) {
      importMap.scopes = scopes;
    }

    // Write to temp file
    const tmpFile = path.join(
      os.tmpdir(),
      `deno-edge-import-map-${crypto.randomUUID()}.json`
    );
    await fsp.writeFile(tmpFile, JSON.stringify(importMap, null, 2));
    this.#importMapFile = tmpFile;
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

    // Auth check
    let authClaims: Record<string, unknown> | undefined;
    if (this.#options.auth) {
      const isPublic =
        this.#options.publicFunctions?.includes(functionName) ||
        this.#functionConfigs.get(functionName)?.auth === false;

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
    // Always strip x-auth-claims to prevent spoofing from clients
    delete headers["x-auth-claims"];
    if (authClaims) {
      headers["x-auth-claims"] = Buffer.from(
        JSON.stringify(authClaims)
      ).toString("base64url");
    }

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
      // Skip if a health check is already in-flight for this worker
      if (this.#healthCheckInFlight.has(name)) return;
      this.#healthCheckInFlight.add(name);

      let req: ReturnType<DenoHTTPWorker["request"]> | undefined;
      const healthy = await new Promise<boolean>((resolve) => {
        const timeoutId = setTimeout(() => {
          req?.destroy();
          resolve(false);
        }, config.timeout);
        try {
          req = worker.request(
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

      this.#healthCheckInFlight.delete(name);

      // Worker might have been replaced while the health check was in-flight
      if (this.#workers.get(name) !== worker) return;

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

    // Resolve permission flags: functionPermissions > function.json > defaultProfile > "standard"
    let runFlags: string[];
    if (userOptions.runFlags) {
      // Explicit runFlags in workerOptions take absolute priority
      runFlags = [...userOptions.runFlags];
    } else {
      const serverOverride = this.#options.functionPermissions?.[name];
      const fnConfig = this.#functionConfigs.get(name);
      const permissionValue = serverOverride ?? fnConfig?.permissions;
      runFlags = [
        ...resolvePermissionFlags(permissionValue, {
          defaultProfile: this.#options.defaultPermissionProfile,
          customProfiles: this.#options.permissionProfiles,
        }),
      ];
    }

    // Append shared folder read permissions
    if (this.#sharedFolderPaths.length > 0) {
      const sharedPaths = this.#sharedFolderPaths.join(",");
      const hasFullRead =
        runFlags.includes("--allow-read") || runFlags.includes("--allow-all");
      if (!hasFullRead) {
        const existingIdx = runFlags.findIndex((f) =>
          f.startsWith("--allow-read=")
        );
        if (existingIdx !== -1) {
          runFlags[existingIdx] += `,${sharedPaths}`;
        } else {
          runFlags.push(`--allow-read=${sharedPaths}`);
        }
      }
    }

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
      importMapPath:
        this.#importMapFile ??
        this.#options.importMapPath ??
        userOptions.importMapPath,
      configPath: this.#options.configPath ?? userOptions.configPath,
      env: mergedEnv,
      ...(logLevel ? { logLevel } : {}),
      ...(onLog ? { onLog } : {}),
      memoryLimitMb: userOptions.memoryLimitMb ?? this.#options.memoryLimitMb,
      requestTimeout:
        userOptions.requestTimeout ?? this.#options.requestTimeout,
      workerMaxDuration:
        userOptions.workerMaxDuration ?? this.#options.workerMaxDuration,
    });
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
            await this.#scanFunctions();

            if (isSharedChange) {
              // Regenerate import map and restart all workers
              await this.#generateImportMap();
              const workerNames = [...this.#workers.keys()];
              await Promise.all(
                workerNames.map((name) => this.restartFunction(name))
              );
            } else if (this.#workers.has(topDir)) {
              await this.restartFunction(topDir);
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

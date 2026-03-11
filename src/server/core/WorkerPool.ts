import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DenoHTTPWorker, newDenoHTTPWorker } from "../../worker/index.js";
import {
  createSecretMasker,
  filterSecretValues,
  loadEnvFile,
} from "../../env/index.js";
import { resolvePermissionFlags } from "../../permissions/profiles.js";
import type { FunctionRegistry } from "./FunctionRegistry.js";
import type { EdgeFunctionServerOptions } from "../utils/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVE_BOOTSTRAP_PATH = path.resolve(
  __dirname,
  "../../../deno-bootstrap/serve.ts"
);

export interface WorkerPoolOptions {
  registry: FunctionRegistry;
  serverOptions: EdgeFunctionServerOptions;
  envBase: Record<string, string>;
  secretValues: string[];
}

export class WorkerPool {
  #registry: FunctionRegistry;
  #serverOptions: EdgeFunctionServerOptions;
  #envBase: Record<string, string>;
  #secretValues: string[];

  #workers = new Map<string, DenoHTTPWorker>();
  #workerPromises = new Map<string, Promise<DenoHTTPWorker>>();
  #requestCounts = new Map<string, number>();
  #workerSpawnTimes = new Map<string, number>();
  #restartCounts = new Map<string, number>();
  #healthCheckTimers = new Map<string, ReturnType<typeof setInterval>>();
  #healthCheckFailures = new Map<string, number>();
  #healthCheckInFlight = new Set<string>();

  // --- Idle timeout state (grouped for future WorkerLifecycleManager extraction) ---
  #activeRequests = new Map<string, number>();
  #idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: WorkerPoolOptions) {
    this.#registry = options.registry;
    this.#serverOptions = options.serverOptions;
    this.#envBase = options.envBase;
    this.#secretValues = options.secretValues;
  }

  async getOrCreate(name: string): Promise<DenoHTTPWorker> {
    const existing = this.#workers.get(name);
    if (existing) return existing;

    const inflight = this.#workerPromises.get(name);
    if (inflight) return inflight;

    const entrypoint = this.#registry.getEntrypoint(name);
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
        this.#clearIdleTimer(name);
        this.#activeRequests.delete(name);
        this.#stopHealthCheck(name);
        this.#workers.delete(name);
      });

      this.#serverOptions.onFunctionReady?.(name);
      this.#startHealthCheck(name, worker);

      // Start idle timer if no active requests (e.g., eager spawn)
      if ((this.#activeRequests.get(name) ?? 0) === 0) {
        this.#startIdleTimer(name);
      }

      return worker;
    } catch (err) {
      this.#workerPromises.delete(name);
      throw err;
    }
  }

  async restart(name: string): Promise<void> {
    this.#clearIdleTimer(name);
    this.#activeRequests.delete(name);
    this.#stopHealthCheck(name);
    const existing = this.#workers.get(name);
    if (existing) {
      existing.terminate();
      this.#workers.delete(name);
    }
    this.#workerPromises.delete(name);
    if (this.#registry.hasFunction(name)) {
      await this.getOrCreate(name);
    }
  }

  getStats(name: string): {
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

  incrementRequestCount(name: string): void {
    this.#requestCounts.set(name, (this.#requestCounts.get(name) ?? 0) + 1);
  }

  terminateAll(): void {
    this.clearAllIdleTimers();
    for (const worker of this.#workers.values()) {
      worker.terminate();
    }
    this.#workers.clear();
    this.#workerPromises.clear();
  }

  stopAllHealthChecks(): void {
    for (const name of [...this.#healthCheckTimers.keys()]) {
      this.#stopHealthCheck(name);
    }
  }

  getActiveWorkerNames(): string[] {
    return [...this.#workers.keys()];
  }

  incrementActiveRequests(name: string): void {
    this.#clearIdleTimer(name);
    this.#activeRequests.set(name, (this.#activeRequests.get(name) ?? 0) + 1);
  }

  decrementActiveRequests(name: string): void {
    // If the worker has already exited, don't reintroduce stale state
    if (!this.#workers.has(name)) {
      this.#activeRequests.delete(name);
      return;
    }
    const count = Math.max(0, (this.#activeRequests.get(name) ?? 0) - 1);
    this.#activeRequests.set(name, count);
    if (count === 0) {
      this.#startIdleTimer(name);
    }
  }

  clearAllIdleTimers(): void {
    for (const name of [...this.#idleTimers.keys()]) {
      this.#clearIdleTimer(name);
    }
  }

  async #spawnWorker(
    name: string,
    entrypoint: string
  ): Promise<DenoHTTPWorker> {
    const userOptions = this.#serverOptions.workerOptions ?? {};

    // Resolve permission flags: functionPermissions > function.json > defaultProfile > "standard"
    let runFlags: string[];
    if (userOptions.runFlags) {
      // Explicit runFlags in workerOptions take absolute priority
      runFlags = [...userOptions.runFlags];
    } else {
      const serverOverride = this.#serverOptions.functionPermissions?.[name];
      const fnConfig = this.#registry.getFunctionConfig(name);
      const permissionValue = serverOverride ?? fnConfig?.permissions;
      runFlags = [
        ...resolvePermissionFlags(permissionValue, {
          defaultProfile: this.#serverOptions.defaultPermissionProfile,
          customProfiles: this.#serverOptions.permissionProfiles,
        }),
      ];
    }

    // Append shared folder read permissions
    const sharedFolderPaths = this.#registry.getSharedFolderPaths();
    if (sharedFolderPaths.length > 0) {
      const sharedPaths = sharedFolderPaths.join(",");
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
    if (this.#serverOptions.maskSecrets !== false) {
      const perFunctionSecrets = filterSecretValues(perFunctionEnv);
      const workerSecrets = userOptions.env
        ? filterSecretValues(userOptions.env)
        : [];
      secretValues = [...secretValues, ...perFunctionSecrets, ...workerSecrets];
    }

    const logLevel =
      this.#serverOptions.logLevel ?? userOptions.logLevel ?? undefined;
    let onLog = userOptions.onLog;

    if (this.#serverOptions.onLog) {
      const serverOnLog = this.#serverOptions.onLog;
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
    if (this.#serverOptions.maskSecrets !== false && onLog) {
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
        this.#registry.getImportMapFile() ??
        this.#serverOptions.importMapPath ??
        userOptions.importMapPath,
      configPath: this.#serverOptions.configPath ?? userOptions.configPath,
      env: mergedEnv,
      ...(logLevel ? { logLevel } : {}),
      ...(onLog ? { onLog } : {}),
      memoryLimitMb:
        userOptions.memoryLimitMb ?? this.#serverOptions.memoryLimitMb,
      requestTimeout:
        userOptions.requestTimeout ?? this.#serverOptions.requestTimeout,
      workerMaxDuration:
        userOptions.workerMaxDuration ?? this.#serverOptions.workerMaxDuration,
    });
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
        this.#serverOptions.onWorkerUnhealthy?.(name, failures);
        const existing = this.#workers.get(name);
        if (existing) {
          existing.terminate();
          this.#workers.delete(name);
        }
        this.#workerPromises.delete(name);
        if (this.#registry.hasFunction(name)) {
          this.getOrCreate(name).catch((err) => {
            this.#serverOptions.onFunctionError?.(name, err as Error);
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

  #resolveHealthCheckConfig(): {
    interval: number;
    timeout: number;
    maxFailures: number;
  } | null {
    const workerOpts = this.#serverOptions.workerOptions ?? {};
    const interval =
      workerOpts.healthCheckInterval ?? this.#serverOptions.healthCheckInterval;
    if (interval === undefined) return null;

    return {
      interval,
      timeout:
        workerOpts.healthCheckTimeout ??
        this.#serverOptions.healthCheckTimeout ??
        5000,
      maxFailures:
        workerOpts.healthCheckMaxFailures ??
        this.#serverOptions.healthCheckMaxFailures ??
        3,
    };
  }

  #resolveIdleTimeout(name: string): number | undefined {
    // Per-function override takes priority
    const fnConfig = this.#registry.getFunctionConfig(name);
    if (fnConfig?.idleTimeout !== undefined) {
      return fnConfig.idleTimeout;
    }
    // Fall back to server-level option
    return this.#serverOptions.idleTimeout;
  }

  #startIdleTimer(name: string): void {
    const timeout = this.#resolveIdleTimeout(name);
    if (timeout === undefined || timeout <= 0) return;

    this.#clearIdleTimer(name);

    const timer = setTimeout(() => {
      this.#idleTimers.delete(name);
      const worker = this.#workers.get(name);
      if (!worker) return;

      this.#stopHealthCheck(name);
      this.#healthCheckInFlight.delete(name);
      worker.terminate();
      this.#workers.delete(name);
      this.#serverOptions.onFunctionCold?.(name);
    }, timeout);

    this.#idleTimers.set(name, timer);
  }

  #clearIdleTimer(name: string): void {
    const timer = this.#idleTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.#idleTimers.delete(name);
    }
  }
}

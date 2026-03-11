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
import { WorkerLifecycleManager } from "./WorkerLifecycleManager.js";
import {
  createWorkerInstance,
  type WorkerInstance,
  type PoolStats,
} from "./WorkerInstance.js";

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

  #managers = new Map<string, WorkerLifecycleManager>();
  #workerPromises = new Map<string, Promise<WorkerInstance>>();

  constructor(options: WorkerPoolOptions) {
    this.#registry = options.registry;
    this.#serverOptions = options.serverOptions;
    this.#envBase = options.envBase;
    this.#secretValues = options.secretValues;
  }

  async getOrCreate(name: string): Promise<WorkerInstance> {
    const manager = this.#getOrCreateManager(name);

    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const result = manager.acquire();

      switch (result.kind) {
        case "instance":
          return result.instance;

        case "spawn": {
          manager.reserveSpawnSlot();
          const id = manager.nextId();
          const dedupKey = `${name}-${id}`;

          const existingPromise = this.#workerPromises.get(dedupKey);
          if (existingPromise) {
            manager.releaseSpawnSlot();
            return existingPromise;
          }

          const promise = this.#spawnAndRegister(name, id, manager);
          this.#workerPromises.set(dedupKey, promise);

          try {
            const instance = await promise;
            return instance;
          } finally {
            this.#workerPromises.delete(dedupKey);
            manager.releaseSpawnSlot();
          }
        }

        case "wait":
          await result.promise;
          // Loop and retry acquire
          continue;
      }
    }

    // After max retries, return least-loaded (fallback)
    const fallback = manager.acquire();
    if (fallback.kind === "instance") return fallback.instance;
    throw new Error(
      `Failed to acquire worker for "${name}" after ${MAX_RETRIES} retries`
    );
  }

  async #spawnAndRegister(
    name: string,
    id: string,
    manager: WorkerLifecycleManager
  ): Promise<WorkerInstance> {
    const entrypoint = this.#registry.getEntrypoint(name);
    if (!entrypoint) {
      throw new Error(`Function "${name}" not found`);
    }

    const worker = await this.#spawnWorker(name, id, entrypoint);
    const instance = createWorkerInstance(id, name, worker);

    // Auto-remove on exit so instance is cleaned up
    worker.addEventListener("exit", () => {
      manager.removeInstance(id);
    });

    manager.addInstance(instance);
    return instance;
  }

  async restart(name: string): Promise<void> {
    const manager = this.#managers.get(name);
    if (manager) {
      manager.restart();
    }

    // Clear any in-flight spawn promises for this function
    for (const key of this.#workerPromises.keys()) {
      if (key.startsWith(`${name}-`)) {
        this.#workerPromises.delete(key);
      }
    }

    if (this.#registry.hasFunction(name)) {
      const minWorkers = this.#resolveMinWorkers(name);
      const count = Math.max(minWorkers, 1);
      await Promise.all(
        Array.from({ length: count }, () => this.getOrCreate(name))
      );
    }
  }

  getStats(name: string): PoolStats {
    const manager = this.#managers.get(name);
    if (!manager) {
      return {
        functionName: name,
        instanceCount: 0,
        totalRequests: 0,
        activeRequests: 0,
        restartCount: 0,
        instances: [],
      };
    }
    return manager.getStats();
  }

  /** @deprecated Use incrementActiveRequests instead. Kept for backward compat. */
  incrementRequestCount(_name: string): void {
    // No-op: totalRequests is now tracked per-instance inside
    // manager.incrementActiveRequests(). This method is kept to avoid
    // breaking external callers but does nothing.
  }

  incrementActiveRequests(name: string, instanceId: string): void {
    const manager = this.#managers.get(name);
    manager?.incrementActiveRequests(instanceId);
  }

  decrementActiveRequests(name: string, instanceId: string): void {
    const manager = this.#managers.get(name);
    manager?.decrementActiveRequests(instanceId);
  }

  terminateAll(): void {
    for (const manager of this.#managers.values()) {
      manager.dispose();
    }
    this.#managers.clear();
    this.#workerPromises.clear();
  }

  stopAllHealthChecks(): void {
    for (const manager of this.#managers.values()) {
      manager.stopAllHealthChecks();
    }
  }

  getActiveWorkerNames(): string[] {
    const names: string[] = [];
    for (const [name, manager] of this.#managers) {
      if (manager.hasInstances()) {
        names.push(name);
      }
    }
    return names;
  }

  clearAllIdleTimers(): void {
    for (const manager of this.#managers.values()) {
      manager.clearAllIdleTimers();
    }
  }

  // --- Eager spawn support ---

  async eagerSpawn(names: string[]): Promise<void> {
    const promises: Promise<unknown>[] = [];
    for (const name of names) {
      const fnConfig = this.#registry.getFunctionConfig(name);
      const serverEager = this.#serverOptions.eagerSpawn ?? false;
      const fnEager = fnConfig?.eagerSpawn;

      // Per-function override wins, then server-level
      const shouldEagerSpawn = fnEager !== undefined ? fnEager : serverEager;
      if (!shouldEagerSpawn) continue;

      const minWorkers = this.#resolveMinWorkers(name);
      const count = Math.max(minWorkers, 1);
      for (let i = 0; i < count; i++) {
        promises.push(this.getOrCreate(name));
      }
    }
    await Promise.all(promises);
  }

  // --- Private helpers ---

  #getOrCreateManager(name: string): WorkerLifecycleManager {
    let manager = this.#managers.get(name);
    if (manager) return manager;

    const fnConfig = this.#registry.getFunctionConfig(name);
    const rawMin = fnConfig?.minWorkers ?? this.#serverOptions.minWorkers ?? 0;
    const rawMax = fnConfig?.maxWorkers ?? this.#serverOptions.maxWorkers ?? 1;

    // Validate with warnings
    let validMin = rawMin;
    let validMax = rawMax;
    if (rawMin < 0) {
      console.warn(
        `[edge] "${name}": minWorkers (${rawMin}) < 0, defaulting to 0`
      );
      validMin = 0;
    }
    if (rawMax < 1) {
      console.warn(
        `[edge] "${name}": maxWorkers (${rawMax}) < 1, defaulting to 1`
      );
      validMax = 1;
    }
    if (validMin > validMax) {
      console.warn(
        `[edge] "${name}": minWorkers (${validMin}) > maxWorkers (${validMax}), clamping minWorkers to ${validMax}`
      );
      validMin = validMax;
    }
    const finalMin = validMin;

    const idleTimeout =
      fnConfig?.idleTimeout ?? this.#serverOptions.idleTimeout;
    const healthCheckConfig = this.#resolveHealthCheckConfig();

    manager = new WorkerLifecycleManager({
      functionName: name,
      minWorkers: finalMin,
      maxWorkers: validMax,
      idleTimeout,
      healthCheckConfig: healthCheckConfig ?? undefined,
      onFunctionCold: this.#serverOptions.onFunctionCold,
      onFunctionReady: this.#serverOptions.onFunctionReady,
      onWorkerUnhealthy: this.#serverOptions.onWorkerUnhealthy,
      onFunctionError: this.#serverOptions.onFunctionError,
      onNeedSpawn: (fnName) => {
        // Health check detected we're below minWorkers — spawn replacement
        this.getOrCreate(fnName).catch((err) => {
          this.#serverOptions.onFunctionError?.(fnName, err as Error);
        });
      },
    });

    this.#managers.set(name, manager);
    return manager;
  }

  #resolveMinWorkers(name: string): number {
    const fnConfig = this.#registry.getFunctionConfig(name);
    return fnConfig?.minWorkers ?? this.#serverOptions.minWorkers ?? 0;
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

  async #spawnWorker(
    name: string,
    instanceId: string,
    entrypoint: string
  ): Promise<DenoHTTPWorker> {
    const userOptions = this.#serverOptions.workerOptions ?? {};

    // Resolve permission flags: functionPermissions > function.json > defaultProfile > "standard"
    let runFlags: string[];
    if (userOptions.runFlags) {
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

    // Merge all layers
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
          console.error(`[deno:${instanceId}]`, message);
        } else {
          console.log(`[deno:${instanceId}]`, message);
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
}

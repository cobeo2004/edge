import type { DenoHTTPWorker } from "../../worker/index.js";
import type {
  WorkerInstance,
  AcquireResult,
  PoolStats,
  InstanceStats,
} from "./WorkerInstance.js";

export interface WorkerLifecycleManagerOptions {
  functionName: string;
  minWorkers: number;
  maxWorkers: number;
  idleTimeout?: number;
  healthCheckConfig?: {
    interval: number;
    timeout: number;
    maxFailures: number;
  };
  onFunctionCold?: (name: string) => void;
  onFunctionReady?: (name: string) => void;
  onWorkerUnhealthy?: (name: string, failures: number) => void;
  onFunctionError?: (name: string, error: Error) => void;
  onNeedSpawn?: (name: string) => void;
}

export class WorkerLifecycleManager {
  #functionName: string;
  #minWorkers: number;
  #maxWorkers: number;
  #idleTimeout?: number;
  #healthCheckConfig?: {
    interval: number;
    timeout: number;
    maxFailures: number;
  };
  #options: WorkerLifecycleManagerOptions;

  #instances: WorkerInstance[] = [];
  #idCounter = 0;
  #spawningCount = 0;
  #spawnResolvers: Array<() => void> = [];
  #restartCount = 0;
  #readyFired = false;

  constructor(options: WorkerLifecycleManagerOptions) {
    this.#functionName = options.functionName;
    this.#minWorkers = options.minWorkers;
    this.#maxWorkers = options.maxWorkers;
    this.#idleTimeout = options.idleTimeout;
    this.#healthCheckConfig = options.healthCheckConfig;
    this.#options = options;
  }

  get functionName(): string {
    return this.#functionName;
  }

  get instanceCount(): number {
    return this.#instances.length;
  }

  /**
   * Get the least-loaded instance, or signal that a new spawn is needed.
   */
  acquire(): AcquireResult {
    // If no instances exist and room to spawn
    if (this.#instances.length === 0) {
      if (this.#instances.length + this.#spawningCount < this.#maxWorkers) {
        return { kind: "spawn" };
      }
      // Spawn in-flight, wait for it
      return { kind: "wait", promise: this.#waitForSpawn() };
    }

    // Find least-loaded instance
    let leastLoaded = this.#instances[0]!;
    for (let i = 1; i < this.#instances.length; i++) {
      if (this.#instances[i]!.activeRequests < leastLoaded.activeRequests) {
        leastLoaded = this.#instances[i]!;
      }
    }

    // If least-loaded is idle (0 active), use it directly
    if (leastLoaded.activeRequests === 0) {
      return { kind: "instance", instance: leastLoaded };
    }

    // All instances are busy — can we scale up?
    if (this.#instances.length + this.#spawningCount < this.#maxWorkers) {
      return { kind: "spawn" };
    }

    // At capacity with in-flight spawn — wait
    if (this.#spawningCount > 0) {
      return { kind: "wait", promise: this.#waitForSpawn() };
    }

    // At capacity, no spawns in-flight — overload least-loaded
    return { kind: "instance", instance: leastLoaded };
  }

  reserveSpawnSlot(): void {
    this.#spawningCount++;
  }

  releaseSpawnSlot(): void {
    this.#spawningCount = Math.max(0, this.#spawningCount - 1);
    // Notify any waiters that a slot may be available
    for (const resolve of this.#spawnResolvers) {
      resolve();
    }
    this.#spawnResolvers = [];
  }

  nextId(): string {
    return `${this.#functionName}-${this.#idCounter++}`;
  }

  addInstance(instance: WorkerInstance): void {
    this.#instances.push(instance);

    if (!this.#readyFired) {
      this.#readyFired = true;
      this.#options.onFunctionReady?.(this.#functionName);
    }

    // Start health check for this instance
    this.#startHealthCheck(instance);

    // Start idle timer if no active requests
    if (instance.activeRequests === 0) {
      this.#startIdleTimer(instance);
    }
  }

  removeInstance(id: string): void {
    const idx = this.#instances.findIndex((i) => i.id === id);
    if (idx === -1) return;

    const instance = this.#instances[idx]!;
    this.#clearIdleTimer(instance);
    this.#stopHealthCheck(instance);
    instance.worker.terminate();
    this.#instances.splice(idx, 1);

    // Fire onFunctionCold when last instance removed
    if (this.#instances.length === 0 && this.#spawningCount === 0) {
      this.#readyFired = false;
      this.#options.onFunctionCold?.(this.#functionName);
    }
  }

  #waitForSpawn(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#spawnResolvers.push(resolve);
    });
  }

  // --- Active request tracking ---

  incrementActiveRequests(id: string): void {
    const instance = this.#findInstance(id);
    if (!instance) return;
    this.#clearIdleTimer(instance);
    instance.activeRequests++;
    instance.totalRequests++;
  }

  decrementActiveRequests(id: string): void {
    const instance = this.#findInstance(id);
    if (!instance) return;
    instance.activeRequests = Math.max(0, instance.activeRequests - 1);
    if (instance.activeRequests === 0) {
      this.#startIdleTimer(instance);
    }
  }

  // --- Idle timeout ---

  #startIdleTimer(instance: WorkerInstance): void {
    if (this.#idleTimeout === undefined || this.#idleTimeout <= 0) return;
    this.#clearIdleTimer(instance);

    instance.idleTimer = setTimeout(() => {
      instance.idleTimer = undefined;

      // Only scale down if above minWorkers
      if (this.#instances.length <= this.#minWorkers) return;

      this.#stopHealthCheck(instance);
      const idx = this.#instances.findIndex((i) => i.id === instance.id);
      if (idx === -1) return;
      instance.worker.terminate();
      this.#instances.splice(idx, 1);

      // Fire cold callback if last instance
      if (this.#instances.length === 0 && this.#spawningCount === 0) {
        this.#readyFired = false;
        this.#options.onFunctionCold?.(this.#functionName);
      }
    }, this.#idleTimeout);
  }

  #clearIdleTimer(instance: WorkerInstance): void {
    if (instance.idleTimer) {
      clearTimeout(instance.idleTimer);
      instance.idleTimer = undefined;
    }
  }

  clearAllIdleTimers(): void {
    for (const instance of this.#instances) {
      this.#clearIdleTimer(instance);
    }
  }

  // --- Health checks ---

  #startHealthCheck(instance: WorkerInstance): void {
    if (!this.#healthCheckConfig) return;
    const config = this.#healthCheckConfig;

    instance.healthCheckFailures = 0;

    const timer = setInterval(async () => {
      // Skip if instance was removed
      if (!this.#instances.includes(instance)) {
        clearInterval(timer);
        return;
      }
      // Skip if check in-flight
      if (instance.healthCheckInFlight) return;
      instance.healthCheckInFlight = true;

      let req: ReturnType<DenoHTTPWorker["request"]> | undefined;
      const healthy = await new Promise<boolean>((resolve) => {
        const timeoutId = setTimeout(() => {
          req?.destroy();
          resolve(false);
        }, config.timeout);
        try {
          req = instance.worker.request(
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

      instance.healthCheckInFlight = false;

      // Instance might have been removed during check
      if (!this.#instances.includes(instance)) return;

      if (healthy) {
        instance.healthCheckFailures = 0;
        return;
      }

      instance.healthCheckFailures++;

      if (instance.healthCheckFailures >= config.maxFailures) {
        this.#stopHealthCheck(instance);
        this.#options.onWorkerUnhealthy?.(
          this.#functionName,
          instance.healthCheckFailures
        );

        // Remove this instance
        const idx = this.#instances.findIndex((i) => i.id === instance.id);
        if (idx !== -1) {
          instance.worker.terminate();
          this.#instances.splice(idx, 1);
        }

        // If below minWorkers, signal need for replacement spawn
        if (this.#instances.length < this.#minWorkers) {
          this.#options.onNeedSpawn?.(this.#functionName);
        }
      }
    }, config.interval);

    instance.healthCheckTimer = timer;
  }

  #stopHealthCheck(instance: WorkerInstance): void {
    if (instance.healthCheckTimer) {
      clearInterval(instance.healthCheckTimer);
      instance.healthCheckTimer = undefined;
    }
  }

  stopAllHealthChecks(): void {
    for (const instance of this.#instances) {
      this.#stopHealthCheck(instance);
    }
  }

  // --- Stats ---

  getStats(): PoolStats {
    const now = Date.now();
    const instances: InstanceStats[] = this.#instances.map((i) => ({
      id: i.id,
      activeRequests: i.activeRequests,
      totalRequests: i.totalRequests,
      uptimeMs: now - i.spawnTime,
    }));

    return {
      functionName: this.#functionName,
      instanceCount: this.#instances.length,
      totalRequests: this.#instances.reduce(
        (sum, i) => sum + i.totalRequests,
        0
      ),
      activeRequests: this.#instances.reduce(
        (sum, i) => sum + i.activeRequests,
        0
      ),
      restartCount: this.#restartCount,
      instances,
    };
  }

  // --- Dispose ---

  dispose(): void {
    for (const instance of this.#instances) {
      this.#clearIdleTimer(instance);
      this.#stopHealthCheck(instance);
      instance.worker.terminate();
    }
    this.#instances = [];
    this.#spawnResolvers = [];
  }

  // --- Restart (hot-reload) ---

  restart(): void {
    this.#restartCount++;
    this.dispose();
    this.#readyFired = false;
  }

  // --- Internal helpers ---

  #findInstance(id: string): WorkerInstance | undefined {
    return this.#instances.find((i) => i.id === id);
  }

  /** Get instances array (for WorkerPool to register exit handlers) */
  getInstances(): readonly WorkerInstance[] {
    return this.#instances;
  }

  /** Check if we have instances */
  hasInstances(): boolean {
    return this.#instances.length > 0;
  }
}

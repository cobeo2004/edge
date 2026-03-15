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
  websocketKeepsAlive?: boolean;
  backgroundTaskKeepsAlive?: boolean;
  backgroundTaskTimeout?: number;
  onFunctionCold?: (name: string) => void;
  onFunctionReady?: (name: string) => void;
  onWorkerUnhealthy?: (name: string, failures: number) => void;
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
  #generation = 0;
  #wsConnectionCounts: Map<string, number> = new Map();
  #websocketKeepsAlive: boolean;
  #bgTaskCounts: Map<string, number> = new Map();
  #bgTimeoutTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  #backgroundTaskKeepsAlive: boolean;
  #backgroundTaskTimeout?: number;

  constructor(options: WorkerLifecycleManagerOptions) {
    this.#functionName = options.functionName;
    this.#minWorkers = options.minWorkers;
    this.#maxWorkers = options.maxWorkers;
    this.#idleTimeout = options.idleTimeout;
    this.#healthCheckConfig = options.healthCheckConfig;
    this.#websocketKeepsAlive = options.websocketKeepsAlive ?? true;
    this.#backgroundTaskKeepsAlive = options.backgroundTaskKeepsAlive ?? true;
    this.#backgroundTaskTimeout = options.backgroundTaskTimeout;
    this.#options = options;
  }

  get functionName(): string {
    return this.#functionName;
  }

  get instanceCount(): number {
    return this.#instances.length;
  }

  get generation(): number {
    return this.#generation;
  }

  get minWorkers(): number {
    return this.#minWorkers;
  }

  get maxWorkers(): number {
    return this.#maxWorkers;
  }

  /**
   * Get the least-loaded instance, or signal that a new spawn is needed.
   *
   * When returning `{ kind: "spawn" }`, the spawn slot is atomically reserved
   * (i.e., `#spawningCount` is incremented). The caller MUST call
   * `releaseSpawnSlot()` when the spawn completes (success or failure).
   * The caller does NOT need to call `reserveSpawnSlot()` separately.
   */
  acquire(): AcquireResult {
    // If no instances exist and room to spawn
    if (this.#instances.length === 0) {
      if (this.#instances.length + this.#spawningCount < this.#maxWorkers) {
        this.#spawningCount++; // Atomic reserve — prevents concurrent overshoot
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
      this.#spawningCount++; // Atomic reserve — prevents concurrent overshoot
      return { kind: "spawn" };
    }

    // At capacity with in-flight spawn — wait
    if (this.#spawningCount > 0) {
      return { kind: "wait", promise: this.#waitForSpawn() };
    }

    // At capacity, no spawns in-flight — overload least-loaded
    return { kind: "instance", instance: leastLoaded };
  }

  /** @deprecated Spawn slot is now reserved atomically inside acquire(). */
  reserveSpawnSlot(): void {
    // No-op: acquire() now increments #spawningCount atomically.
    // Kept for backward compat but callers should not use this.
  }

  releaseSpawnSlot(): void {
    this.#spawningCount = Math.max(0, this.#spawningCount - 1);

    // Check for cold transition: 0 instances + 0 spawning = fully cold
    const shouldFireCold =
      this.#instances.length === 0 &&
      this.#spawningCount === 0 &&
      this.#readyFired;
    if (shouldFireCold) {
      this.#readyFired = false;
    }

    // Notify any waiters that a slot may be available
    for (const resolve of this.#spawnResolvers) {
      resolve();
    }
    this.#spawnResolvers = [];

    if (shouldFireCold) {
      this.#options.onFunctionCold?.(this.#functionName);
    }
  }

  nextId(): string {
    return `${this.#functionName}-${this.#idCounter++}`;
  }

  addInstance(instance: WorkerInstance, expectedGeneration?: number): boolean {
    if (
      expectedGeneration !== undefined &&
      expectedGeneration !== this.#generation
    ) {
      instance.worker.terminate();
      return false;
    }

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

    return true;
  }

  removeInstance(id: string): void {
    const idx = this.#instances.findIndex((i) => i.id === id);
    if (idx === -1) return;

    const instance = this.#instances[idx]!;
    this.#clearIdleTimer(instance);
    this.#stopHealthCheck(instance);
    this.#bgTaskCounts.delete(id);
    this.#clearBgTimeoutTimer(id);

    // Splice BEFORE terminate — terminate() fires exit listeners
    // synchronously, which could re-enter removeInstance().
    this.#instances.splice(idx, 1);

    const shouldFireCold =
      this.#instances.length === 0 && this.#spawningCount === 0;
    if (shouldFireCold) {
      this.#readyFired = false;
    }

    instance.worker.terminate();

    // Fire onFunctionCold when last instance removed, regardless of reason
    // (idle timeout, crash, health check failure, explicit termination).
    // This means "function has zero workers" — not just "idle scale-down".
    if (shouldFireCold) {
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
    this.#clearBgTimeoutTimer(id);
    instance.activeRequests++;
    instance.totalRequests++;
  }

  decrementActiveRequests(id: string): void {
    const instance = this.#findInstance(id);
    if (!instance) return;
    instance.activeRequests = Math.max(0, instance.activeRequests - 1);
    if (instance.activeRequests === 0) {
      if (this.getBackgroundTaskCount(id) > 0) {
        this.#startBgTimeoutTimer(id);
      }
      this.#startIdleTimer(instance);
    }
  }

  // --- Idle timeout ---

  #startIdleTimer(instance: WorkerInstance): void {
    if (this.#idleTimeout === undefined || this.#idleTimeout <= 0) return;
    // Don't start idle timer if WebSocket connections are keeping the worker alive
    if (this.#websocketKeepsAlive && this.getWebSocketCount(instance.id) > 0) {
      return;
    }
    // Don't start idle timer if background tasks are keeping the worker alive
    if (
      this.#backgroundTaskKeepsAlive &&
      this.getBackgroundTaskCount(instance.id) > 0
    ) {
      return;
    }
    this.#clearIdleTimer(instance);

    instance.idleTimer = setTimeout(() => {
      instance.idleTimer = undefined;

      // Only scale down if above minWorkers
      if (this.#instances.length <= this.#minWorkers) return;

      this.#stopHealthCheck(instance);
      const idx = this.#instances.findIndex((i) => i.id === instance.id);
      if (idx === -1) return;

      // Splice BEFORE terminate — terminate() fires exit listeners
      // synchronously, which would call removeInstance() and double-fire
      // the cold callback if the instance is still in the array.
      this.#instances.splice(idx, 1);

      const shouldFireCold =
        this.#instances.length === 0 && this.#spawningCount === 0;
      if (shouldFireCold) {
        this.#readyFired = false;
      }

      instance.worker.terminate();

      // Fire cold callback if last instance
      if (shouldFireCold) {
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

        // Remove this instance — clear timers, splice before terminate
        // to avoid re-entrant removeInstance() from synchronous exit listeners.
        this.#clearIdleTimer(instance);
        const idx = this.#instances.findIndex((i) => i.id === instance.id);
        if (idx !== -1) {
          this.#instances.splice(idx, 1);
          this.#restartCount++;

          const shouldFireCold =
            this.#instances.length === 0 && this.#spawningCount === 0;
          if (shouldFireCold) {
            this.#readyFired = false;
          }

          instance.worker.terminate();

          if (shouldFireCold) {
            this.#options.onFunctionCold?.(this.#functionName);
          }
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

  // --- WebSocket connection tracking ---

  incrementWebSocketCount(instanceId: string): void {
    const current = this.#wsConnectionCounts.get(instanceId) ?? 0;
    this.#wsConnectionCounts.set(instanceId, current + 1);

    if (this.#websocketKeepsAlive) {
      const instance = this.#findInstance(instanceId);
      if (instance) {
        this.#clearIdleTimer(instance);
      }
    }
  }

  decrementWebSocketCount(instanceId: string): void {
    const current = this.#wsConnectionCounts.get(instanceId) ?? 0;
    const next = Math.max(0, current - 1);
    this.#wsConnectionCounts.set(instanceId, next);

    if (this.#websocketKeepsAlive && next === 0) {
      const instance = this.#findInstance(instanceId);
      if (instance && instance.activeRequests === 0) {
        this.#startIdleTimer(instance);
      }
    }
  }

  getWebSocketCount(instanceId: string): number {
    return this.#wsConnectionCounts.get(instanceId) ?? 0;
  }

  // --- Background task tracking ---

  incrementBackgroundTasks(instanceId: string): void {
    const current = this.#bgTaskCounts.get(instanceId) ?? 0;
    this.#bgTaskCounts.set(instanceId, current + 1);

    if (this.#backgroundTaskKeepsAlive) {
      const instance = this.#findInstance(instanceId);
      if (instance) {
        this.#clearIdleTimer(instance);
      }
    }
  }

  decrementBackgroundTasks(instanceId: string): void {
    const current = this.#bgTaskCounts.get(instanceId) ?? 0;
    const next = Math.max(0, current - 1);
    this.#bgTaskCounts.set(instanceId, next);

    if (next === 0) {
      this.#clearBgTimeoutTimer(instanceId);

      if (this.#backgroundTaskKeepsAlive) {
        const instance = this.#findInstance(instanceId);
        if (
          instance &&
          instance.activeRequests === 0 &&
          !(this.#websocketKeepsAlive && this.getWebSocketCount(instanceId) > 0)
        ) {
          this.#startIdleTimer(instance);
        }
      }
    }
  }

  getBackgroundTaskCount(instanceId: string): number {
    return this.#bgTaskCounts.get(instanceId) ?? 0;
  }

  #startBgTimeoutTimer(instanceId: string): void {
    if (
      this.#backgroundTaskTimeout === undefined ||
      this.#backgroundTaskTimeout <= 0
    )
      return;
    this.#clearBgTimeoutTimer(instanceId);

    const timer = setTimeout(() => {
      this.#bgTimeoutTimers.delete(instanceId);
      if (this.getBackgroundTaskCount(instanceId) > 0) {
        console.warn(
          `[edge] "${this.#functionName}": background task timeout (${this.#backgroundTaskTimeout}ms) exceeded with ${this.getBackgroundTaskCount(instanceId)} pending task(s), terminating worker ${instanceId}`
        );
        this.removeInstance(instanceId);
      }
    }, this.#backgroundTaskTimeout);

    this.#bgTimeoutTimers.set(instanceId, timer);
  }

  #clearBgTimeoutTimer(instanceId: string): void {
    const timer = this.#bgTimeoutTimers.get(instanceId);
    if (timer) {
      clearTimeout(timer);
      this.#bgTimeoutTimers.delete(instanceId);
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
      backgroundTaskCount: this.getBackgroundTaskCount(i.id),
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
      totalBackgroundTasks: this.#instances.reduce(
        (sum, i) => sum + this.getBackgroundTaskCount(i.id),
        0
      ),
      restartCount: this.#restartCount,
      instances,
    };
  }

  // --- Dispose ---

  dispose(): void {
    this.#generation++;
    // Copy and clear before terminating — terminate() fires exit
    // listeners synchronously which could re-enter removeInstance().
    const instances = this.#instances;
    this.#instances = [];

    // Resolve pending waiters so callers don't hang indefinitely
    const resolvers = this.#spawnResolvers;
    this.#spawnResolvers = [];
    this.#spawningCount = 0;
    this.#wsConnectionCounts.clear();
    this.#bgTaskCounts.clear();
    for (const timer of this.#bgTimeoutTimers.values()) {
      clearTimeout(timer);
    }
    this.#bgTimeoutTimers.clear();
    for (const resolve of resolvers) {
      resolve();
    }

    for (const instance of instances) {
      this.#clearIdleTimer(instance);
      this.#stopHealthCheck(instance);
      instance.worker.terminate();
    }
  }

  async gracefulDispose(timeout?: number): Promise<void> {
    const effectiveTimeout = timeout ?? this.#backgroundTaskTimeout ?? 30_000;

    const drainPromises = this.#instances
      .filter((i) => this.getBackgroundTaskCount(i.id) > 0)
      .map((i) => this.#waitForBackgroundTasks(i.id, effectiveTimeout));

    if (drainPromises.length > 0) {
      await Promise.allSettled(drainPromises);
    }

    this.dispose();
  }

  #waitForBackgroundTasks(instanceId: string, timeout: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.getBackgroundTaskCount(instanceId) === 0) {
        resolve();
        return;
      }

      const timeoutId = setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, timeout);

      const checkInterval = setInterval(() => {
        if (this.getBackgroundTaskCount(instanceId) === 0) {
          clearTimeout(timeoutId);
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
    });
  }

  // --- Restart (hot-reload) ---

  restart(): void {
    this.#restartCount++;
    // generation is incremented inside dispose()
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

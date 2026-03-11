import type { DenoHTTPWorker } from "../../worker/index.js";

export interface WorkerInstance {
  /** Unique ID: "{functionName}-{counter}" */
  id: string;
  /** Function this instance belongs to */
  functionName: string;
  /** Underlying Deno worker process */
  worker: DenoHTTPWorker;
  /** Number of currently active (in-flight) requests */
  activeRequests: number;
  /** Lifetime total request count */
  totalRequests: number;
  /** Timestamp when this instance was spawned */
  spawnTime: number;
  /** Per-instance idle timer (scale-down) */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Per-instance health check interval */
  healthCheckTimer?: ReturnType<typeof setInterval>;
  /** Consecutive health check failures */
  healthCheckFailures: number;
  /** Whether a health check is currently in-flight */
  healthCheckInFlight: boolean;
}

export type AcquireResult =
  | { kind: "instance"; instance: WorkerInstance }
  | { kind: "spawn" }
  | { kind: "wait"; promise: Promise<void> };

export interface PoolStats {
  functionName: string;
  instanceCount: number;
  totalRequests: number;
  activeRequests: number;
  restartCount: number;
  instances: InstanceStats[];
}

export interface InstanceStats {
  id: string;
  activeRequests: number;
  totalRequests: number;
  uptimeMs: number;
}

export function createWorkerInstance(
  id: string,
  functionName: string,
  worker: DenoHTTPWorker
): WorkerInstance {
  return {
    id,
    functionName,
    worker,
    activeRequests: 0,
    totalRequests: 0,
    spawnTime: Date.now(),
    healthCheckFailures: 0,
    healthCheckInFlight: false,
  };
}

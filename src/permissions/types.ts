/**
 * Per-function configuration loaded from function.json.
 */
export interface FunctionConfig {
  /** Permission profile name or raw flags array */
  permissions?: string | string[];
  /** Whether this function requires auth (default: true when server auth is enabled) */
  auth?: boolean;
  /** Idle timeout in ms before worker goes cold. Overrides server-level idleTimeout */
  idleTimeout?: number;
  /** Minimum number of worker instances for this function */
  minWorkers?: number;
  /** Maximum number of worker instances for this function */
  maxWorkers?: number;
  /** Whether to eagerly spawn workers for this function at startup */
  eagerSpawn?: boolean;
  /** Max WebSocket connections per worker instance (default: 100) */
  maxWebSocketConnections?: number;
  /** Whether active WebSocket connections prevent idle timeout and workerMaxDuration from killing the worker (default: true) */
  websocketKeepsAlive?: boolean;
}

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
  /**
   * Whether active WebSocket connections should keep the worker from being treated as idle.
   * This does not prevent workerMaxDuration-based recycling; workers may still be terminated
   * when their maximum duration is reached (default: true).
   */
  websocketKeepsAlive?: boolean;
  /** Maximum time (ms) to wait for background tasks after response. Overrides server-level backgroundTaskTimeout */
  backgroundTaskTimeout?: number;
  /** Whether pending background tasks prevent idle timeout. Overrides server-level backgroundTaskKeepsAlive */
  backgroundTaskKeepsAlive?: boolean;
}

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
}

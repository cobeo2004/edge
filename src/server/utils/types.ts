import type {
  DenoWorkerOptions,
  LogLevel,
  RequestStats,
} from "../../worker/index.js";
import type { AuthResult, AuthStrategy } from "../../auth/types.js";
import type { ServerAdapter } from "../adapters/types.js";
import type { RuntimeName } from "../adapters/detect.js";

export interface RequestContext {
  request: Request;
  functionName: string;
  url: URL;
  authClaims?: Record<string, unknown>;
}

export type Middleware = (
  ctx: RequestContext,
  next: () => Promise<Response>
) => Promise<Response>;

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
  /** Watch shared folders and restart all workers on change. Only effective when hotReload is true. Default: true */
  watchSharedFolders?: boolean;
  /** Called when a function worker is ready */
  onFunctionReady?: (name: string) => void;
  /** Called when a function worker encounters an error */
  onFunctionError?: (name: string, error: Error) => void;
  /** Path to an import map file passed to each worker */
  importMapPath?: string;
  /** Path to a Deno config file (deno.json) passed to each worker */
  configPath?: string;
  /** Server adapter: 'node' | 'bun' | 'deno' or a custom ServerAdapter. Default: auto-detect */
  adapter?: RuntimeName | ServerAdapter;
  /** Log level for worker output. Defaults to "silent" */
  logLevel?: LogLevel;
  /** Custom log handler for worker output, receives the function name */
  onLog?: (
    functionName: string,
    level: LogLevel,
    source: "stdout" | "stderr" | "command",
    message: string
  ) => void;
  /** Environment variables applied to all workers */
  env?: Record<string, string>;
  /** Additional .env file paths loaded at start() */
  envFiles?: string[];
  /** Mask secret values in log output. Defaults to true */
  maskSecrets?: boolean;
  /** Maximum heap memory in MB for each worker's V8 isolate */
  memoryLimitMb?: number;
  /** Per-request timeout in ms. Returns 504 on timeout */
  requestTimeout?: number;
  /** Maximum wall-clock time in ms for each worker. Worker respawns on next request */
  workerMaxDuration?: number;
  /** Called after each request completes with timing and status info */
  onRequestStats?: (stats: RequestStats) => void;
  /** Interval in ms between health-check pings. Disabled when not set */
  healthCheckInterval?: number;
  /** Timeout in ms for each health-check ping. Defaults to 5000 */
  healthCheckTimeout?: number;
  /** Consecutive failures before auto-restart. Defaults to 3 */
  healthCheckMaxFailures?: number;
  /** Called when a worker is restarted due to failed health checks */
  onWorkerUnhealthy?: (name: string, consecutiveFailures: number) => void;
  /** Idle timeout in ms. Worker terminates when idle for this duration. Disabled by default */
  idleTimeout?: number;
  /** Called when a worker is terminated due to idle timeout */
  onFunctionCold?: (name: string) => void;
  /** Minimum worker instances per function. Default: 0 (can scale to cold) */
  minWorkers?: number;
  /** Maximum worker instances per function. Default: 1 (backward-compatible single worker) */
  maxWorkers?: number;
  /** Auth strategy instance. When set, all requests require authentication unless opted out */
  auth?: AuthStrategy;
  /** Custom response on auth failure. Default: 401 JSON */
  onAuthFailure?: (
    request: Request,
    error: AuthResult
  ) => Response | Promise<Response>;
  /** Functions that skip auth entirely (server-level override) */
  publicFunctions?: string[];
  /** Default permission profile for all functions. Default: "standard" */
  defaultPermissionProfile?: string;
  /** Per-function permission overrides. Takes priority over function.json */
  functionPermissions?: Record<string, string | string[]>;
  /** Custom named permission profiles (merged with built-ins) */
  permissionProfiles?: Record<string, string[]>;
  /** Max WebSocket connections per worker instance (default: 100) */
  maxWebSocketConnections?: number;
  /** Global cap on total WebSocket connections across all functions/workers. When not set, no global cap is enforced. */
  globalMaxWebSocketConnections?: number;
  /** Whether active WebSocket connections prevent idle timeout and workerMaxDuration from killing the worker (default: true) */
  websocketKeepsAlive?: boolean;
  /** Called when a WebSocket connection is established */
  onWebSocketConnect?: (functionName: string, connectionId: string) => void;
  /** Called when a WebSocket connection is closed */
  onWebSocketClose?: (
    functionName: string,
    connectionId: string,
    code: number,
    reason: string
  ) => void;
  /** Called when a WebSocket connection errors */
  onWebSocketError?: (
    functionName: string,
    connectionId: string,
    error: Error
  ) => void;
  /** Maximum time (ms) to wait for background tasks after last response. Default: 30000 */
  backgroundTaskTimeout?: number;
  /** Whether pending background tasks prevent idle timeout. Default: true */
  backgroundTaskKeepsAlive?: boolean;
}

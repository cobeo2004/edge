import type { SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export type OnExitListener = (exitCode: number, signal: string) => void;

export class EarlyExitDenoHTTPWorkerError extends Error {
  constructor(
    public message: string,
    public stderr: string,
    public stdout: string,
    public code: number,
    public signal: string
  ) {
    super(message);
  }
}

export interface MinimalChildProcess {
  stdout: Readable | null;
  stderr: Readable | null;
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  on(event: "disconnect", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  on(event: "spawn", listener: () => void): this;
}

export interface DenoWorkerOptions {
  /**
   * The path to the executable that should be use when spawning the subprocess.
   * Defaults to "deno".
   */
  denoExecutable: string | string[];

  /**
   * The path to the script that should be used to bootstrap the worker
   * environment in Deno. If specified, this script will be used instead of the
   * default bootstrap script. Only advanced users should set this.
   */
  denoBootstrapScriptPath: string;

  /**
   * Flags that are passed to the Deno process. These flags follow the `deno
   * run` command and can be used to enabled/disabled various permissions and
   * features. These flags will be modified to ensure that the deno process can
   * run the http server we'll be connecting to. Toggle the
   * printCommandAndArguments if you need to understand what the final flag
   * values are.
   *
   * Review Deno's available flags here:
   * https://docs.deno.com/runtime/manual/getting_started/command_line_interface
   */
  runFlags: string[];

  /**
   * Print stdout and stderr to the console with a "[deno]" prefix. This is
   * useful for debugging.
   */
  printOutput: boolean;

  /**
   * Print out the command and arguments that are executed.
   */
  printCommandAndArguments: boolean;

  /**
   * Options used to spawn the Deno child process
   */
  spawnOptions: SpawnOptions;

  /**
   * Callback that is called when the process is spawned.
   */
  onSpawn?: (process: MinimalChildProcess) => void;

  /**
   * Provide an alternative spawn functions. Defaults to child_process.spawn.
   */
  spawnFunc: (
    command: string,
    args: string[],
    options: SpawnOptions
  ) => MinimalChildProcess;

  /**
   * Controls the verbosity of worker output logging.
   * - "debug" — spawn command + stdout + stderr
   * - "info" — stdout + stderr
   * - "warn" — stderr only
   * - "error" — only early-exit/crash output
   * - "silent" — nothing (default)
   *
   * When not set, falls back to legacy booleans:
   * `printCommandAndArguments: true` → "debug", `printOutput: true` → "info"
   */
  logLevel?: LogLevel;

  /**
   * Custom log handler. Called for each log line emitted by the worker.
   * If not provided, logs are written to console.log (stdout) or
   * console.error (stderr) with a "[deno]" prefix.
   */
  onLog?: (
    level: LogLevel,
    source: "stdout" | "stderr" | "command",
    message: string
  ) => void;

  /**
   * Path to an import map file (JSON). This is passed to Deno as
   * `--import-map=<path>`. The file will automatically be added to
   * `--allow-read` permissions.
   */
  importMapPath?: string;

  /**
   * Path to a Deno configuration file (deno.json). This is passed to Deno as
   * `--config=<path>`. Unlike `importMapPath`, this supports the full
   * deno.json schema including `imports`, `nodeModulesDir`, `compilerOptions`,
   * etc. The file will automatically be added to `--allow-read` permissions.
   *
   * If both `configPath` and `importMapPath` are set, both flags will be
   * passed to Deno (Deno will merge them).
   */
  configPath?: string;

  /**
   * Environment variables to pass to the Deno worker process.
   * These are merged on top of `process.env` and any env set via
   * `spawnOptions.env`.
   */
  env?: Record<string, string>;

  /**
   * Maximum heap memory in MB for the Deno V8 isolate.
   * When exceeded, the process crashes and respawns on next request.
   */
  memoryLimitMb?: number;

  /**
   * Per-request timeout in ms. Aborts the request if exceeded.
   * The worker process is NOT killed.
   */
  requestTimeout?: number;

  /**
   * Maximum wall-clock time in ms that this worker may run.
   * After this, the worker is terminated and respawns on next request.
   */
  workerMaxDuration?: number;

  /**
   * Interval in ms between health-check pings. Health checks are disabled
   * when not set. Only used by EdgeFunctionServer.
   */
  healthCheckInterval?: number;

  /**
   * Timeout in ms for each health-check ping. Defaults to 5000.
   * Only used by EdgeFunctionServer.
   */
  healthCheckTimeout?: number;

  /**
   * Number of consecutive health-check failures before the worker is
   * considered unhealthy and restarted. Defaults to 3.
   * Only used by EdgeFunctionServer.
   */
  healthCheckMaxFailures?: number;
}

export interface RequestStats {
  functionName: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  statusCode: number;
  timedOut: boolean;
}

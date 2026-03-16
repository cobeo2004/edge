import path, { resolve } from "node:path";
import { spawn } from "node:child_process";
import { type Readable, PassThrough } from "node:stream";
import readline from "node:readline";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

import type { DenoWorkerOptions, LogLevel } from "./types.js";
import { EarlyExitDenoHTTPWorkerError } from "./types.js";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

function resolveLogLevel(options: DenoWorkerOptions): LogLevel {
  if (options.logLevel) return options.logLevel;
  if (options.printCommandAndArguments) return "debug";
  if (options.printOutput) return "info";
  return "silent";
}

function shouldLog(effective: LogLevel, messageLevel: LogLevel): boolean {
  return LOG_LEVEL_ORDER[messageLevel] >= LOG_LEVEL_ORDER[effective];
}
import { type DenoHTTPWorker, DenoHTTPWorkerImpl } from "./DenoHTTPWorker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DENO_BOOTSTRAP_SCRIPT_PATH = resolve(
  __dirname,
  "../../deno-bootstrap/index.ts"
);

/**
 * Create a new DenoHTTPWorker. This function will start a worker and being
 */
export const newDenoHTTPWorker = async (
  script: string | URL,
  options: Partial<DenoWorkerOptions> = {}
): Promise<DenoHTTPWorker> => {
  const _options: DenoWorkerOptions = {
    denoExecutable: "deno",
    denoBootstrapScriptPath: DEFAULT_DENO_BOOTSTRAP_SCRIPT_PATH,
    runFlags: [],
    printCommandAndArguments: false,
    spawnOptions: {},
    printOutput: false,
    spawnFunc: spawn,
    ...options,
  };

  let scriptArgs: string[];

  // Create the socket location that we'll use to communicate with Deno.
  const socketFile = path.join(
    os.tmpdir(),
    `${crypto.randomUUID()}-deno-http.sock`
  );

  // If we have a file import, make sure we allow read access to the file.
  let allowReadFlagValue =
    typeof script === "string"
      ? socketFile
      : `${socketFile},${fileURLToPath(script)}`;

  // Merge env layers: process.env → spawnOptions.env → options.env
  if (_options.env || _options.spawnOptions.env) {
    const mergedEnv = {
      ...process.env,
      ..._options.spawnOptions.env,
      ..._options.env,
    };
    _options.spawnOptions = {
      ..._options.spawnOptions,
      env: mergedEnv,
    };
  }

  if (_options.importMapPath) {
    allowReadFlagValue += `,${_options.importMapPath}`;
  }
  if (_options.configPath) {
    allowReadFlagValue += `,${_options.configPath}`;
  }

  let allowReadFound = false;
  let allowWriteFound = false;
  _options.runFlags = _options.runFlags.map((flag) => {
    if (flag === "--allow-read" || flag === "--allow-all") {
      allowReadFound = true;
    }
    if (flag === "--allow-write" || flag === "--allow-all") {
      allowWriteFound = true;
    }
    if (flag.startsWith("--allow-read=")) {
      allowReadFound = true;
      return (flag += `,${allowReadFlagValue}`);
    }
    if (flag.startsWith("--allow-write=")) {
      allowWriteFound = true;
      return (flag += `,${socketFile}`);
    }
    return flag;
  });
  if (!allowReadFound) {
    _options.runFlags.push(`--allow-read=${allowReadFlagValue}`);
  }
  if (!allowWriteFound) {
    _options.runFlags.push(`--allow-write=${socketFile}`);
  }

  // Inject V8 memory limit flag
  if (_options.memoryLimitMb != null) {
    if (
      !Number.isInteger(_options.memoryLimitMb) ||
      _options.memoryLimitMb <= 0
    ) {
      throw new Error("memoryLimitMb must be a positive integer");
    }
    const maxOldSpaceFlag = `--max-old-space-size=${_options.memoryLimitMb}`;
    const existingIdx = _options.runFlags.findIndex((f) =>
      f.startsWith("--v8-flags=")
    );
    if (existingIdx !== -1) {
      _options.runFlags[existingIdx] += `,${maxOldSpaceFlag}`;
    } else {
      _options.runFlags.push(`--v8-flags=${maxOldSpaceFlag}`);
    }
  }

  if (_options.importMapPath) {
    _options.runFlags.push(`--import-map=${_options.importMapPath}`);
  }
  if (_options.configPath) {
    _options.runFlags.push(`--config=${_options.configPath}`);
  }

  if (typeof script === "string") {
    scriptArgs = [socketFile, "script", script];
  } else {
    scriptArgs = [socketFile, "import", script.href];
  }
  if (
    Array.isArray(_options.denoExecutable) &&
    _options.denoExecutable.length === 0
  ) {
    throw new Error("denoExecutable must not be an empty array");
  }
  const command =
    typeof _options.denoExecutable === "string"
      ? _options.denoExecutable
      : (_options.denoExecutable[0] as string);

  const bootstrap = await fs.readFile(
    _options.denoBootstrapScriptPath,
    "utf-8"
  );

  return new Promise((resolve, reject) => {
    (async (): Promise<DenoHTTPWorker> => {
      const args = [
        ...(typeof _options.denoExecutable === "string"
          ? []
          : _options.denoExecutable.slice(1)),
        "run",
        ..._options.runFlags,
        `data:text/typescript,${encodeURIComponent(bootstrap)}`,
        ...scriptArgs,
      ];
      const effectiveLogLevel = resolveLogLevel(_options);
      const logHandler =
        _options.onLog ??
        ((
          _level: LogLevel,
          source: "stdout" | "stderr" | "command",
          message: string
        ) => {
          if (source === "stderr") {
            console.error("[deno]", message);
          } else {
            console.log("[deno]", message);
          }
        });

      if (shouldLog(effectiveLogLevel, "debug")) {
        logHandler(
          "debug",
          "command",
          `Spawning deno process: ${JSON.stringify([command, ...args])}`
        );
      }

      const process = _options.spawnFunc(command, args, _options.spawnOptions);
      let running = false;
      let exited = false;
      let worker: DenoHTTPWorker | undefined;
      process.on("exit", (code: number, signal: string) => {
        exited = true;
        if (!running) {
          const stderr = process.stderr?.read()?.toString();
          const stdout = process.stdout?.read()?.toString();
          reject(
            new EarlyExitDenoHTTPWorkerError(
              "Deno exited before being ready",
              stderr,
              stdout,
              code,
              signal
            )
          );
          fs.rm(socketFile).catch(() => {});
        } else {
          (worker as DenoHTTPWorkerImpl)._terminate(code, signal);
        }
      });
      options.onSpawn && options.onSpawn(process);
      const stdout = <Readable>process.stdout;
      const stderr = <Readable>process.stderr;

      if (shouldLog(effectiveLogLevel, "info")) {
        readline.createInterface({ input: stdout }).on("line", (line) => {
          logHandler("info", "stdout", line);
        });
      }
      // Always parse stderr for background task control messages (\x00BG:).
      // We consume the raw stderr stream and forward non-BG data to a proxy
      // stream so worker.stderr.read() still works for consumers.
      let bgWorkerRef: DenoHTTPWorkerImpl | undefined;
      const bgEarlyQueue: Array<{ event: string }> = [];
      const stderrProxy = new PassThrough();
      let bgLineBuffer = "";

      stderr.on("data", (chunk: Buffer) => {
        bgLineBuffer += chunk.toString();
        let newlineIdx: number;
        const passthroughLines: string[] = [];

        while ((newlineIdx = bgLineBuffer.indexOf("\n")) !== -1) {
          const line = bgLineBuffer.slice(0, newlineIdx);
          bgLineBuffer = bgLineBuffer.slice(newlineIdx + 1);

          if (line.startsWith("\x00BG:")) {
            try {
              const payload = JSON.parse(line.slice(4));
              if (
                payload.event === "started" ||
                payload.event === "complete"
              ) {
                if (bgWorkerRef) {
                  if (payload.event === "started") {
                    bgWorkerRef.incrementBackgroundTasks();
                    _options.onBackgroundTaskStarted?.();
                  } else {
                    bgWorkerRef.decrementBackgroundTasks();
                    _options.onBackgroundTaskComplete?.();
                  }
                } else {
                  bgEarlyQueue.push(payload);
                }
              }
            } catch {
              // Ignore malformed BG messages
            }
          } else {
            passthroughLines.push(line);
            if (shouldLog(effectiveLogLevel, "warn")) {
              logHandler("warn", "stderr", line);
            }
          }
        }

        if (passthroughLines.length > 0) {
          stderrProxy.write(passthroughLines.join("\n") + "\n");
        }
      });
      stderr.on("end", () => stderrProxy.end());

      // Wait for the socket file to be created by the Deno process.
      for (;;) {
        if (exited) {
          break;
        }
        try {
          await fs.stat(socketFile);
          // File exists
          break;
        } catch (_err) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      worker = new DenoHTTPWorkerImpl({
        socketFile,
        process,
        stdout,
        stderr: stderrProxy,
        requestTimeout: _options.requestTimeout,
        workerMaxDuration: _options.workerMaxDuration,
      });
      bgWorkerRef = worker as DenoHTTPWorkerImpl;
      // Flush any BG messages that arrived before worker was constructed
      for (const msg of bgEarlyQueue) {
        if (msg.event === "started") {
          bgWorkerRef.incrementBackgroundTasks();
          _options.onBackgroundTaskStarted?.();
        } else if (msg.event === "complete") {
          bgWorkerRef.decrementBackgroundTasks();
          _options.onBackgroundTaskComplete?.();
        }
      }
      bgEarlyQueue.length = 0;
      running = true;
      await (worker as DenoHTTPWorkerImpl).warmRequest();

      return worker;
    })()
      .then(resolve)
      .catch(reject);
  });
};

import fsp from "node:fs/promises";
import path from "node:path";
import type { FunctionConfig } from "./types.js";

/**
 * Load function.json from a function directory.
 * Returns an empty object if the file doesn't exist or is invalid.
 */
export async function loadFunctionConfig(
  functionDir: string,
  onError?: (error: Error) => void
): Promise<FunctionConfig> {
  const configPath = path.join(functionDir, "function.json");
  try {
    const content = await fsp.readFile(configPath, "utf-8");
    const parsed = JSON.parse(content);
    const config: FunctionConfig = {};

    if (
      typeof parsed.permissions === "string" ||
      Array.isArray(parsed.permissions)
    ) {
      config.permissions = parsed.permissions;
    }

    if (typeof parsed.auth === "boolean") {
      config.auth = parsed.auth;
    }

    if (typeof parsed.idleTimeout === "number" && parsed.idleTimeout > 0) {
      config.idleTimeout = parsed.idleTimeout;
    }

    if (typeof parsed.minWorkers === "number" && parsed.minWorkers >= 0) {
      config.minWorkers = parsed.minWorkers;
    }

    if (typeof parsed.maxWorkers === "number" && parsed.maxWorkers >= 1) {
      config.maxWorkers = parsed.maxWorkers;
    }

    // Cross-validate: minWorkers <= maxWorkers
    if (
      config.minWorkers !== undefined &&
      config.maxWorkers !== undefined &&
      config.minWorkers > config.maxWorkers
    ) {
      onError?.(
        new Error(
          `function.json: minWorkers (${config.minWorkers}) > maxWorkers (${config.maxWorkers}), ignoring both`
        )
      );
      delete config.minWorkers;
      delete config.maxWorkers;
    }

    if (typeof parsed.eagerSpawn === "boolean") {
      config.eagerSpawn = parsed.eagerSpawn;
    }

    if (
      typeof parsed.maxWebSocketConnections === "number" &&
      Number.isInteger(parsed.maxWebSocketConnections) &&
      parsed.maxWebSocketConnections >= 1
    ) {
      config.maxWebSocketConnections = parsed.maxWebSocketConnections;
    }

    if (typeof parsed.websocketKeepsAlive === "boolean") {
      config.websocketKeepsAlive = parsed.websocketKeepsAlive;
    }

    if (
      typeof parsed.backgroundTaskTimeout === "number" &&
      parsed.backgroundTaskTimeout > 0
    ) {
      config.backgroundTaskTimeout = parsed.backgroundTaskTimeout;
    }

    if (typeof parsed.backgroundTaskKeepsAlive === "boolean") {
      config.backgroundTaskKeepsAlive = parsed.backgroundTaskKeepsAlive;
    }

    return config;
  } catch (err) {
    // Only call onError for parse errors, not missing files
    if (err instanceof SyntaxError) {
      onError?.(err);
    }
    return {};
  }
}

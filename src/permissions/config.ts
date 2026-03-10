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

    return config;
  } catch (err) {
    // Only call onError for parse errors, not missing files
    if (err instanceof SyntaxError) {
      onError?.(err);
    }
    return {};
  }
}

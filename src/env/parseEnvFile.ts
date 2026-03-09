import fs from "node:fs/promises";

/**
 * Parse a `.env` file content string into a key-value record.
 * Supports `#` comments, blank lines, double-quoted and single-quoted values.
 * No variable expansion.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    // Skip blank lines and comments
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    if (!key) continue;

    let value = line.slice(eqIndex + 1).trim();

    // Handle quoted values
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip inline comments for unquoted values
      const commentIndex = value.indexOf(" #");
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex).trim();
      }
    }

    result[key] = value;
  }

  return result;
}

/**
 * Load and parse a `.env` file. Returns `{}` if the file does not exist.
 */
export async function loadEnvFile(
  filePath: string
): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return parseEnvFile(content);
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

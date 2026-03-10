import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFunctionConfig } from "../permissions/config.js";
import { BUILT_IN_PROFILES } from "../permissions/profiles.js";
import type { FunctionConfig } from "../permissions/types.js";

export const ENTRYPOINT_NAMES = [
  "index.ts",
  "index.tsx",
  "index.js",
  "index.mjs",
];

export const SHARED_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".json",
]);

export interface FunctionRegistryOptions {
  functionsDir: string;
  permissionProfiles?: Record<string, string[]>;
  onFunctionError?: (name: string, error: Error) => void;
}

export class FunctionRegistry {
  #functions = new Map<string, string>();
  #functionConfigs = new Map<string, FunctionConfig>();
  #sharedFolderPaths: string[] = [];
  #importMapFile: string | undefined;
  #options: FunctionRegistryOptions;

  constructor(options: FunctionRegistryOptions) {
    this.#options = options;
  }

  async scan(): Promise<void> {
    this.#functions.clear();
    this.#functionConfigs.clear();
    this.#sharedFolderPaths = [];
    let entries: string[];
    try {
      entries = await fsp.readdir(this.#options.functionsDir);
    } catch {
      return;
    }

    // Build lookup of all known profile names for validation
    const allProfiles: Record<string, string[]> = {
      ...BUILT_IN_PROFILES,
      ...this.#options.permissionProfiles,
    };

    for (const entry of entries) {
      const dirPath = path.join(this.#options.functionsDir, entry);
      const stat = await fsp.stat(dirPath);
      if (!stat.isDirectory()) continue;

      // Collect underscore-prefixed dirs as shared folders, skip function discovery
      if (entry.startsWith("_")) {
        this.#sharedFolderPaths.push(dirPath);
        continue;
      }

      for (const name of ENTRYPOINT_NAMES) {
        const candidate = path.join(dirPath, name);
        try {
          await fsp.stat(candidate);
          this.#functions.set(entry, candidate);
          const fnConfig = await loadFunctionConfig(dirPath, (err) => {
            this.#options.onFunctionError?.(
              entry,
              new Error(`Invalid function.json: ${err.message}`)
            );
          });
          this.#functionConfigs.set(entry, fnConfig);

          // Validate permission profile name at scan time
          if (typeof fnConfig.permissions === "string") {
            if (!allProfiles[fnConfig.permissions]) {
              this.#options.onFunctionError?.(
                entry,
                new Error(
                  `Unknown permission profile "${fnConfig.permissions}" in function.json`
                )
              );
            }
          }

          break;
        } catch {
          // try next
        }
      }
    }
  }

  async #scanSharedFiles(): Promise<Map<string, string>> {
    const entries = new Map<string, string>();

    const scan = async (dir: string, prefix: string): Promise<void> => {
      let items: string[];
      try {
        items = await fsp.readdir(dir);
      } catch {
        return;
      }
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = await fsp.stat(fullPath);
        if (stat.isDirectory()) {
          await scan(fullPath, `${prefix}${item}/`);
        } else if (SHARED_FILE_EXTENSIONS.has(path.extname(item))) {
          const key = `${prefix}${item}`;
          const fileUrl = `file://${fullPath}`;
          entries.set(key, fileUrl);
        }
      }
    };

    for (const folderPath of this.#sharedFolderPaths) {
      const folderName = path.basename(folderPath);
      await scan(folderPath, `${folderName}/`);
    }

    return entries;
  }

  async generateImportMap(
    importMapPath?: string,
    configPath?: string
  ): Promise<string | undefined> {
    // Clean up previous temp file (from hot-reload regeneration)
    if (this.#importMapFile) {
      await fsp.rm(this.#importMapFile, { force: true });
      this.#importMapFile = undefined;
    }

    const sharedEntries = await this.#scanSharedFiles();
    if (sharedEntries.size === 0 && !importMapPath && !configPath) return;

    // Start with auto-generated entries
    const imports: Record<string, string> = {};
    for (const [key, value] of sharedEntries) {
      imports[key] = value;
    }

    // Merge user import map (user takes precedence, errors propagate — fail fast)
    let scopes: Record<string, Record<string, string>> | undefined;
    if (importMapPath) {
      const content = await fsp.readFile(importMapPath, "utf-8");
      const parsed = JSON.parse(content);
      const baseDir = path.dirname(path.resolve(importMapPath));
      if (parsed.imports) {
        for (const [key, value] of Object.entries(parsed.imports)) {
          if (
            typeof value === "string" &&
            (value.startsWith("./") || value.startsWith("../"))
          ) {
            imports[key] = `file://${path.resolve(baseDir, value)}`;
          } else {
            imports[key] = value as string;
          }
        }
      }
      if (parsed.scopes) {
        scopes = parsed.scopes;
      }
    }

    // Merge config imports if present (errors caught — configPath may not contain imports)
    if (configPath) {
      try {
        const content = await fsp.readFile(configPath, "utf-8");
        const parsed = JSON.parse(content);
        const baseDir = path.dirname(path.resolve(configPath));
        if (parsed.imports) {
          for (const [key, value] of Object.entries(parsed.imports)) {
            if (
              typeof value === "string" &&
              (value.startsWith("./") || value.startsWith("../"))
            ) {
              imports[key] = `file://${path.resolve(baseDir, value)}`;
            } else {
              imports[key] = value as string;
            }
          }
        }
        if (parsed.scopes && !scopes) {
          scopes = parsed.scopes;
        }
      } catch {
        // configPath may not contain import map fields — skip gracefully
      }
    }

    const importMap: Record<string, unknown> = { imports };
    if (scopes) {
      importMap.scopes = scopes;
    }

    // Write to temp file
    const tmpFile = path.join(
      os.tmpdir(),
      `deno-edge-import-map-${crypto.randomUUID()}.json`
    );
    await fsp.writeFile(tmpFile, JSON.stringify(importMap, null, 2));
    this.#importMapFile = tmpFile;
    return tmpFile;
  }

  async cleanupImportMap(): Promise<void> {
    if (this.#importMapFile) {
      await fsp.rm(this.#importMapFile, { force: true });
      this.#importMapFile = undefined;
    }
  }

  hasFunction(name: string): boolean {
    return this.#functions.has(name);
  }

  getEntrypoint(name: string): string | undefined {
    return this.#functions.get(name);
  }

  getFunctionConfig(name: string): FunctionConfig | undefined {
    return this.#functionConfigs.get(name);
  }

  listFunctions(): string[] {
    return [...this.#functions.keys()].sort();
  }

  getSharedFolderPaths(): string[] {
    return this.#sharedFolderPaths;
  }

  getImportMapFile(): string | undefined {
    return this.#importMapFile;
  }
}

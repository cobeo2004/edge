# Shared Folders Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add support for underscore-prefixed shared folders (`_shared/`, `_helpers/`, etc.) that are excluded from function discovery, grant read permissions to workers, auto-generate import maps, and support hot-reload.

**Architecture:** `EdgeFunctionServer` gains shared folder awareness — scanning, import map generation, and watcher changes all live in this file. Workers receive shared folder read permissions via `runFlags` and the generated import map path. No changes to the worker layer types.

**Tech Stack:** Node.js `fs/fsp`, `os.tmpdir()`, `path`, Deno import maps, Vitest

---

## File Structure

| File                                      | Role                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/server/EdgeFunctionServer.ts`        | All shared folder logic: scanning, import map generation, watcher changes, option, cleanup |
| `src/test/functions/_shared/cors.ts`      | Test fixture: shared module                                                                |
| `src/test/functions/_shared/db/client.ts` | Test fixture: nested shared module                                                         |
| `src/test/functions/shared-test/index.ts` | Test fixture: function that imports from `_shared/` via bare specifier                     |
| `src/test/server/shared-folders.test.ts`  | Tests for all shared folder behavior                                                       |
| `src/test/helpers/fixtures.ts`            | No changes needed — `FUNCTIONS_DIR` already covers `_shared/` as a subdirectory            |

---

## Chunk 1: Function Discovery + Read Permissions

### Task 1: Test fixtures for shared folders

**Files:**

- Create: `src/test/functions/_shared/cors.ts`
- Create: `src/test/functions/_shared/db/client.ts`
- Create: `src/test/functions/shared-test/index.ts`

- [ ] **Step 1: Create the shared module fixture `_shared/cors.ts`**

```typescript
// src/test/functions/_shared/cors.ts
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function withCors(body: string, status = 200): Response {
  return new Response(body, { status, headers: corsHeaders });
}
```

- [ ] **Step 2: Create the nested shared module fixture `_shared/db/client.ts`**

```typescript
// src/test/functions/_shared/db/client.ts
export function getConnectionString(): string {
  return "postgres://localhost:5432/test";
}
```

- [ ] **Step 3: Create the test function that imports from `_shared/`**

This function uses the bare specifier import (via auto-generated import map):

```typescript
// src/test/functions/shared-test/index.ts
import { withCors } from "_shared/cors.ts";
import { getConnectionString } from "_shared/db/client.ts";

Deno.serve((req) => {
  const url = new URL(req.url);
  if (url.pathname === "/db") {
    return withCors(getConnectionString());
  }
  return withCors("shared works");
});
```

- [ ] **Step 4: Commit**

```bash
git add src/test/functions/_shared/ src/test/functions/shared-test/
git commit -m "test: add shared folder test fixtures"
```

---

### Task 2: Skip underscore-prefixed dirs in function discovery

**Files:**

- Modify: `src/server/EdgeFunctionServer.ts` — `#scanFunctions()` method (lines 222-246)
- Test: `src/test/server/shared-folders.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/test/server/shared-folders.test.ts`:

```typescript
import { afterEach, describe, expect, it } from "vitest";
import { EdgeFunctionServer } from "../../server/EdgeFunctionServer.js";
import { FUNCTIONS_DIR } from "../helpers/fixtures.js";

describe("EdgeFunctionServer – shared folders", { timeout: 15_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("excludes underscore-prefixed folders from function discovery", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();
    const fns = server.listFunctions();
    expect(fns).not.toContain("_shared");
    // But normal functions should still be discovered
    expect(fns).toContain("hello");
    expect(fns).toContain("echo");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/server/shared-folders.test.ts -t "excludes underscore-prefixed"`
Expected: FAIL — `_shared` will appear in the function list (it has no index.ts, so it actually won't be listed — but the test structure is correct. We'll verify the scan skips it before even checking for entrypoints.)

Note: Since `_shared/` has no `index.ts`, the existing code won't list it anyway. But we still need the filter to avoid the stat calls on underscore dirs and to collect them for import map generation. The real validation comes in Task 3 (import map) and the routing test (ensuring `/shared-test` works with the import map).

- [ ] **Step 3: Add underscore-prefix skip + shared folder collection to `#scanFunctions()`**

In `src/server/EdgeFunctionServer.ts`, add a private field and modify `#scanFunctions()`:

Add field after line 106 (`#healthCheckInFlight`):

```typescript
  #sharedFolderPaths: string[] = [];
```

Modify `#scanFunctions()` (lines 222-246) to skip underscore-prefixed dirs and collect them:

```typescript
  async #scanFunctions(): Promise<void> {
    this.#functions.clear();
    this.#sharedFolderPaths = [];
    let entries: string[];
    try {
      entries = await fsp.readdir(this.#options.functionsDir);
    } catch {
      return;
    }
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
          break;
        } catch {
          // try next
        }
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/test/server/shared-folders.test.ts -t "excludes underscore-prefixed"`
Expected: PASS

- [ ] **Step 5: Update the existing routing "discovers functions" test**

The existing test in `src/test/server/routing.test.ts` (line 23) lists expected functions. Since we added `shared-test/`, update the expected list:

```typescript
expect(fns).toEqual([
  "echo",
  "env-test",
  "hello",
  "import-map-test",
  "npm-import",
  "oom",
  "shared-test",
  "slow",
  "unresponsive",
  "wasm-test",
]);
```

- [ ] **Step 6: Run full server test suite to verify nothing broke**

Run: `npx vitest run src/test/server/`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/server/EdgeFunctionServer.ts src/test/server/shared-folders.test.ts src/test/server/routing.test.ts
git commit -m "feat: exclude underscore-prefixed dirs from function discovery"
```

---

## Chunk 2: Import Map Auto-Generation

### Task 3: Generate and merge import maps

**Files:**

- Modify: `src/server/EdgeFunctionServer.ts` — add `#generateImportMap()`, modify `start()` and `stop()` and `#spawnWorker()`
- Test: `src/test/server/shared-folders.test.ts`

- [ ] **Step 1: Write the failing test — function imports from `_shared/` via bare specifier**

Add to `src/test/server/shared-folders.test.ts`:

```typescript
import { httpRequest } from "../helpers/http.js";

it("functions can import from _shared/ via bare specifier", async () => {
  server = new EdgeFunctionServer({
    functionsDir: FUNCTIONS_DIR,
    port: 0,
  });
  await server.start();
  const res = await httpRequest(server.port, "/shared-test");
  expect(res.status).toBe(200);
  expect(res.body).toBe("shared works");
});

it("functions can import nested shared modules via bare specifier", async () => {
  server = new EdgeFunctionServer({
    functionsDir: FUNCTIONS_DIR,
    port: 0,
  });
  await server.start();
  const res = await httpRequest(server.port, "/shared-test/db");
  expect(res.status).toBe(200);
  expect(res.body).toBe("postgres://localhost:5432/test");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/server/shared-folders.test.ts -t "bare specifier"`
Expected: FAIL — worker can't resolve `_shared/cors.ts` without import map

- [ ] **Step 3: Add `os` import at top of `EdgeFunctionServer.ts`**

Add `os` to the imports at the top of the file (line 1 area):

```typescript
import os from "node:os";
```

- [ ] **Step 4: Add `#importMapFile` field and shared file extensions constant**

After the `ENTRYPOINT_NAMES` constant (line 25):

```typescript
const SHARED_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".json",
]);
```

Add field after `#sharedFolderPaths`:

```typescript
  #importMapFile: string | undefined;
```

- [ ] **Step 5: Implement `#scanSharedFiles()` — recursively collect files from shared folders**

Add this private method to `EdgeFunctionServer`:

```typescript
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
```

- [ ] **Step 6: Implement `#generateImportMap()` — generate, merge with user map, write to temp file**

```typescript
  async #generateImportMap(): Promise<void> {
    // Clean up previous temp file (from hot-reload regeneration)
    if (this.#importMapFile) {
      await fsp.rm(this.#importMapFile, { force: true });
      this.#importMapFile = undefined;
    }

    const sharedEntries = await this.#scanSharedFiles();
    if (sharedEntries.size === 0 && !this.#options.importMapPath) return;

    // Start with auto-generated entries
    const imports: Record<string, string> = {};
    for (const [key, value] of sharedEntries) {
      imports[key] = value;
    }

    // Merge user import map (user takes precedence)
    let scopes: Record<string, Record<string, string>> | undefined;
    if (this.#options.importMapPath) {
      const userMapContent = await fsp.readFile(
        this.#options.importMapPath,
        "utf-8"
      );
      const userMap = JSON.parse(userMapContent);
      if (userMap.imports) {
        Object.assign(imports, userMap.imports);
      }
      if (userMap.scopes) {
        scopes = userMap.scopes;
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
  }
```

- [ ] **Step 7: Call `#generateImportMap()` in `start()` after `#scanFunctions()`**

Modify `start()` (after line 113 `await this.#scanFunctions();`):

```typescript
await this.#scanFunctions();
await this.#generateImportMap();
```

- [ ] **Step 8: Clean up temp import map in `stop()`**

Add to `stop()` method, before the server close (around line 164):

```typescript
// Clean up generated import map
if (this.#importMapFile) {
  await fsp.rm(this.#importMapFile, { force: true });
  this.#importMapFile = undefined;
}
```

- [ ] **Step 9: Modify `#spawnWorker()` to use generated import map and add shared folder read permissions**

In `#spawnWorker()` (around line 569), modify `runFlags` and `importMapPath`.

Replace line 571 (`const runFlags = userOptions.runFlags ?? defaultRunFlags;`) with spread copy + shared folder read permissions. Note: `factory.ts` (line 102-104) appends socket/script paths to any existing `--allow-read=` flag, so adding shared folder paths here works correctly:

```typescript
const defaultRunFlags = ["--allow-net", "--allow-env"];
const runFlags = [...(userOptions.runFlags ?? defaultRunFlags)];

// Append shared folder read permissions
if (this.#sharedFolderPaths.length > 0) {
  const sharedPaths = this.#sharedFolderPaths.join(",");
  const existingIdx = runFlags.findIndex((f) => f.startsWith("--allow-read="));
  if (existingIdx !== -1) {
    runFlags[existingIdx] += `,${sharedPaths}`;
  } else {
    runFlags.push(`--allow-read=${sharedPaths}`);
  }
}
```

Then replace the existing `importMapPath` line (line 625) in the `newDenoHTTPWorker()` call. When `#importMapFile` exists, it already contains merged user import map entries:

```typescript
return newDenoHTTPWorker(new URL(`file://${entrypoint}`), {
  ...userOptions,
  denoBootstrapScriptPath:
    userOptions.denoBootstrapScriptPath ?? SERVE_BOOTSTRAP_PATH,
  runFlags,
  importMapPath:
    this.#importMapFile ??
    this.#options.importMapPath ??
    userOptions.importMapPath,
  configPath: this.#options.configPath ?? userOptions.configPath,
  // ... rest unchanged
});
```

Note: When `#importMapFile` exists, it already contains the merged user import map entries, so we use it instead of the raw `importMapPath`.

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run src/test/server/shared-folders.test.ts -t "bare specifier"`
Expected: PASS

- [ ] **Step 11: Write test for import map merge with user import map**

Add to `src/test/server/shared-folders.test.ts`:

```typescript
import { IMPORT_MAP } from "../helpers/fixtures.js";

it("merges user import map with auto-generated shared entries", async () => {
  server = new EdgeFunctionServer({
    functionsDir: FUNCTIONS_DIR,
    port: 0,
    importMapPath: IMPORT_MAP,
    workerOptions: {
      runFlags: ["--allow-net", "--allow-env", "--allow-read"],
    },
  });
  await server.start();

  // User import map function still works
  const res1 = await httpRequest(server.port, "/import-map-test");
  expect(res1.status).toBe(200);
  expect(res1.body).toBe("hello from edge");

  // Shared folder function also works
  const res2 = await httpRequest(server.port, "/shared-test");
  expect(res2.status).toBe(200);
  expect(res2.body).toBe("shared works");
});
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run src/test/server/shared-folders.test.ts -t "merges user import map"`
Expected: PASS

- [ ] **Step 13: Run full test suite**

Run: `npx vitest run src/test/server/`
Expected: All tests PASS (including existing import map tests in config.test.ts)

- [ ] **Step 14: Commit**

```bash
git add src/server/EdgeFunctionServer.ts src/test/server/shared-folders.test.ts
git commit -m "feat: auto-generate import maps for shared folders"
```

---

## Chunk 3: Hot-Reload + watchSharedFolders Option

### Task 4: Add `watchSharedFolders` option and watcher changes

**Files:**

- Modify: `src/server/EdgeFunctionServer.ts` — `EdgeFunctionServerOptions`, `#startWatcher()`
- Test: `src/test/server/shared-folders.test.ts`

- [ ] **Step 1: Add `watchSharedFolders` to `EdgeFunctionServerOptions`**

Add after the `hotReload` option (around line 47):

```typescript
  /** Watch shared folders and restart all workers on change. Only effective when hotReload is true. Default: true */
  watchSharedFolders?: boolean;
```

- [ ] **Step 2: Modify `#startWatcher()` to handle shared folder changes**

Replace `#startWatcher()` (lines 638-663):

```typescript
  #startWatcher(): void {
    const watchShared = this.#options.watchSharedFolders !== false;

    this.#watcher = fs.watch(
      this.#options.functionsDir,
      { recursive: true },
      (_event, filename) => {
        if (!filename) return;
        // filename is relative to functionsDir, e.g. "hello/index.ts" or "_shared/cors.ts"
        const topDir = filename.split(path.sep)[0]!;
        const isSharedChange = topDir.startsWith("_");

        // Skip shared folder changes if watchSharedFolders is disabled
        if (isSharedChange && !watchShared) return;

        // Debounce key: use the top-level dir for function changes,
        // use "__shared__" for all shared changes (so they coalesce)
        const debounceKey = isSharedChange ? "__shared__" : topDir;

        const existing = this.#debounceTimers.get(debounceKey);
        if (existing) clearTimeout(existing);

        this.#debounceTimers.set(
          debounceKey,
          setTimeout(async () => {
            this.#debounceTimers.delete(debounceKey);
            // Re-scan to detect new/removed functions and shared folders
            await this.#scanFunctions();

            if (isSharedChange) {
              // Regenerate import map and restart all workers
              await this.#generateImportMap();
              const workerNames = [...this.#workers.keys()];
              await Promise.all(
                workerNames.map((name) => this.restartFunction(name))
              );
            } else if (this.#workers.has(topDir)) {
              await this.restartFunction(topDir);
            }
          }, 200)
        );
      }
    );
  }
```

- [ ] **Step 3: Write the hot-reload test**

Add to `src/test/server/shared-folders.test.ts`:

```typescript
  import fsp from "node:fs/promises";
  import path from "node:path";

  it("restarts all workers when shared file changes", async () => {
    const restarts: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      hotReload: true,
      watchSharedFolders: true,
      onFunctionReady: (name) => restarts.push(name),
    });
    await server.start();

    // Trigger a request so the worker is running
    const res1 = await httpRequest(server.port, "/shared-test");
    expect(res1.status).toBe(200);
    restarts.length = 0; // Clear initial ready events

    // Touch a shared file to trigger hot-reload
    const sharedFile = path.join(FUNCTIONS_DIR, "_shared", "cors.ts");
    const original = await fsp.readFile(sharedFile, "utf-8");
    try {
      await·fsp.writeFile(sharedFile,·`${original}\n//·touch`);

      // Wait for debounce + restart
      await new Promise((r) => setTimeout(r, 1000));

      // Worker should have been restarted
      expect(restarts).toContain("shared-test");
    } finally {
      // Always restore file even if test fails
      await fsp.writeFile(sharedFile, original);
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/test/server/shared-folders.test.ts -t "restarts all workers"`
Expected: PASS

- [ ] **Step 5: Write test that watchSharedFolders=false skips shared folder watching**

```typescript
  it("does not restart workers on shared change when watchSharedFolders is false", async () => {
    const restarts: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      hotReload: true,
      watchSharedFolders: false,
      onFunctionReady: (name) => restarts.push(name),
    });
    await server.start();

    // Trigger a request so the worker is running
    const res1 = await httpRequest(server.port, "/shared-test");
    expect(res1.status).toBe(200);
    restarts.length = 0;

    // Touch a shared file
    const sharedFile = path.join(FUNCTIONS_DIR, "_shared", "cors.ts");
    const original = await fsp.readFile(sharedFile, "utf-8");
    try {
      await·fsp.writeFile(sharedFile,·`${original}\n//·touch`);

      // Wait for debounce window to pass
      await new Promise((r) => setTimeout(r, 500));

      // No restart should have happened
      expect(restarts).toHaveLength(0);
    } finally {
      // Always restore file even if test fails
      await fsp.writeFile(sharedFile, original);
    }
  });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/test/server/shared-folders.test.ts -t "does not restart"`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/server/EdgeFunctionServer.ts src/test/server/shared-folders.test.ts
git commit -m "feat: add watchSharedFolders option for shared folder hot-reload"
```

---

## Chunk 4: Final Verification

### Task 5: Full regression + cleanup

- [ ] **Step 1: Run the complete test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Verify the shared-test function works end-to-end**

Run: `npx vitest run src/test/server/shared-folders.test.ts -v`
Expected: All shared folder tests PASS with verbose output

- [ ] **Step 3: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "feat: shared folders support complete"
```

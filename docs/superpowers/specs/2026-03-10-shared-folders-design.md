# Shared Folders (`_shared/`) Support

## Summary

Add support for underscore-prefixed shared folders (e.g., `_shared/`, `_helpers/`) that allow code reuse across edge functions, following Supabase's convention.

## Directory Structure

```
functions/
├── _shared/           # shared folder — not a function
│   ├── cors.ts
│   ├── utils.ts
│   └── db/
│       └── client.ts  # nested files supported
├── _helpers/          # another shared folder
│   └── db.ts
├── hello/
│   └── index.ts       # edge function
└── echo/
    └── index.ts       # edge function
```

## Design Decisions

1. **All underscore-prefixed folders are excluded** from function discovery, not just `_shared/`
2. **Read permissions scoped to shared folders only** — functions cannot read from sibling function directories. Shared folder paths are appended as additional comma-separated entries to the existing `--allow-read` flag.
3. **Hot-reload of shared folders is configurable** via `watchSharedFolders` option (default: `true`), restarts all workers on shared file change. Only meaningful when `hotReload` is also `true` — `watchSharedFolders` does nothing on its own.
4. **Auto-generated import map entries** for shared folder files, merged with user-provided import maps (user entries take precedence on conflict)

## Component Changes

### 1. Function Discovery (`EdgeFunctionServer.#scanFunctions()`)

Skip directories whose name starts with `_`. Collect them separately as shared folders for use by permissions and import map logic. Shared folders are scanned recursively — nested directories within shared folders are included (e.g., `_shared/db/client.ts` generates key `_shared/db/client.ts`).

### 2. Deno Read Permissions

`EdgeFunctionServer.#spawnWorker()` passes shared folder absolute paths via `runFlags` (e.g., appended to `--allow-read`). No new typed option on `DenoWorkerOptions` — the server layer handles this directly since shared folders are a server-level concern.

Result: `deno run --allow-read=/tmp/socket,/path/to/script,/path/to/functions/_shared,...`

### 3. Import Map Auto-Generation (`EdgeFunctionServer`)

On startup and on shared folder file changes:

1. Scan underscore-prefixed folders recursively for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.json` files
2. Generate import map with `{ "imports": { ... } }` structure using absolute `file://` URLs as values:
   - `"_shared/cors.ts"` → `"file:///abs/path/to/functions/_shared/cors.ts"`
   - `"_shared/db/client.ts"` → `"file:///abs/path/to/functions/_shared/db/client.ts"`
3. If user provided `importMapPath`, read and merge — user entries take precedence for duplicate keys. User `scopes` are preserved as-is.
4. If user provided `configPath` (deno.json) with `imports`, those are also loaded and merged (user takes precedence). The generated import map is passed via `--import-map` alongside `--config` — Deno merges them, with `--import-map` taking precedence over `deno.json` imports.
5. Write merged import map to a temp file in `os.tmpdir()`. OS-level temp cleanup handles crash scenarios.
6. Clean up temp file on server `stop()`.

If the user's `importMapPath` points to invalid JSON, the error propagates as-is (no special handling — fail fast).

Functions can import shared code two ways:
```typescript
// Bare specifier (via auto-generated import map)
import { corsHeaders } from "_shared/cors.ts"

// Relative path (always works in Deno)
import { corsHeaders } from "../_shared/cors.ts"
```

### 4. Hot-Reload (`EdgeFunctionServer`)

New option: `watchSharedFolders?: boolean` (default: `true`)

Only takes effect when `hotReload` is also `true`. The existing watcher callback differentiates by checking if the top-level directory in the changed path starts with `_`:
- If yes → shared folder change: regenerate temp import map, restart **all** running workers
- If no → function change: restart only that function (existing behavior)
- Uses existing debounce logic

When `watchSharedFolders` is `false` (or `hotReload` is `false`):
- Shared folders not watched; changes require manual restart

## Files Modified

| File | Change |
|------|--------|
| `src/server/EdgeFunctionServer.ts` | Skip `_`-prefixed dirs in scan, collect shared folders, generate merged import map to temp file, expand watcher to differentiate shared vs function changes, add `watchSharedFolders` option, clean up temp file on `stop()` |
| `src/server/EdgeFunctionServer.ts` | `EdgeFunctionServerOptions` type updated with `watchSharedFolders?: boolean` (options are defined in this same file) |
| `src/test/functions/_shared/` | New test fixtures with shared modules |
| `src/test/server/` | New tests for shared folder behavior (discovery, import map generation, hot-reload) |

## Files NOT Modified

- `src/worker/factory.ts` — shared folder paths passed via existing `runFlags` mechanism, no type changes needed
- Bootstrap scripts — Deno handles imports natively
- Server adapters — unaffected
- Env loading — unaffected

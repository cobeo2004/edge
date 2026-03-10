# Shared Folders (`_shared/`) Support

## Summary

Add support for underscore-prefixed shared folders (e.g., `_shared/`, `_helpers/`) that allow code reuse across edge functions, following Supabase's convention.

## Directory Structure

```
functions/
├── _shared/           # shared folder — not a function
│   ├── cors.ts
│   └── utils.ts
├── _helpers/          # another shared folder
│   └── db.ts
├── hello/
│   └── index.ts       # edge function
└── echo/
    └── index.ts       # edge function
```

## Design Decisions

1. **All underscore-prefixed folders are excluded** from function discovery, not just `_shared/`
2. **Read permissions scoped to shared folders only** — functions cannot read from sibling function directories
3. **Hot-reload of shared folders is configurable** via `watchSharedFolders` option (default: `true`), restarts all workers on shared file change
4. **Auto-generated import map entries** for shared folder files, merged with user-provided import maps (user entries take precedence on conflict)

## Component Changes

### 1. Function Discovery (`EdgeFunctionServer.#scanFunctions()`)

Skip directories whose name starts with `_`. Collect them separately as shared folders for use by permissions and import map logic.

### 2. Deno Read Permissions (`factory.ts`)

Add `sharedFolderPaths: string[]` to `DenoHTTPWorkerOptions`. Include these paths in the `--allow-read` flag when spawning Deno workers.

Result: `deno run --allow-read=/tmp/socket,/path/to/script,/path/to/functions/_shared,...`

### 3. Import Map Auto-Generation (`EdgeFunctionServer`)

On startup and on shared folder file changes:

1. Scan underscore-prefixed folders for `.ts`, `.tsx`, `.js`, `.mjs` files
2. Generate import map entries: `"_shared/cors.ts"` → `"./functions/_shared/cors.ts"`
3. If user provided `importMapPath`, read and merge — user entries take precedence
4. Write merged import map to a temp file, pass to workers
5. Clean up temp file on server shutdown

Functions can import shared code two ways:
```typescript
// Bare specifier (via auto-generated import map)
import { corsHeaders } from "_shared/cors.ts"

// Relative path (always works in Deno)
import { corsHeaders } from "../_shared/cors.ts"
```

### 4. Hot-Reload (`EdgeFunctionServer`)

New option: `watchSharedFolders?: boolean` (default: `true`)

When enabled:
- File watcher includes underscore-prefixed directories
- On shared file change: regenerate temp import map, restart all running workers
- Uses existing debounce logic

When disabled:
- Shared folders not watched; changes require manual restart

## Files Modified

| File | Change |
|------|--------|
| `src/server/EdgeFunctionServer.ts` | Skip `_`-prefixed dirs, collect shared folders, generate merged import map, expand watcher, add option, clean up temp file |
| `src/worker/factory.ts` | Add `sharedFolderPaths` to options, include in `--allow-read` |
| Types file | Add `watchSharedFolders?: boolean` to `EdgeFunctionServerOptions` |
| `src/test/functions/_shared/` | New test fixtures |
| `src/test/server/` | New tests for shared folder behavior |

## Files NOT Modified

- Bootstrap scripts — Deno handles imports natively
- Server adapters — unaffected
- Env loading — unaffected

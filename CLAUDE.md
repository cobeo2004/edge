# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Testing

- **Run all tests:** `npm test` (runs `vitest run`)
- **Watch mode:** `npm run test:watch` (runs `vitest`)
- **Single test:** `npx vitest run -t "test name"` or `npx vitest run src/test/worker/basic.test.ts`
- **Run a test group:** `npx vitest run src/test/worker/` or `npx vitest run src/test/server/`
- Tests require Deno to be installed and available on PATH — the test suite spawns real Deno subprocesses over Unix sockets
- Default test timeout is 1000ms; some tests (error handling, unhandled rejections) use longer timeouts up to 20s

### Test structure

- Tests live under `src/test/` organized by component:
  - `src/test/worker/` — DenoHTTPWorker tests (basic, lifecycle, config, logging)
  - `src/test/server/` — EdgeFunctionServer tests (routing, lifecycle, config, logging, wasm)
- Shared helpers in `src/test/helpers/`:
  - `worker.ts` — `jsonRequest()`, `DEFAULT_HTTP_VAL`, `cleanupSockets()`
  - `http.ts` — `httpRequest()`, `httpRequestRaw()`
  - `fixtures.ts` — Path constants (`FUNCTIONS_DIR`, `SERVE_BOOTSTRAP`, etc.) and fixture scripts
- Test fixtures (Deno TypeScript files) live in `src/test/` and `src/test/functions/` (linted with `deno lint`, not Biome)
- Server tests use `port: 0` (auto-assign) + `server.port` to avoid port conflicts
- Always call `worker.terminate()` (or `worker.shutdown()` for graceful) at the end of each test to clean up the Deno subprocess and socket file

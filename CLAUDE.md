# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Testing

- **Run all tests:** `npm test` (runs `vitest run`)
- **Watch mode:** `npm run test:watch` (runs `vitest`)
- **Single test:** `npx vitest run -t "test name"` or `npx vitest run src/DenoHTTPWorker.test.ts`
- Tests require Deno to be installed and available on PATH — the test suite spawns real Deno subprocesses over Unix sockets
- Default test timeout is 1000ms; some tests (error handling, unhandled rejections) use longer timeouts up to 20s
- Test fixtures live in `src/test/` and are Deno TypeScript files (linted with `deno lint`, not Biome)
- The `jsonRequest` helper in the test file wraps `worker.request()` to return parsed JSON — use it for new tests
- Always call `worker.terminate()` (or `worker.shutdown()` for graceful) at the end of each test to clean up the Deno subprocess and socket file

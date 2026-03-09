# Roadmap — Supabase Edge Functions Feature Parity

> This document tracks planned features for `@cobeo2004/edge` to reach feature parity with [Supabase Edge Functions](https://supabase.com/docs/guides/functions) and beyond.

## Vision

Make `@cobeo2004/edge` a production-grade, self-hosted Deno edge function runtime — offering the same developer experience and operational guarantees as Supabase Edge Functions, while remaining framework-agnostic, runtime-agnostic, and easy to embed.

## Current Capabilities

- Spawn isolated Deno HTTP workers from Node.js over Unix sockets
- `EdgeFunctionServer` with per-function routing (`/:functionName/*`), lazy/eager spawning, hot reload
- Import maps and `deno.json` config support
- Configurable log levels with custom handlers
- Graceful shutdown and auto-respawn on worker exit
- Execution limits: memory caps, per-request timeout, worker max duration, and resource usage stats

---

## Phase 1 — Core Infrastructure (High Priority)

### Multi-Runtime Server Adapters

**Status:** Done

`EdgeFunctionServer` is decoupled from `node:http` behind a `ServerAdapter` interface using web standard `Request`/`Response`. Three adapters are provided:
- `node` adapter (default) — wraps `http.createServer` with web ↔ node:http conversion
- `bun` adapter — wraps `Bun.serve()` for native Bun HTTP handling
- `deno` adapter — wraps `Deno.serve()` for native Deno HTTP handling
- Runtime auto-detection selects the appropriate adapter, with manual override via `adapter` option on `EdgeFunctionServerOptions`
- All adapter types (`ServerAdapter`, `AdapterServer`, `RequestHandler`, `RuntimeName`) are exported from the package

### Environment Variables & Secrets Management

**Status:** Done

Built-in `.env` loading and secret masking for both workers and the edge function server:
- Global `.env` at `functionsDir/.env` auto-loaded at startup
- Per-function `.env` at `functionsDir/<name>/.env` auto-loaded per worker
- Additional `envFiles` array for extra `.env` paths
- Programmatic `env` option on both `EdgeFunctionServerOptions` and `DenoWorkerOptions`
- Six-layer precedence: `process.env` → global `.env` → `envFiles` → programmatic `env` → per-function `.env` → `workerOptions.env`
- Secret masking in log output (enabled by default, opt-out with `maskSecrets: false`)
- Exported utilities: `parseEnvFile()`, `loadEnvFile()`, `createSecretMasker()`

### Execution Limits

**Status:** Done

Resource limits to prevent runaway functions from consuming unbounded resources:
- `memoryLimitMb` — caps V8 heap via `--v8-flags=--max-old-space-size=N`; OOM crashes the worker and it respawns on next request
- `requestTimeout` — per-request timeout in ms using `req.setTimeout()`; aborts the request without killing the worker; `EdgeFunctionServer` returns 504
- `workerMaxDuration` — wall-clock lifetime limit in ms; worker auto-terminates and respawns on next request
- `onRequestStats` callback and `getWorkerStats(name)` method for per-request timing, status codes, timeout tracking, request counts, uptime, and restart counts
- All options available on both `DenoWorkerOptions` (worker-level) and `EdgeFunctionServerOptions` (server-level)

### Health Checks

**Status:** Not started

**Planned:**
- Periodic health-check pings to workers
- Auto-restart unhealthy workers

---

## Phase 2 — Security & Auth (Medium Priority)

### JWT Verification Middleware

**Status:** Not started

Supabase validates JWTs on every request by default (using the project's JWT secret). This project has no auth layer.

**Planned:**
- Optional JWT verification middleware in `EdgeFunctionServer`
- Configurable JWT secret / JWKS endpoint
- Pass decoded claims to function via request headers
- Allow per-function opt-out (e.g., for public endpoints)

### Permission Sandboxing Profiles

**Status:** Partial — users can pass `runFlags` manually

Supabase runs functions with a strict default permission set. This project defaults to `--allow-net --allow-env` but leaves full control to the user.

**Planned:**
- Named permission profiles (e.g., `"strict"`, `"standard"`, `"permissive"`)
- Per-function permission overrides
- Document recommended production permission sets

---

## Phase 3 — Performance & Scaling (Medium Priority)

### Worker Pool / Concurrency

**Status:** Not started

Supabase can run multiple isolates per function to handle concurrent requests. This project spawns exactly one Deno process per function — concurrent requests queue behind a single worker.

**Planned:**
- Configurable worker pool size per function
- Round-robin or least-connections request routing
- Auto-scaling based on queue depth or response latency
- Idle worker recycling

### WebSocket Support

**Status:** Not started

Supabase recently added WebSocket support for edge functions. The current Unix-socket HTTP/1.1 proxy does not handle WebSocket upgrades.

**Planned:**
- Detect and proxy `Upgrade: websocket` requests
- Bidirectional frame forwarding over the Unix socket
- Connection lifecycle management (ping/pong, close)

### Background Tasks

**Status:** Not started

Supabase supports long-running background tasks that outlive the HTTP response (e.g., `EdgeRuntime.waitUntil()`).

**Planned:**
- `waitUntil`-style API in the bootstrap layer
- Track in-flight background tasks per worker
- Graceful shutdown waits for background tasks to complete
- Configurable background task timeout

---

## Phase 4 — Developer Experience (Lower Priority)

### CLI Tooling

**Status:** Not started

Supabase provides `supabase functions serve`, `supabase functions deploy`, and `supabase functions new`. This project is library-only.

**Planned:**
- `edge serve` — start the dev server with hot reload
- `edge new <name>` — scaffold a new function from template
- `edge list` — list discovered functions and their status
- `edge logs <name>` — tail function logs

### Metrics & Observability

**Status:** Not started

No built-in metrics. Users must instrument manually.

**Planned:**
- Request count, latency (p50/p95/p99), error rate per function
- Worker lifecycle events (spawn, ready, exit, restart)
- Pluggable metrics backend (console, Prometheus, OpenTelemetry)
- Optional `/metrics` endpoint on the server

### Improved Error Reporting

**Status:** Partial — `onFunctionError` callback exists

**Planned:**
- Structured error responses with stack traces (dev mode only)
- Source-map support for transpiled function code
- Error categorization (timeout, OOM, user error, infrastructure)

---

## Phase 5 — Advanced Features (Longer-term)

### Ephemeral File Storage

**Status:** Not started

Supabase provides temporary file storage scoped to function execution. Currently, functions write to the host filesystem with whatever permissions are granted.

**Planned:**
- Scoped temp directory per function invocation
- Automatic cleanup after request completes
- Configurable size limit

### Multi-Worker Deployment Topologies

**Status:** Not started

**Planned:**
- Support running `EdgeFunctionServer` across multiple Node.js processes (cluster mode)
- Shared worker registry backed by IPC or Redis
- Sticky routing for stateful functions

### Custom Middleware Pipeline

**Status:** Not started

**Planned:**
- Hook into the request/response lifecycle (before/after function execution)
- Built-in middleware: CORS, rate limiting, request logging, body size limits
- Composable middleware chain per function or globally

---

## Contributing

Contributions toward any roadmap item are welcome. Please open an issue to discuss the approach before submitting a PR for larger features.

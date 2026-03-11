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

**Status:** Done

Periodic HTTP health-check pings to detect frozen/unresponsive workers:
- `healthCheckInterval` — ms between pings (opt-in, disabled by default)
- `healthCheckTimeout` — ms to wait for response (default 5000)
- `healthCheckMaxFailures` — consecutive failures before restart (default 3)
- `onWorkerUnhealthy` callback fired when a worker is restarted
- All options available on both `DenoWorkerOptions` (worker-level) and `EdgeFunctionServerOptions` (server-level)
- Unhealthy workers are terminated and immediately respawned

---

## Phase 2 — Security & Auth (Medium Priority)

### JWT Verification Middleware

**Status:** Done

Pluggable authentication via `AuthStrategy` interface with built-in `JWTStrategy` (powered by `jose`):
- Optional `auth` option on `EdgeFunctionServerOptions` accepts any `AuthStrategy` implementation
- Built-in `JWTStrategy` supports HMAC, RSA, EC, and JWKS endpoint verification
- Token extraction from Authorization header, cookies, or query params
- Decoded claims forwarded to functions via `X-Auth-Claims` header
- Per-function opt-out via `publicFunctions` server option or `auth: false` in `function.json`
- Configurable `onAuthFailure` callback for custom error responses
- Exported types: `AuthStrategy`, `AuthResult`, `JWTStrategy`, `JWTStrategyOptions`

### Permission Sandboxing Profiles

**Status:** Done

Named permission profiles and per-function overrides:
- Four built-in profiles: `none`, `strict`, `standard`, `permissive`
- Custom named profiles via `permissionProfiles` server option
- Per-function overrides via `functionPermissions` server option or `permissions` in `function.json`
- Resolution order: `functionPermissions` > `function.json` > `defaultPermissionProfile` > `"standard"`
- Raw flags arrays supported alongside profile names
- Exported utilities: `BUILT_IN_PROFILES`, `resolvePermissionFlags()`, `FunctionConfig`

---

## Phase 3 — Performance & Scaling (Medium Priority)

### Cold/Warm Worker Lifecycle (Idle Timeout)

**Status:** Done

Workers now transition between cold (no process) and warm (running) states based on activity, mimicking Supabase Edge Functions behavior:

- `idleTimeout` option on `EdgeFunctionServerOptions` (global, disabled by default)
- Per-function override via `idleTimeout` in `function.json`
- Active request tracking — idle timer only starts when all in-flight requests complete
- `onFunctionCold(name)` callback when a worker is terminated due to idle timeout
- Independent of `workerMaxDuration` (both timers run, whichever fires first wins)
- Works with `eagerSpawn` — eagerly spawned workers go cold if no requests arrive within the timeout

Lifecycle management is now handled by `WorkerLifecycleManager` (extracted as part of Worker Pool / Concurrency), which manages idle timeout, health checks, scaling, and cold/warm transitions per function.

### Worker Pool / Concurrency

**Status:** Done

Multiple worker instances per function with automatic scaling and load balancing:
- `minWorkers` / `maxWorkers` options on `EdgeFunctionServerOptions` and per-function `function.json`
- Least-loaded request routing — new requests go to the instance with fewest active requests
- Auto-scale up when all instances are busy (up to `maxWorkers`)
- Auto-scale down via idle timeout when above `minWorkers`
- `WorkerLifecycleManager` class manages all lifecycle concerns (spawning, idle timeout, health checks, cold/warm transitions) per function
- `onFunctionCold` fires when last instance is removed (including failed spawn slots)
- `onFunctionReady` fires when first instance is added
- Generation-based restart invalidation prevents stale spawns from registering after a restart
- Backward compatible: default `maxWorkers: 1` preserves single-worker behavior

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

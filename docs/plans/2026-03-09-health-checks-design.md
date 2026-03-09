# Health Checks Design

## Overview

Periodic HTTP health-check pings from `EdgeFunctionServer` to spawned workers. When a worker fails consecutive checks, it's terminated and immediately respawned, with an optional callback for observability.

## Configuration

New options on **both** `DenoWorkerOptions` and `EdgeFunctionServerOptions`:

| Option | Type | Default | Description |
|---|---|---|---|
| `healthCheckInterval` | `number` | `undefined` (disabled) | Ms between pings |
| `healthCheckTimeout` | `number` | `5000` | Ms to wait for response |
| `healthCheckMaxFailures` | `number` | `3` | Consecutive failures before restart |

New callback on `EdgeFunctionServerOptions` only:

| Option | Type | Description |
|---|---|---|
| `onWorkerUnhealthy` | `(name: string, consecutiveFailures: number) => void` | Fired when a worker is restarted due to health check failure |

Server-level values act as defaults. Per-worker overrides via `workerOptions` take precedence (same pattern as `requestTimeout` etc.).

## Mechanism

- Health checks are **opt-in** — only active when `healthCheckInterval` is set
- `EdgeFunctionServer` starts a per-worker `setInterval` timer after spawn
- Each tick sends an HTTP GET to the worker's Unix socket (reusing the existing socket/agent pattern from `warmRequest()`)
- If the response arrives within `healthCheckTimeout`, the failure counter resets to 0
- If the request errors or times out, the failure counter increments
- When failures reach `healthCheckMaxFailures`: fire `onWorkerUnhealthy`, terminate the worker, and immediately respawn
- Timers are cleared on `stop()`, `restartFunction()`, and worker exit

## What it does NOT do

- No dedicated `/_health` endpoint in the Deno worker — we ping the existing HTTP server (like `warmRequest()`)
- No per-function health check config at the server level (only global server defaults + worker-level overrides)
- No health status API endpoint on the server itself (can be added in Phase 4 Metrics)

## Decisions

1. **HTTP ping over process liveness** — process crashes are already handled by exit listeners; health checks catch frozen/deadlocked workers
2. **Both server-level and worker-level config** — consistent with `requestTimeout`, `memoryLimitMb`, `workerMaxDuration`
3. **Immediate respawn + callback** — minimizes downtime, provides observability via `onWorkerUnhealthy`
4. **Server-level management** — `EdgeFunctionServer` owns the health check loop, not the worker (server already owns lifecycle)
5. **Opt-in only** — no default interval; health checks only run when explicitly configured

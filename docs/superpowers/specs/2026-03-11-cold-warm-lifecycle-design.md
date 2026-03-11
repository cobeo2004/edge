# Cold/Warm Worker Lifecycle (Idle Timeout) — Design Spec (Historical)

> **Note:** This is the original design spec for idle timeout support. The implementation has since been refactored into `WorkerLifecycleManager` with per-instance timers as part of the Worker Pool / Concurrency feature. Refer to `2026-03-11-worker-pool-concurrency-design.md` for the current architecture.

## Summary

Add idle timeout support so workers transition from warm (running) to cold (terminated) after a configurable period of inactivity. This mimics Supabase Edge Functions behavior where workers boot on first request and shut down when idle.

## Decisions

- **Approach (original):** Inline in WorkerPool, structured for future extraction into WorkerLifecycleManager. Now lives in `WorkerLifecycleManager` with per-instance idle timers.
- **Idle detection:** Track active request count; idle timer starts only when count drops to zero; resets on new request
- **Configuration:** Global `idleTimeout` on `EdgeFunctionServerOptions` + per-function override via `function.json`
- **Default:** Disabled (no idle timeout unless explicitly configured) — preserves existing behavior
- **Callback:** `onFunctionCold(name)` fires when the last instance is terminated and the function has zero workers, regardless of reason (idle timeout, crash, health check failure)
- **Interaction with `workerMaxDuration`:** Independent — both timers run, whichever fires first wins

## Lifecycle Flow

```
COLD (no worker)
  ↓ request arrives → pool.getOrCreate() spawns worker
WARM (worker running)
  ↓ activeRequests drops to 0 → start idle timer
  ↓ new request? → clear timer, stays WARM
  ↓ timer fires? → terminate worker, onFunctionCold() → COLD
```

## Changes

### WorkerPool.ts

New state maps (grouped together for future extraction):
- `#activeRequests: Map<string, number>` — in-flight request count per function
- `#idleTimers: Map<string, ReturnType<typeof setTimeout>>` — per-function idle timer
- `#idleTimeouts: Map<string, number>` — resolved timeout per function

New private methods:
- `#resolveIdleTimeout(name)` — per-function `function.json` > global option > undefined
- `#startIdleTimer(name)` — sets timeout; on fire: terminates worker, cleans up, calls onFunctionCold
- `#resetIdleTimer(name)` — clears and restarts timer if activeRequests === 0
- `#clearIdleTimer(name)` — clears timer (used on terminate/restart/exit)

New public methods:
- `incrementActiveRequests(name)` — called by request handler before forwarding
- `decrementActiveRequests(name)` — called by request handler after response completes; starts idle timer if count reaches 0

Modifications:
- `getOrCreate()` — clear idle timer when acquiring a worker
- Worker `exit` handler — clear idle timer
- `restart()` / `terminate()` paths — clear idle timer
- `shutdown()` — clear all idle timers

### WorkerRequestHandler.ts

Wrap request lifecycle:
- `pool.incrementActiveRequests(name)` before forwarding
- `pool.decrementActiveRequests(name)` in finally block

### EdgeFunctionServerOptions (types)

- `idleTimeout?: number` — ms, disabled by default
- `onFunctionCold?: (name: string) => void`

### FunctionConfig (permissions/types.ts)

- `idleTimeout?: number` — per-function override

### Interactions

| Feature | Behavior |
|---------|----------|
| `workerMaxDuration` | Independent timers, whichever fires first wins |
| `healthCheckInterval` | Health pings don't count as requests, don't reset idle timer |
| `eagerSpawn` | Eagerly spawned workers go cold if no requests arrive within idleTimeout |
| Hot reload | Worker restart clears idle timer; new worker starts fresh |

### Tests

- Worker goes cold after idle timeout with no requests
- Worker stays warm while requests are in-flight
- Idle timer resets on new request
- Per-function idleTimeout override via function.json
- onFunctionCold callback fires on idle termination
- Idle timeout + workerMaxDuration coexistence
- eagerSpawn + idle timeout interaction
- Worker crash during idle timer doesn't cause errors

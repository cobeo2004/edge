# Background Tasks Design Spec

**Date:** 2026-03-15
**Status:** Draft
**Phase:** 3 — Performance & Scaling (feature 4 of 4)

## Problem

Supabase Edge Functions support long-running background tasks that outlive the HTTP response via `EdgeRuntime.waitUntil()`. This project currently has no equivalent — once a response is sent, the worker has no mechanism to continue processing. Use cases like fire-and-forget analytics, cache warming, webhook fan-out, and async logging all require this capability.

## Goals

- Provide a `waitUntil`-style API compatible with Supabase's `EdgeRuntime.waitUntil(promise)`
- Track in-flight background tasks per worker instance
- Integrate with existing lifecycle management (idle timeout, graceful shutdown, worker pool)
- Enforce configurable timeouts to prevent runaway tasks
- Maintain backward compatibility — existing users without background tasks see no behavior change

## Non-Goals

- Durable/persistent background jobs (queued across restarts)
- Priority or scheduling of background tasks
- Cross-worker task coordination

## Design

### 1. User-Facing API (Bootstrap Layer)

**File:** `deno-bootstrap/serve.ts`

Expose a global `EdgeRuntime` object before importing user code:

```typescript
globalThis.EdgeRuntime = { waitUntil(promise: Promise<unknown>) { ... } };
```

**Behavior:**
- `waitUntil(promise)` accepts any `Promise`. Non-promise arguments are ignored (no-op).
- Multiple calls are supported — each adds to the set of tracked promises.
- The bootstrap tracks a pending task counter internally.
- On each `waitUntil` call: increment counter, notify host via sideband callback.
- When a promise settles (resolve or reject): decrement counter, notify host. Rejections are logged to stderr but do not crash the worker.
- On SIGINT (graceful shutdown): the bootstrap awaits all pending promises (up to the host-enforced timeout) before exiting.

**Example user code:**

```typescript
Deno.serve(async (req) => {
  const data = await req.json();

  EdgeRuntime.waitUntil(
    fetch("https://analytics.example.com/events", {
      method: "POST",
      body: JSON.stringify(data),
    })
  );

  return new Response("accepted", { status: 202 });
});
```

### 2. Host Communication (Sideband HTTP Callback)

**Mechanism:** The bootstrap sends HTTP requests back to the host over the same Unix socket, using reserved control paths that are intercepted before reaching the user's handler.

**Control paths:**

| Path | Method | Purpose |
|------|--------|---------|
| `/__bg/started` | `POST` | A new background task was registered |
| `/__bg/complete` | `POST` | A background task settled (resolved or rejected) |

**Bootstrap side:**
- Uses `fetch()` (available in Deno) to send requests to `http://localhost/__bg/started` via the Unix socket.
- Requests are fire-and-forget from the bootstrap's perspective — errors are logged but don't affect task execution.

**Host side (`deno-bootstrap/serve.ts` handler):**
- The existing handler in the `originalServe` call intercepts requests where the path matches `/__bg/*` before forwarding to the user's handler.
- These control requests return a `200 OK` with no body.

**Why sideband over alternatives:**
- Response headers (Option A) only update at response time — the host can't know when tasks complete after the response is sent.
- Stdout JSON (Option C) mixes with user logs and requires parsing.
- Sideband reuses the existing Unix socket, gives real-time notification, and cleanly separates control traffic from user traffic.

### 3. Worker Instance Tracking

**File:** `src/worker/DenoHTTPWorker.ts`

Add a `backgroundTaskCount` field to `DenoHTTPWorkerImpl`:

```typescript
#backgroundTaskCount = 0;

get backgroundTaskCount(): number {
  return this.#backgroundTaskCount;
}

incrementBackgroundTasks(): void {
  this.#backgroundTaskCount++;
}

decrementBackgroundTasks(): void {
  this.#backgroundTaskCount = Math.max(0, this.#backgroundTaskCount - 1);
}
```

The handler in the worker's request pipeline intercepts `/__bg/started` and `/__bg/complete` paths, calling the increment/decrement methods and notifying the lifecycle manager.

Add `backgroundTaskCount` to the `DenoHTTPWorker` interface.

### 4. Lifecycle Manager Integration

**File:** `src/server/core/WorkerLifecycleManager.ts`

#### Background Task Tracking

Mirror the existing WebSocket connection tracking pattern:

```typescript
#bgTaskCounts: Map<string, number> = new Map();
#backgroundTaskKeepsAlive: boolean;

incrementBackgroundTasks(instanceId: string): void { ... }
decrementBackgroundTasks(instanceId: string): void { ... }
getBackgroundTaskCount(instanceId: string): number { ... }
```

#### Idle Timeout Integration

- New option: `backgroundTaskKeepsAlive?: boolean` (default `true`)
- When `backgroundTaskKeepsAlive` is `true` and background task count > 0: pause idle timer (clear it)
- When background tasks reach 0 and active requests are also 0 and WebSocket connections are also 0: restart idle timer
- Modify `#startIdleTimer` to check background task count alongside WebSocket count

#### Graceful Shutdown

- `dispose()` and `restart()`: if instances have pending background tasks, allow them to drain up to `backgroundTaskTimeout` before terminating.
- New internal method `#waitForBackgroundTasks(instance, timeout)`: returns a promise that resolves when background task count reaches 0 or timeout expires.

### 5. Background Task Timeout

**Enforcement:** The timeout is enforced by the host, not the bootstrap. When a background task notification (`/__bg/started`) arrives, the host starts (or resets) a per-instance timeout timer. If the timer fires while tasks are still pending, the worker is terminated (consistent with `workerMaxDuration` behavior).

**Configuration:**

| Level | Property | Default |
|-------|----------|---------|
| Global | `EdgeFunctionServerOptions.backgroundTaskTimeout` | `30000` (30s) |
| Per-function | `function.json` → `backgroundTaskTimeout` | Inherits global |

The timeout measures time since the **last HTTP response was sent** while background tasks are pending. If a new request arrives while background tasks are running, the timeout is paused (the worker is actively serving) and resumes after the new response is sent.

**On timeout:**
1. Log a warning with function name and pending task count.
2. Terminate the worker (SIGKILL via existing `_terminate()`).
3. The lifecycle manager handles replacement spawning if below `minWorkers`.

### 6. Worker Pool Integration

**File:** `src/server/core/WorkerPool.ts`

- Background task counts are included in pool stats via `getStats()`.
- Least-loaded routing considers only `activeRequests` (not background tasks) — a worker running background tasks should still accept new requests.
- The `backgroundTaskKeepsAlive` option flows from `EdgeFunctionServerOptions` through to `WorkerLifecycleManager`.

### 7. EdgeFunctionServer Integration

**File:** `src/server/core/EdgeFunctionServer.ts`

- Accept `backgroundTaskTimeout` and `backgroundTaskKeepsAlive` in server options.
- Pass through to `WorkerLifecycleManager` constructor.
- Per-function overrides read from `function.json` via `FunctionRegistry`.

### 8. Configuration Surface

**`EdgeFunctionServerOptions` additions:**

```typescript
/** Maximum time (ms) to wait for background tasks after response. Default: 30000 */
backgroundTaskTimeout?: number;

/** Whether pending background tasks prevent idle timeout. Default: true */
backgroundTaskKeepsAlive?: boolean;
```

**`function.json` additions:**

```json
{
  "backgroundTaskTimeout": 60000,
  "backgroundTaskKeepsAlive": true
}
```

### 9. Error Handling

| Scenario | Behavior |
|----------|----------|
| `waitUntil` called with non-Promise | No-op, ignored silently |
| Background promise rejects | Logged to stderr, counter decremented, worker stays alive |
| Sideband callback fails | Logged, task still runs in Deno (host may not track it) |
| Timeout exceeded | Worker terminated via SIGKILL |
| Worker crashes with pending tasks | Normal crash handling, tasks lost (expected) |
| `waitUntil` called after SIGINT | Promise tracked but subject to shutdown timeout |

### 10. Testing Strategy

**Unit tests:**
- Bootstrap: `waitUntil` tracks promises, sends sideband callbacks, awaits on SIGINT
- Worker: intercepts `/__bg/*` paths, tracks counts
- Lifecycle manager: background task tracking, idle timer interaction, timeout enforcement

**Integration tests:**
- End-to-end: user code calls `waitUntil`, response returns immediately, background task completes
- Timeout: background task exceeds timeout, worker is terminated
- Graceful shutdown: server waits for background tasks before stopping
- Idle timeout interaction: worker stays alive while background tasks are pending (when `backgroundTaskKeepsAlive: true`)
- Worker pool: background tasks don't affect least-loaded routing

**Test fixtures:**
- `src/test/functions/background-task.ts` — simple `waitUntil` with short delay
- `src/test/functions/background-task-slow.ts` — `waitUntil` that exceeds timeout
- `src/test/functions/background-task-error.ts` — `waitUntil` with rejecting promise

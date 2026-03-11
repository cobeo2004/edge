# Worker Pool / Concurrency Design Spec

## Goal

Allow multiple Deno worker processes per function with auto-scaling, least-connections routing, and per-worker idle scale-down. Currently each function gets exactly one Deno process — concurrent requests queue behind it. This is the biggest scaling bottleneck.

## Architecture

Extract lifecycle concerns from `WorkerPool` into a new `WorkerLifecycleManager` class. Introduce `WorkerInstance` as a per-instance state wrapper. `WorkerPool` becomes a thin registry/spawner. Routing uses least-connections. Scaling uses active request count as primary signal and queue depth as secondary (tracked for observability, not used for scaling decisions in v1).

### Components

#### WorkerInstance

Lightweight internal wrapper around `DenoHTTPWorker` holding per-instance state:

```ts
interface WorkerInstance {
  id: string;                    // e.g., "hello-0", "hello-1"
  functionName: string;
  worker: DenoHTTPWorker;
  activeRequests: number;
  totalRequests: number;         // Lifetime request count for this instance
  spawnTime: number;
  idleTimer?: NodeJS.Timeout;
  healthCheckTimer?: NodeJS.Timeout;
  healthCheckFailures: number;
  healthCheckInFlight: boolean;
}
```

**ID scheme:** `{functionName}-{counter}` with a monotonically increasing counter per function stored in `WorkerLifecycleManager`. The counter never resets — if instance "hello-0" is terminated and a new one spawns, it becomes "hello-2" (not "hello-0"). This avoids ID collisions in logs and promise dedup keys.

Replaces the 7+ separate `Map`s currently in `WorkerPool` (`#workers`, `#activeRequests`, `#idleTimers`, `#healthCheckTimers`, `#healthCheckFailures`, `#healthCheckInFlight`, `#workerSpawnTimes`).

#### WorkerLifecycleManager

One manager per function name. Owns all lifecycle concerns for that function's worker instances.

**Responsibilities:**
- Maintain the instance pool (array of `WorkerInstance`)
- Scaling decisions: when to spawn new instances, when to terminate idle ones
- Least-connections routing: pick instance with lowest `activeRequests`
- Per-instance health checks
- Per-instance idle timers
- Request counting and stats

**Key methods:**

```ts
type AcquireResult =
  | { kind: "instance"; instance: WorkerInstance }  // Use this worker
  | { kind: "spawn" }                               // Caller should spawn a new instance
  | { kind: "wait"; promise: Promise<void> }        // Spawn in-flight, await then retry

class WorkerLifecycleManager {
  acquire(): AcquireResult           // Discriminated result for clear control flow
  addInstance(instance): void        // Register newly spawned instance
  removeInstance(id): void           // Clean up terminated instance

  reserveSpawnSlot(): void           // Increment #spawningCount
  releaseSpawnSlot(): void           // Decrement #spawningCount (on success or failure)
  nextId(): string                   // Get next monotonic instance ID

  incrementActiveRequests(id): void  // Clear idle timer, bump count; no-op if id not found
  decrementActiveRequests(id): void  // Bump down, maybe start idle timer; no-op if id not found

  shouldScaleUp(): boolean           // All busy + under maxWorkers?
  shouldScaleDown(): boolean         // Idle instance + over minWorkers?

  startHealthCheck(instance): void
  stopHealthCheck(instance): void
  restartInstance(id): void          // Remove unhealthy instance, signal spawn needed

  getStats(): PoolStats              // Aggregated stats across all instances

  dispose(): void                    // Terminate all instances, clear all timers
}
```

**`acquire()` returns a discriminated union** to make control flow unambiguous:
- `{ kind: "instance" }` — a worker is available (least-loaded, or least-loaded even if all busy when at capacity)
- `{ kind: "spawn" }` — no available worker and room to spawn. Caller must call `reserveSpawnSlot()` + `nextId()` + spawn + `addInstance()` + `releaseSpawnSlot()`
- `{ kind: "wait", promise }` — at capacity but a spawn is in-flight. Caller awaits the promise then retries `acquire()`

**Scaling logic:**
- Scale up when: `acquire()` called, all instances have `activeRequests > 0`, AND `instances.length < maxWorkers`. Returns `{ kind: "spawn" }` to signal WorkerPool should spawn a new instance.
- **At capacity (all busy, at `maxWorkers`):** `acquire()` returns the least-loaded instance anyway (overloading it). Requests queue behind that worker's Unix socket just like they do today with a single worker. The `pendingRequests` counter is NOT incremented here — it's only for future use. This preserves current behavior where requests naturally pipeline on the socket.
- Scale down when: an instance's idle timer fires AND `instances.length > minWorkers`. Only that instance is terminated.
- If `instances.length === minWorkers`, idle instances stay alive (warm floor).

**Queue depth tracking (deferred):**
- A `pendingRequests` counter and `maxConcurrentRequestsPerWorker` threshold are deferred to a future version. In v1, requests at capacity simply route to the least-loaded worker and pipeline on the socket. This avoids dead code and keeps the implementation focused.

**Concurrent scale-up coordination:**
- `WorkerLifecycleManager` tracks a `#spawningCount` counter: how many spawns are currently in-flight for this function.
- `acquire()` checks `instances.length + #spawningCount >= maxWorkers` before returning `null`. This prevents multiple concurrent requests from each triggering a spawn that overshoots `maxWorkers`.
- `WorkerPool.getOrCreate()` increments `#spawningCount` before spawning, decrements after spawn completes (success or failure).
- Promise dedup in `WorkerPool` is keyed by `"{name}-{nextId}"` where `nextId` comes from the manager's counter. Two concurrent callers that both see `acquire()` return `{ kind: "spawn" }` will get different IDs and thus different dedup keys — but the `#spawningCount` gate ensures only the first triggers a real spawn while the second receives `{ kind: "wait" }` and awaits the in-flight spawn.

#### Simplified WorkerPool

After extraction, WorkerPool is a thin coordinator.

**What stays:**
- `Map<string, WorkerLifecycleManager>` (one per function)
- `#spawnWorker()` — permission resolution, env merging, logging, calling `newDenoHTTPWorker()`
- `#workerPromises` — spawn deduplication (keyed per-instance `"{name}-{index}"`)
- `getOrCreate()` — orchestrates acquire -> spawn-if-needed -> return
- `restart()`, `terminateAll()` — delegates to managers
- `getStats()` — delegates to managers
- `incrementRequestCount()` — delegates to manager which tracks per-instance `totalRequests`

**What moves to WorkerLifecycleManager:**
- `#activeRequests`, `#idleTimers`, `#healthCheckTimers`, `#healthCheckFailures`, `#healthCheckInFlight` maps
- `incrementActiveRequests()`, `decrementActiveRequests()`
- `#startHealthCheck()`, `#stopHealthCheck()`
- `#startIdleTimer()`, `#clearIdleTimer()`
- `#requestCounts` — absorbed into `WorkerInstance.totalRequests`
- `#restartCounts` — tracked per-manager (function-level restart count)

**`getOrCreate` flow:**
1. Get or create `WorkerLifecycleManager` for function
2. Call `manager.acquire()` → returns `AcquireResult`
3. `{ kind: "instance" }` → return `result.instance`
4. `{ kind: "spawn" }`:
   a. Call `manager.reserveSpawnSlot()`
   b. Generate instance ID via `manager.nextId()`
   c. Dedup key: `"{name}-{id}"`
   d. Try: spawn new worker, wrap in `WorkerInstance`, call `manager.addInstance()`
   e. Finally: call `manager.releaseSpawnSlot()` (always, even on failure)
   f. On failure: delete dedup key, throw error (caller gets 502)
   g. On success: return instance
5. `{ kind: "wait", promise }`:
   a. Await the promise (in-flight spawn completes)
   b. Retry from step 2 (loop, not recursion, with max 3 retries to prevent infinite loops)

#### WorkerRequestHandler Changes

Minimal. `getOrCreate` now returns `WorkerInstance` instead of `DenoHTTPWorker`. Handler destructures:

```ts
const instance = await this.#pool.getOrCreate(functionName);
// instance.worker for proxying
// instance.id for active request tracking
```

`incrementActiveRequests`, `decrementActiveRequests` take `instanceId` instead of `functionName`. URL rewriting, header building, streaming, stats emission all stay identical.

**Mid-request instance termination:** If a worker is terminated while a request is in-flight (e.g., health check restart, `workerMaxDuration`), the proxy request will emit an error event which the handler already catches — it returns a 502 response and calls `releaseActiveRequest()`. The `decrementActiveRequests(id)` method is a no-op if the instance ID is no longer found (the instance was already removed). This matches the existing guard pattern where `decrementActiveRequests` short-circuits when the worker doesn't exist.

## Behavioral Semantics

### `restart(name)` behavior

Terminates all instances for a function and respawns `max(minWorkers, 1)` instances. This is the hot-reload path — a clean slate is simpler and safer than rolling restarts for dev-time reloading. Rolling restarts could be added later as a separate `rollingRestart()` method if needed for zero-downtime production use.

### `onFunctionReady(name)` callback

Fires once per function when the **first** instance becomes ready. Does NOT fire for subsequent scale-up instances. Rationale: consumers use this to know "function X is available", not to track individual worker spawns. Per-instance spawn events can be observed via `onRequestStats` or future metrics hooks.

### `onFunctionCold(name)` callback

Fires only when the **last** instance is terminated and the function has zero workers. The function is truly cold.

### Logging with instance IDs

Log messages change from `[deno:${name}]` to `[deno:${instanceId}]` (e.g., `[deno:hello-0]`). This disambiguates logs from multiple instances of the same function.

The `onLog` callback signature remains unchanged — it still receives `functionName` as its first parameter for backward compatibility. The instance ID is only used in the internal default log formatting (the `[deno:${instanceId}]` prefix). Users who need per-instance log routing can parse the instance ID from the message or use `getStats()` for per-instance data.

### Graceful shutdown (`dispose`)

`dispose()` calls `worker.terminate()` on all instances (SIGKILL). This is safe because:
- Scale-down only terminates idle instances (`activeRequests === 0`)
- `terminateAll()` (server shutdown) currently uses `terminate()` already
- Graceful `shutdown()` (SIGINT) could be added later but is not needed for v1

### `getStats(name)` return type

```ts
interface PoolStats {
  functionName: string;
  instanceCount: number;        // Current number of live instances
  totalRequests: number;        // Sum across all instances
  activeRequests: number;       // Sum across all instances
  restartCount: number;         // Function-level restart count
  instances: InstanceStats[];   // Per-instance breakdown
}

interface InstanceStats {
  id: string;
  activeRequests: number;
  totalRequests: number;
  uptimeMs: number;
}
```

Both aggregate and per-instance stats are returned.

### Health check single-instance restart

When a health check detects an unhealthy instance:
1. `stopHealthCheck(instance)` — stop pinging
2. `removeInstance(id)` — terminate the worker, remove from pool
3. If `instances.length < minWorkers` after removal, signal `WorkerPool` to spawn a replacement immediately
4. Otherwise, the replacement spawns on next request (demand-driven), same as normal scale-up
5. The replacement instance gets a new ID from the monotonic counter (never reuses old IDs)
6. The removed instance does NOT count toward `maxWorkers` during the replacement window — `removeInstance` runs before any spawn decision

### Socket file management

Not a concern — `newDenoHTTPWorker()` already generates unique socket files per worker process using `os.tmpdir()` and random suffixes. Multiple workers for the same function each get their own socket automatically.

## Configuration

### Server-level options (EdgeFunctionServerOptions)

```ts
minWorkers?: number;    // Default: 0 (can scale to cold)
maxWorkers?: number;    // Default: 1 (backward-compatible)
```

### Per-function override (function.json)

```json
{
  "minWorkers": 2,
  "maxWorkers": 5,
  "eagerSpawn": true,
  "idleTimeout": 30000
}
```

### Resolution order

1. `function.json` override (if present)
2. Server-level option
3. Defaults: `minWorkers: 0`, `maxWorkers: 1`

### FunctionConfig additions

```ts
export interface FunctionConfig {
  permissions?: string | string[];
  auth?: boolean;
  idleTimeout?: number;
  minWorkers?: number;      // NEW
  maxWorkers?: number;      // NEW
  eagerSpawn?: boolean;     // NEW
}
```

Parsing in `config.ts`: same pattern as existing fields. For `minWorkers` and `maxWorkers`, validate `typeof === "number"` and apply the rules below. For `eagerSpawn`, validate `typeof === "boolean"`. Invalid values are silently ignored (field not set on config), matching existing behavior for `idleTimeout`.

### Validation

Applied to both server-level options and per-function `function.json` values:

- `minWorkers >= 0`
- `maxWorkers >= 1`
- `minWorkers <= maxWorkers`
- Invalid values: log warning, fall back to defaults

### eagerSpawn interaction

- Server-level `eagerSpawn: true` spawns for all functions
- Per-function `eagerSpawn: true` spawns only that function, even if server-level is `false`
- Per-function `eagerSpawn: false` skips that function, even if server-level is `true`
- Spawns `max(minWorkers, 1)` instances at startup for eagerly-spawned functions. The `max(..., 1)` ensures that `eagerSpawn: true` always does something — spawning 0 workers eagerly is contradictory. If a user wants `minWorkers: 0` with no eager spawn, they simply don't set `eagerSpawn: true`.

### Idle timeout interaction

- Per-instance idle timers (not per-function)
- Idle instance only terminated if `instances.length > minWorkers`
- At `minWorkers`, idle instances stay warm (warm floor)
- `onFunctionCold` only fires when last instance terminated (function truly goes cold)
- When `minWorkers: 0`, the last idle instance CAN be terminated, which fires `onFunctionCold`. This is the standard cold/warm cycle from v0.0.6.

## File Structure

### New files
- `src/server/core/WorkerInstance.ts` — interface and factory
- `src/server/core/WorkerLifecycleManager.ts` — scaling, health, idle, routing

### Modified files
- `src/server/core/WorkerPool.ts` — simplified, delegates lifecycle
- `src/server/core/WorkerRequestHandler.ts` — uses `instanceId`
- `src/server/utils/types.ts` — add `minWorkers`, `maxWorkers`
- `src/permissions/types.ts` — add `minWorkers`, `maxWorkers`, `eagerSpawn` to `FunctionConfig`
- `src/permissions/config.ts` — parse new fields
- `src/server/index.ts` — re-export new types
- `src/server/core/EdgeFunctionServer.ts` — pass options, eager spawn changes

### Test files
- `src/test/server/worker-pool-concurrency.test.ts`
- `src/test/server/worker-lifecycle-manager.test.ts`
- Updates to: `idle-timeout.test.ts`, `health-checks.test.ts`, `lifecycle.test.ts`, `routing.test.ts`

### Test fixtures
- `src/test/functions/pool-test/` — `function.json` with `{ "minWorkers": 1, "maxWorkers": 3 }`
- `src/test/functions/eager-override/` — `function.json` with `{ "eagerSpawn": true, "minWorkers": 2 }`

## Test Scenarios

1. Default `maxWorkers: 1` behaves identically to current single-worker
2. Concurrent requests trigger scale up to `maxWorkers`
3. Idle worker terminated when above `minWorkers`
4. Idle worker stays alive when at `minWorkers` (warm floor)
5. Least-connections routing distributes to least loaded worker
6. `eagerSpawn` spawns `max(minWorkers, 1)` at startup
7. Per-function `eagerSpawn` override (true overrides false, false overrides true)
8. Per-function `minWorkers`/`maxWorkers` override via `function.json`
9. `onFunctionCold` only fires when last instance terminated
10. Health check per-instance: unhealthy instance restarted, others unaffected
11. Backward compatibility: no config changes = identical behavior to current version
12. Concurrent scale-up race: multiple simultaneous requests don't overshoot `maxWorkers`
13. Scale-up during in-flight spawn: second request waits for first spawn, doesn't trigger duplicate
14. `restart()` with multiple active instances: all terminated, `max(minWorkers, 1)` respawned
15. `terminateAll()` cleans up all instances across all functions
16. Stats accuracy: `getStats()` returns correct aggregate and per-instance data
17. At capacity: when all workers busy and at `maxWorkers`, requests route to least-loaded (no error)
18. Health check restart replaces only the unhealthy instance, replacement gets new ID

## Backward Compatibility

Fully backward-compatible. Defaults (`minWorkers: 0`, `maxWorkers: 1`) produce identical behavior to the current single-worker-per-function model. No breaking changes to public API.

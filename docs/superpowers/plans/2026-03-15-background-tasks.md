# Background Tasks Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `EdgeRuntime.waitUntil(promise)` API for background tasks that outlive HTTP responses, with configurable timeouts, idle timer integration, and graceful shutdown support.

**Architecture:** Bootstrap exposes `EdgeRuntime.waitUntil()` global, signals host via structured stderr messages (`\x00BG:{json}\n`). Host-side factory.ts parses stderr, routes events to WorkerLifecycleManager which tracks counts per instance, integrates with idle timeout, and enforces background task timeout.

**Tech Stack:** TypeScript, Deno (bootstrap), Node.js (host), Vitest (tests), Unix sockets (IPC)

**Spec:** `docs/superpowers/specs/2026-03-15-background-tasks-design.md`

---

## File Structure

### New Files
- `src/test/functions/background-task/index.ts` — test fixture: waitUntil with 500ms delay + stdout marker
- `src/test/functions/background-task-slow/index.ts` — test fixture: waitUntil with 60s delay (timeout testing)
- `src/test/functions/background-task-error/index.ts` — test fixture: waitUntil with rejecting promise
- `src/test/worker/background-task.test.ts` — worker-level background task tests
- `src/test/server/background-task.test.ts` — server-level E2E background task tests

### Modified Files
- `deno-bootstrap/serve.ts` — add EdgeRuntime.waitUntil global + stderr notifications
- `deno-bootstrap/index.ts` — add EdgeRuntime.waitUntil global + stderr notifications
- `src/worker/types.ts` — add background task callbacks to DenoWorkerOptions
- `src/worker/DenoHTTPWorker.ts` — add backgroundTaskCount to interface + impl
- `src/worker/factory.ts` — parse stderr for `\x00BG:` messages, always set up stderr readline
- `src/permissions/types.ts` — add backgroundTaskTimeout/backgroundTaskKeepsAlive to FunctionConfig
- `src/server/utils/types.ts` — add backgroundTaskTimeout/backgroundTaskKeepsAlive to EdgeFunctionServerOptions
- `src/server/core/WorkerInstance.ts` — add backgroundTaskCount to InstanceStats, totalBackgroundTasks to PoolStats
- `src/server/core/WorkerLifecycleManager.ts` — background task tracking, idle timer integration, timeout, gracefulDispose
- `src/server/core/WorkerPool.ts` — wire background task events, add gracefulTerminateAll
- `src/server/core/EdgeFunctionServer.ts` — wire options through, update stop() for graceful shutdown

---

## Chunk 1: Foundation — Types, Fixtures, Bootstrap

### Task 1: Add Type Definitions

**Files:**
- Modify: `src/permissions/types.ts`
- Modify: `src/server/utils/types.ts`
- Modify: `src/worker/types.ts`
- Modify: `src/worker/DenoHTTPWorker.ts`
- Modify: `src/server/core/WorkerInstance.ts`

- [ ] **Step 1: Add FunctionConfig fields**

In `src/permissions/types.ts`, add after `websocketKeepsAlive`:

```typescript
  /** Maximum time (ms) to wait for background tasks after response. Overrides server-level backgroundTaskTimeout */
  backgroundTaskTimeout?: number;
  /** Whether pending background tasks prevent idle timeout. Overrides server-level backgroundTaskKeepsAlive */
  backgroundTaskKeepsAlive?: boolean;
```

- [ ] **Step 2: Add EdgeFunctionServerOptions fields**

In `src/server/utils/types.ts`, add after the `onWebSocketError` callback:

```typescript
  /** Maximum time (ms) to wait for background tasks after last response. Default: 30000 */
  backgroundTaskTimeout?: number;
  /** Whether pending background tasks prevent idle timeout. Default: true */
  backgroundTaskKeepsAlive?: boolean;
```

- [ ] **Step 3: Add DenoWorkerOptions callbacks**

In `src/worker/types.ts`, add to the `DenoWorkerOptions` interface:

```typescript
  /** Called when a background task starts (via EdgeRuntime.waitUntil) */
  onBackgroundTaskStarted?: () => void;
  /** Called when a background task completes (resolved or rejected) */
  onBackgroundTaskComplete?: () => void;
```

- [ ] **Step 4: Add backgroundTaskCount to DenoHTTPWorker interface and impl**

In `src/worker/DenoHTTPWorker.ts`, add to the `DenoHTTPWorker` interface:

```typescript
  /** Number of pending background tasks */
  get backgroundTaskCount(): number;
```

Add to `DenoHTTPWorkerImpl`:

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

- [ ] **Step 5: Add background task fields to stats interfaces**

In `src/server/core/WorkerInstance.ts`, add to `InstanceStats`:

```typescript
  backgroundTaskCount: number;
```

Add to `PoolStats`:

```typescript
  totalBackgroundTasks: number;
```

- [ ] **Step 6: Commit**

```bash
git add src/permissions/types.ts src/server/utils/types.ts src/worker/types.ts src/worker/DenoHTTPWorker.ts src/server/core/WorkerInstance.ts
git commit -m "feat(bg-tasks): add type definitions for background task support"
```

---

### Task 2: Create Test Fixtures

**Files:**
- Create: `src/test/functions/background-task/index.ts`
- Create: `src/test/functions/background-task-slow/index.ts`
- Create: `src/test/functions/background-task-error/index.ts`

- [ ] **Step 1: Create basic background task fixture**

`src/test/functions/background-task/index.ts`:

```typescript
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

Deno.serve((req: Request) => {
  const url = new URL(req.url);

  if (url.pathname.endsWith("/background")) {
    EdgeRuntime.waitUntil(
      new Promise<void>((resolve) => setTimeout(resolve, 500)).then(() => {
        console.log("BACKGROUND_TASK_DONE");
      })
    );
    return new Response("accepted");
  }

  return new Response("ok");
});
```

- [ ] **Step 2: Create slow background task fixture (for timeout testing)**

`src/test/functions/background-task-slow/index.ts`:

```typescript
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

Deno.serve((_req: Request) => {
  EdgeRuntime.waitUntil(
    new Promise<void>((resolve) => setTimeout(resolve, 60_000)).then(() => {
      console.log("SLOW_TASK_DONE");
    })
  );
  return new Response("accepted");
});
```

- [ ] **Step 3: Create error background task fixture**

`src/test/functions/background-task-error/index.ts`:

```typescript
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

Deno.serve((_req: Request) => {
  EdgeRuntime.waitUntil(
    Promise.reject(new Error("background task failed"))
  );
  return new Response("accepted");
});
```

- [ ] **Step 4: Commit**

```bash
git add src/test/functions/background-task/ src/test/functions/background-task-slow/ src/test/functions/background-task-error/
git commit -m "test(bg-tasks): add test fixtures for background task scenarios"
```

---

### Task 3: Bootstrap serve.ts — Add EdgeRuntime.waitUntil

**Files:**
- Modify: `deno-bootstrap/serve.ts`

- [ ] **Step 1: Add EdgeRuntime.waitUntil global and stderr notification**

Add this block at the top of `deno-bootstrap/serve.ts`, before the `const socketFile = Deno.args[0];` line:

```typescript
// --- Background task support ---
const _bgPendingTasks = new Set<Promise<unknown>>();
const _bgEncoder = new TextEncoder();

function _bgNotifyHost(event: string): void {
  try {
    Deno.stderr.writeSync(
      _bgEncoder.encode(`\x00BG:{"event":"${event}"}\n`)
    );
  } catch {
    // Ignore write errors (process shutting down)
  }
}

(globalThis as Record<string, unknown>).EdgeRuntime = {
  waitUntil(promise: Promise<unknown>): void {
    if (!promise || typeof (promise as Promise<unknown>).then !== "function") {
      return;
    }
    _bgPendingTasks.add(promise);
    _bgNotifyHost("started");
    promise
      .catch((err: unknown) => {
        console.error("Background task failed:", err);
      })
      .finally(() => {
        _bgPendingTasks.delete(promise);
        _bgNotifyHost("complete");
      });
  },
};
```

- [ ] **Step 2: Update SIGINT handler to await background tasks**

Replace the existing SIGINT handler:

```typescript
// Old:
Deno.addSignalListener("SIGINT", async () => {
  await server.shutdown();
});

// New:
Deno.addSignalListener("SIGINT", async () => {
  if (_bgPendingTasks.size > 0) {
    await Promise.allSettled([..._bgPendingTasks]);
  }
  await server.shutdown();
});
```

- [ ] **Step 3: Commit**

```bash
git add deno-bootstrap/serve.ts
git commit -m "feat(bg-tasks): add EdgeRuntime.waitUntil to serve.ts bootstrap"
```

---

### Task 4: Bootstrap index.ts — Add EdgeRuntime.waitUntil

**Files:**
- Modify: `deno-bootstrap/index.ts`

- [ ] **Step 1: Add EdgeRuntime.waitUntil global and stderr notification**

Add the same background task block at the top of `deno-bootstrap/index.ts`, before `const socketFile = Deno.args[0];`:

```typescript
// --- Background task support ---
const _bgPendingTasks = new Set<Promise<unknown>>();
const _bgEncoder = new TextEncoder();

function _bgNotifyHost(event: string): void {
  try {
    Deno.stderr.writeSync(
      _bgEncoder.encode(`\x00BG:{"event":"${event}"}\n`)
    );
  } catch {
    // Ignore write errors (process shutting down)
  }
}

(globalThis as Record<string, unknown>).EdgeRuntime = {
  waitUntil(promise: Promise<unknown>): void {
    if (!promise || typeof (promise as Promise<unknown>).then !== "function") {
      return;
    }
    _bgPendingTasks.add(promise);
    _bgNotifyHost("started");
    promise
      .catch((err: unknown) => {
        console.error("Background task failed:", err);
      })
      .finally(() => {
        _bgPendingTasks.delete(promise);
        _bgNotifyHost("complete");
      });
  },
};
```

- [ ] **Step 2: Update SIGINT handler to await background tasks**

Replace the existing SIGINT handler:

```typescript
// Old:
Deno.addSignalListener("SIGINT", async () => {
  await server.shutdown();
});

// New:
Deno.addSignalListener("SIGINT", async () => {
  if (_bgPendingTasks.size > 0) {
    await Promise.allSettled([..._bgPendingTasks]);
  }
  await server.shutdown();
});
```

- [ ] **Step 3: Commit**

```bash
git add deno-bootstrap/index.ts
git commit -m "feat(bg-tasks): add EdgeRuntime.waitUntil to index.ts bootstrap"
```

---

## Chunk 2: Host-Side Parsing & Worker Tests

### Task 5: Factory stderr Parsing

**Files:**
- Modify: `src/worker/factory.ts`

The key change: always set up a readline on stderr (currently conditional on log level), intercept `\x00BG:` prefixed lines, and route them to callbacks. Non-BG lines go to the existing log handler.

- [ ] **Step 1: Refactor stderr readline to always parse, with event queuing**

In `src/worker/factory.ts`, replace the conditional stderr readline block (lines 232-235).

The key challenge: BG messages can arrive before the `DenoHTTPWorkerImpl` is constructed (readline starts consuming immediately, but worker is created after socket file appears). Solution: queue early messages and flush them after worker creation.

```typescript
// OLD:
if (shouldLog(effectiveLogLevel, "warn")) {
  readline.createInterface({ input: stderr }).on("line", (line) => {
    logHandler("warn", "stderr", line);
  });
}

// NEW:
let bgWorkerRef: DenoHTTPWorkerImpl | undefined;
const bgEarlyQueue: Array<{ event: string }> = [];

readline.createInterface({ input: stderr }).on("line", (line) => {
  // Intercept background task control messages
  if (line.startsWith("\x00BG:")) {
    try {
      const payload = JSON.parse(line.slice(4));
      if (payload.event === "started" || payload.event === "complete") {
        if (bgWorkerRef) {
          if (payload.event === "started") {
            bgWorkerRef.incrementBackgroundTasks();
          } else {
            bgWorkerRef.decrementBackgroundTasks();
          }
          _options.onBackgroundTaskStarted && payload.event === "started" && _options.onBackgroundTaskStarted();
          _options.onBackgroundTaskComplete && payload.event === "complete" && _options.onBackgroundTaskComplete();
        } else {
          bgEarlyQueue.push(payload);
        }
      }
    } catch {
      // Ignore malformed BG messages
    }
    return;
  }
  // Normal log handling
  if (shouldLog(effectiveLogLevel, "warn")) {
    logHandler("warn", "stderr", line);
  }
});
```

- [ ] **Step 2: Set worker ref and flush early queue after worker creation**

After `worker = new DenoHTTPWorkerImpl(...)` (around line 251), add:

```typescript
bgWorkerRef = worker as DenoHTTPWorkerImpl;
// Flush any BG messages that arrived before worker was constructed
for (const msg of bgEarlyQueue) {
  if (msg.event === "started") {
    bgWorkerRef.incrementBackgroundTasks();
    _options.onBackgroundTaskStarted?.();
  } else if (msg.event === "complete") {
    bgWorkerRef.decrementBackgroundTasks();
    _options.onBackgroundTaskComplete?.();
  }
}
bgEarlyQueue.length = 0;
```

- [ ] **Step 3: Commit**

```bash
git add src/worker/factory.ts
git commit -m "feat(bg-tasks): parse stderr for background task messages in factory"
```

---

### Task 6: Worker-Level Background Task Tests

**Files:**
- Create: `src/test/worker/background-task.test.ts`
- Modify: `src/test/helpers/fixtures.ts` (add fixture paths)

- [ ] **Step 1: Add fixture paths to test helpers**

In `src/test/helpers/fixtures.ts`, add path constants for the new fixtures:

```typescript
export const BG_TASK_DIR = path.join(FUNCTIONS_DIR, "background-task");
export const BG_TASK_SLOW_DIR = path.join(FUNCTIONS_DIR, "background-task-slow");
export const BG_TASK_ERROR_DIR = path.join(FUNCTIONS_DIR, "background-task-error");
```

- [ ] **Step 2: Write failing tests**

`src/test/worker/background-task.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { newDenoHTTPWorker, type DenoHTTPWorker } from "../../worker/index.js";
import { SERVE_BOOTSTRAP } from "../helpers/fixtures.js";
import { jsonRequest } from "../helpers/worker.js";
import path from "node:path";

const FUNCTIONS_DIR = path.resolve(
  import.meta.dirname!,
  "../functions"
);
const BG_TASK_ENTRY = path.join(FUNCTIONS_DIR, "background-task", "index.ts");

describe("Background Tasks", () => {
  let worker: DenoHTTPWorker;

  afterEach(() => {
    worker?.terminate();
  });

  it("response returns before background task completes", async () => {
    let bgStarted = false;
    let bgComplete = false;

    worker = await newDenoHTTPWorker(new URL(`file://${BG_TASK_ENTRY}`), {
      denoBootstrapScriptPath: SERVE_BOOTSTRAP,
      onBackgroundTaskStarted: () => { bgStarted = true; },
      onBackgroundTaskComplete: () => { bgComplete = true; },
    });

    const { body } = await jsonRequest(worker, "/background");
    expect(body).toBe("accepted");
    expect(bgStarted).toBe(true);
    // Task is 500ms, response should return before it completes
    expect(bgComplete).toBe(false);

    // Wait for background task to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    expect(bgComplete).toBe(true);
  }, 10_000);

  it("tracks backgroundTaskCount on worker", async () => {
    worker = await newDenoHTTPWorker(new URL(`file://${BG_TASK_ENTRY}`), {
      denoBootstrapScriptPath: SERVE_BOOTSTRAP,
    });

    expect(worker.backgroundTaskCount).toBe(0);

    await jsonRequest(worker, "/background");
    // Task started but not yet complete (500ms delay)
    expect(worker.backgroundTaskCount).toBe(1);

    // Wait for completion
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    expect(worker.backgroundTaskCount).toBe(0);
  }, 10_000);

  it("handles rejected background task without crashing", async () => {
    const BG_ERROR_ENTRY = path.join(FUNCTIONS_DIR, "background-task-error", "index.ts");
    let bgComplete = false;

    worker = await newDenoHTTPWorker(new URL(`file://${BG_ERROR_ENTRY}`), {
      denoBootstrapScriptPath: SERVE_BOOTSTRAP,
      onBackgroundTaskComplete: () => { bgComplete = true; },
    });

    const { body } = await jsonRequest(worker, "/");
    expect(body).toBe("accepted");

    // Wait for rejection to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(bgComplete).toBe(true);
    expect(worker.backgroundTaskCount).toBe(0);
  }, 10_000);

  it("ignores non-promise arguments to waitUntil", async () => {
    // The basic fixture's "/" path doesn't call waitUntil
    worker = await newDenoHTTPWorker(new URL(`file://${BG_TASK_ENTRY}`), {
      denoBootstrapScriptPath: SERVE_BOOTSTRAP,
    });

    const { body } = await jsonRequest(worker, "/");
    expect(body).toBe("ok");
    expect(worker.backgroundTaskCount).toBe(0);
  }, 10_000);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/test/worker/background-task.test.ts`
Expected: FAIL — `backgroundTaskCount` not on interface, `onBackgroundTaskStarted` not on options

- [ ] **Step 4: Verify tests pass after previous implementation steps**

Run: `npx vitest run src/test/worker/background-task.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/test/worker/background-task.test.ts src/test/helpers/fixtures.ts
git commit -m "test(bg-tasks): add worker-level background task tests"
```

---

## Chunk 3: Lifecycle Manager Integration

### Task 7: WorkerLifecycleManager — Background Task Tracking & Idle Timer

**Files:**
- Modify: `src/server/core/WorkerLifecycleManager.ts`

- [ ] **Step 1: Add background task tracking fields and constructor option**

Add to `WorkerLifecycleManagerOptions`:

```typescript
  backgroundTaskKeepsAlive?: boolean;
  backgroundTaskTimeout?: number;
```

Add private fields to `WorkerLifecycleManager`:

```typescript
  #bgTaskCounts: Map<string, number> = new Map();
  #bgTimeoutTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  #backgroundTaskKeepsAlive: boolean;
  #backgroundTaskTimeout?: number;
```

In the constructor, initialize:

```typescript
  this.#backgroundTaskKeepsAlive = options.backgroundTaskKeepsAlive ?? true;
  this.#backgroundTaskTimeout = options.backgroundTaskTimeout;
```

- [ ] **Step 2: Add increment/decrement/get methods**

```typescript
  incrementBackgroundTasks(instanceId: string): void {
    const current = this.#bgTaskCounts.get(instanceId) ?? 0;
    this.#bgTaskCounts.set(instanceId, current + 1);

    if (this.#backgroundTaskKeepsAlive) {
      const instance = this.#findInstance(instanceId);
      if (instance) {
        this.#clearIdleTimer(instance);
      }
    }
  }

  decrementBackgroundTasks(instanceId: string): void {
    const current = this.#bgTaskCounts.get(instanceId) ?? 0;
    const next = Math.max(0, current - 1);
    this.#bgTaskCounts.set(instanceId, next);

    if (next === 0) {
      // Clear background task timeout timer
      this.#clearBgTimeoutTimer(instanceId);

      if (this.#backgroundTaskKeepsAlive) {
        const instance = this.#findInstance(instanceId);
        if (instance && instance.activeRequests === 0 && this.#shouldStartIdleTimer(instanceId)) {
          this.#startIdleTimer(instance);
        }
      }
    }
  }

  getBackgroundTaskCount(instanceId: string): number {
    return this.#bgTaskCounts.get(instanceId) ?? 0;
  }
```

- [ ] **Step 3: Add helper to check if idle timer should start**

```typescript
  #shouldStartIdleTimer(instanceId: string): boolean {
    if (this.#backgroundTaskKeepsAlive && this.getBackgroundTaskCount(instanceId) > 0) {
      return false;
    }
    if (this.#websocketKeepsAlive && this.getWebSocketCount(instanceId) > 0) {
      return false;
    }
    return true;
  }
```

- [ ] **Step 4: Update `#startIdleTimer` to check background tasks**

In `#startIdleTimer`, add a check after the WebSocket check:

```typescript
  #startIdleTimer(instance: WorkerInstance): void {
    if (this.#idleTimeout === undefined || this.#idleTimeout <= 0) return;
    // Don't start idle timer if WebSocket connections are keeping the worker alive
    if (this.#websocketKeepsAlive && this.getWebSocketCount(instance.id) > 0) {
      return;
    }
    // Don't start idle timer if background tasks are keeping the worker alive
    if (this.#backgroundTaskKeepsAlive && this.getBackgroundTaskCount(instance.id) > 0) {
      return;
    }
    this.#clearIdleTimer(instance);
    // ... rest unchanged
```

- [ ] **Step 5: Update `decrementActiveRequests` to start bg timeout**

After the existing `decrementActiveRequests` logic, add background task timeout start:

```typescript
  decrementActiveRequests(id: string): void {
    const instance = this.#findInstance(id);
    if (!instance) return;
    instance.activeRequests = Math.max(0, instance.activeRequests - 1);
    if (instance.activeRequests === 0) {
      // Start bg task timeout if tasks pending and no active requests
      if (this.getBackgroundTaskCount(id) > 0) {
        this.#startBgTimeoutTimer(id);
      }
      this.#startIdleTimer(instance);
    }
  }
```

- [ ] **Step 6: Add background task timeout timer methods**

```typescript
  #startBgTimeoutTimer(instanceId: string): void {
    if (this.#backgroundTaskTimeout === undefined || this.#backgroundTaskTimeout <= 0) return;
    this.#clearBgTimeoutTimer(instanceId);

    const timer = setTimeout(() => {
      this.#bgTimeoutTimers.delete(instanceId);
      if (this.getBackgroundTaskCount(instanceId) > 0) {
        console.warn(
          `[edge] "${this.#functionName}": background task timeout (${this.#backgroundTaskTimeout}ms) exceeded with ${this.getBackgroundTaskCount(instanceId)} pending task(s), terminating worker ${instanceId}`
        );
        this.removeInstance(instanceId);
      }
    }, this.#backgroundTaskTimeout);

    this.#bgTimeoutTimers.set(instanceId, timer);
  }

  #clearBgTimeoutTimer(instanceId: string): void {
    const timer = this.#bgTimeoutTimers.get(instanceId);
    if (timer) {
      clearTimeout(timer);
      this.#bgTimeoutTimers.delete(instanceId);
    }
  }
```

- [ ] **Step 7: Update `incrementActiveRequests` to clear bg timeout**

When a new request arrives, pause the bg timeout:

```typescript
  incrementActiveRequests(id: string): void {
    const instance = this.#findInstance(id);
    if (!instance) return;
    this.#clearIdleTimer(instance);
    this.#clearBgTimeoutTimer(id);  // Pause bg timeout during active request
    instance.activeRequests++;
    instance.totalRequests++;
  }
```

- [ ] **Step 8: Add gracefulDispose method**

```typescript
  async gracefulDispose(timeout?: number): Promise<void> {
    const effectiveTimeout = timeout ?? this.#backgroundTaskTimeout ?? 30_000;

    // Wait for all instances to drain background tasks
    const drainPromises = this.#instances
      .filter((i) => this.getBackgroundTaskCount(i.id) > 0)
      .map((i) => this.#waitForBackgroundTasks(i.id, effectiveTimeout));

    if (drainPromises.length > 0) {
      await Promise.allSettled(drainPromises);
    }

    // Hard dispose remaining
    this.dispose();
  }

  #waitForBackgroundTasks(instanceId: string, timeout: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.getBackgroundTaskCount(instanceId) === 0) {
        resolve();
        return;
      }

      const timeoutId = setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, timeout);

      const checkInterval = setInterval(() => {
        if (this.getBackgroundTaskCount(instanceId) === 0) {
          clearTimeout(timeoutId);
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
    });
  }
```

- [ ] **Step 9: Update `dispose` to clean up bg state**

In the existing `dispose()` method, add cleanup:

```typescript
  dispose(): void {
    this.#generation++;
    const instances = this.#instances;
    this.#instances = [];

    const resolvers = this.#spawnResolvers;
    this.#spawnResolvers = [];
    this.#spawningCount = 0;
    this.#wsConnectionCounts.clear();
    this.#bgTaskCounts.clear();  // ADD
    // Clear all bg timeout timers  // ADD
    for (const timer of this.#bgTimeoutTimers.values()) {  // ADD
      clearTimeout(timer);  // ADD
    }  // ADD
    this.#bgTimeoutTimers.clear();  // ADD
    for (const resolve of resolvers) {
      resolve();
    }
    // ... rest unchanged
```

- [ ] **Step 10: Update `getStats` to include background task counts**

```typescript
  getStats(): PoolStats {
    const now = Date.now();
    const instances: InstanceStats[] = this.#instances.map((i) => ({
      id: i.id,
      activeRequests: i.activeRequests,
      totalRequests: i.totalRequests,
      uptimeMs: now - i.spawnTime,
      backgroundTaskCount: this.getBackgroundTaskCount(i.id),  // ADD
    }));

    return {
      functionName: this.#functionName,
      instanceCount: this.#instances.length,
      totalRequests: this.#instances.reduce((sum, i) => sum + i.totalRequests, 0),
      activeRequests: this.#instances.reduce((sum, i) => sum + i.activeRequests, 0),
      totalBackgroundTasks: this.#instances.reduce(  // ADD
        (sum, i) => sum + this.getBackgroundTaskCount(i.id), 0  // ADD
      ),  // ADD
      restartCount: this.#restartCount,
      instances,
    };
  }
```

- [ ] **Step 11: Update `removeInstance` to clean up bg state**

In `removeInstance`, add before the splice:

```typescript
    this.#bgTaskCounts.delete(id);
    this.#clearBgTimeoutTimer(id);
```

- [ ] **Step 12: Commit**

```bash
git add src/server/core/WorkerLifecycleManager.ts
git commit -m "feat(bg-tasks): add background task tracking to WorkerLifecycleManager"
```

---

### Task 8: WorkerLifecycleManager Unit Tests

**Files:**
- Create: `src/test/server/background-task.test.ts`

- [ ] **Step 1: Write lifecycle manager background task tests**

`src/test/server/background-task.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import { httpRequest } from "../helpers/http.js";
import path from "node:path";

const FUNCTIONS_DIR = path.resolve(import.meta.dirname!, "../functions");

describe("Background Tasks - Server", () => {
  let server: EdgeFunctionServer;

  afterEach(async () => {
    await server?.stop();
  });

  it("response returns before background task completes", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const start = Date.now();
    const response = await httpRequest(server.port, "/background-task/background");
    const elapsed = Date.now() - start;

    expect(response.status).toBe(200);
    // Response should return well before the 500ms bg task
    expect(elapsed).toBeLessThan(400);
  }, 10_000);

  it("background task timeout terminates worker", async () => {
    const onCold = vi.fn();
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      backgroundTaskTimeout: 500,
      onFunctionCold: onCold,
    });
    await server.start();

    await httpRequest(server.port, "/background-task-slow/");

    // Wait for timeout to fire (500ms) + buffer
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    expect(onCold).toHaveBeenCalledWith("background-task-slow");
  }, 10_000);

  it("backgroundTaskKeepsAlive prevents idle timeout", async () => {
    const onCold = vi.fn();
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 200,
      backgroundTaskKeepsAlive: true,
      backgroundTaskTimeout: 5000,
      onFunctionCold: onCold,
    });
    await server.start();

    await httpRequest(server.port, "/background-task/background");

    // Idle timeout is 200ms, but bg task (500ms) keeps worker alive
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(onCold).not.toHaveBeenCalled();

    // After bg task completes (500ms), idle timer starts, then fires at +200ms
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    expect(onCold).toHaveBeenCalledWith("background-task");
  }, 10_000);

  it("backgroundTaskKeepsAlive=false allows idle timeout during bg task", async () => {
    const onCold = vi.fn();
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 200,
      backgroundTaskKeepsAlive: false,
      backgroundTaskTimeout: 5000,
      minWorkers: 0,
      onFunctionCold: onCold,
    });
    await server.start();

    await httpRequest(server.port, "/background-task/background");

    // With keepsAlive=false, idle timer fires despite pending bg task
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(onCold).toHaveBeenCalledWith("background-task");
  }, 10_000);

  it("rejected background task does not crash worker", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const response = await httpRequest(server.port, "/background-task-error/");
    expect(response.status).toBe(200);

    // Worker should still be responsive after rejected bg task
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const response2 = await httpRequest(server.port, "/background-task-error/");
    expect(response2.status).toBe(200);
  }, 10_000);

  it("graceful shutdown waits for background tasks", async () => {
    let bgComplete = false;
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      backgroundTaskTimeout: 5000,
      workerOptions: {
        onBackgroundTaskComplete: () => { bgComplete = true; },
      },
    });
    await server.start();

    await httpRequest(server.port, "/background-task/background");
    // Background task is 500ms — stop() should wait for it
    const stopPromise = server.stop();

    // Give a moment for drain to start
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    // Task should not yet be complete
    expect(bgComplete).toBe(false);

    await stopPromise;
    // After stop() resolves, bg task should have completed
    expect(bgComplete).toBe(true);
  }, 10_000);

  it("background task counts appear in worker stats", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      backgroundTaskTimeout: 5000,
    });
    await server.start();

    await httpRequest(server.port, "/background-task/background");

    const stats = server.getWorkerStats("background-task");
    expect(stats.totalRequests).toBe(1);
  }, 10_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/test/server/background-task.test.ts`
Expected: FAIL — options not wired through yet

- [ ] **Step 3: Commit test file**

```bash
git add src/test/server/background-task.test.ts
git commit -m "test(bg-tasks): add server-level background task tests"
```

---

## Chunk 4: WorkerPool, EdgeFunctionServer & Final Wiring

### Task 9: WorkerPool — Wire Background Tasks

**Files:**
- Modify: `src/server/core/WorkerPool.ts`

- [ ] **Step 1: Pass background task callbacks in `#spawnWorker`**

In `#spawnWorker`, add callbacks to the `newDenoHTTPWorker` options:

```typescript
    return newDenoHTTPWorker(new URL(`file://${entrypoint}`), {
      ...userOptions,
      // ... existing options ...
      onBackgroundTaskStarted: () => {
        this.#managers.get(name)?.incrementBackgroundTasks(instanceId);
      },
      onBackgroundTaskComplete: () => {
        this.#managers.get(name)?.decrementBackgroundTasks(instanceId);
      },
    });
```

- [ ] **Step 2: Pass backgroundTaskKeepsAlive and backgroundTaskTimeout to lifecycle manager**

In `#getOrCreateManager`, add to the `WorkerLifecycleManager` constructor options:

```typescript
    const backgroundTaskTimeout =
      fnConfig?.backgroundTaskTimeout ?? this.#serverOptions.backgroundTaskTimeout ?? 30_000;
    const backgroundTaskKeepsAlive =
      fnConfig?.backgroundTaskKeepsAlive ?? this.#serverOptions.backgroundTaskKeepsAlive ?? true;

    manager = new WorkerLifecycleManager({
      functionName: name,
      // ... existing options ...
      backgroundTaskKeepsAlive,
      backgroundTaskTimeout,
    });
```

- [ ] **Step 3: Add `gracefulTerminateAll` method**

```typescript
  async gracefulTerminateAll(timeout?: number): Promise<void> {
    this.#disposed = true;
    const promises: Promise<void>[] = [];
    for (const manager of this.#managers.values()) {
      promises.push(manager.gracefulDispose(timeout));
    }
    await Promise.allSettled(promises);
    this.#managers.clear();
    this.#workerPromises.clear();
  }
```

- [ ] **Step 4: Commit**

```bash
git add src/server/core/WorkerPool.ts
git commit -m "feat(bg-tasks): wire background task events through WorkerPool"
```

---

### Task 10: EdgeFunctionServer — Wire Options & Graceful Stop

**Files:**
- Modify: `src/server/core/EdgeFunctionServer.ts`

- [ ] **Step 1: Update `stop()` to use graceful shutdown**

Replace the existing `stop()` method:

```typescript
  async stop(): Promise<void> {
    this.#fileWatcher?.stop();

    // Close all WebSocket connections before terminating workers
    for (const name of this.listFunctions()) {
      this.#wsProxyHandler.closeAllConnectionsForFunction(
        name,
        1001,
        "Going Away"
      );
    }

    this.#pool?.stopAllHealthChecks();

    // Graceful shutdown: wait for background tasks to drain before terminating
    if (this.#pool) {
      await this.#pool.gracefulTerminateAll(
        this.#options.backgroundTaskTimeout ?? 30_000
      );
    }

    // Clean up generated import map
    await this.#registry.cleanupImportMap();

    if (this.#server) {
      await this.#server.close();
      this.#server = undefined;
    }
  }
```

Note: No other changes needed in EdgeFunctionServer — `backgroundTaskTimeout` and `backgroundTaskKeepsAlive` flow from `EdgeFunctionServerOptions` through `WorkerPool.#serverOptions` to `WorkerLifecycleManager` automatically.

- [ ] **Step 2: Commit**

```bash
git add src/server/core/EdgeFunctionServer.ts
git commit -m "feat(bg-tasks): update EdgeFunctionServer.stop() for graceful bg task shutdown"
```

---

### Task 11: Run All Tests & Fix Issues

- [ ] **Step 1: Run worker-level background task tests**

Run: `npx vitest run src/test/worker/background-task.test.ts`
Expected: All PASS

- [ ] **Step 2: Run server-level background task tests**

Run: `npx vitest run src/test/server/background-task.test.ts`
Expected: All PASS

- [ ] **Step 3: Run full test suite to verify no regressions**

Run: `npm test`
Expected: All existing tests PASS, all new tests PASS

- [ ] **Step 4: Fix any failing tests**

If tests fail, debug and fix. Common issues:
- Timing-sensitive tests: adjust timeouts/delays
- Missing imports: ensure all new exports are re-exported from index files
- Type errors: ensure all interface changes compile

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(bg-tasks): complete background task support (phase 3)"
```

---

### Task 12: Update ROADMAP.md

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: Update Background Tasks status in ROADMAP**

Change the Background Tasks section from "Not started" to "Done" with implementation details:

```markdown
### Background Tasks

**Status:** Done

Supabase supports long-running background tasks that outlive the HTTP response (e.g., `EdgeRuntime.waitUntil()`).

- `EdgeRuntime.waitUntil(promise)` global API in both bootstrap layers
- Host notification via structured stderr messages (`\x00BG:` prefix)
- Background task count tracking per worker instance
- `backgroundTaskTimeout` option (global + per-function via `function.json`, default: 30s)
- `backgroundTaskKeepsAlive` option (global + per-function, default: true) — pauses idle timeout while tasks pending
- Graceful shutdown waits for background tasks to drain
- Worker terminated on background task timeout (consistent with `workerMaxDuration`)
```

- [ ] **Step 2: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: mark background tasks as done in roadmap"
```

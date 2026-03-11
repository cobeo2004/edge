# Cold/Warm Worker Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Git conventions:**
> - **Do NOT add `Co-Authored-By` trailers to any commit messages.**
> - **All work MUST be done on a feature branch, not on `main`.** Create `feat/cold-warm-lifecycle` from `main` before any changes (see Task 0).

**Goal:** Add idle timeout support so workers transition from warm (running) to cold (terminated) after a configurable period of inactivity, with per-function overrides via `function.json`.

**Architecture:** Idle tracking lives inline in `WorkerPool`, following the existing health-check pattern. Active request counts are tracked by `WorkerRequestHandler` calling `incrementActiveRequests`/`decrementActiveRequests` on the pool. When active requests hit zero, an idle timer starts; if a new request arrives before it fires, the timer resets. On timeout, the worker is terminated and `onFunctionCold` fires.

**Tech Stack:** TypeScript, Node.js, Vitest, Deno (test fixtures)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/permissions/types.ts` | Add `idleTimeout` to `FunctionConfig` |
| Modify | `src/permissions/config.ts` | Parse `idleTimeout` from `function.json` |
| Modify | `src/server/utils/types.ts` | Add `idleTimeout` and `onFunctionCold` to `EdgeFunctionServerOptions` |
| Modify | `src/server/core/WorkerPool.ts` | Add idle state maps, timer methods, active request tracking |
| Modify | `src/server/core/WorkerRequestHandler.ts` | Wrap requests with `incrementActiveRequests`/`decrementActiveRequests` |
| Verify | `src/server/core/EdgeFunctionServer.ts` | No changes needed — `terminateAll()` handles cleanup |
| Create | `src/test/server/idle-timeout.test.ts` | Tests for cold/warm lifecycle |

---

## Chunk 0: Branch Setup

### Task 0: Create feature branch

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout -b feat/cold-warm-lifecycle main
```

---

## Chunk 1: Types and Config

### Task 1: Add `idleTimeout` to `FunctionConfig`

**Files:**
- Modify: `src/permissions/types.ts:1-9`
- Modify: `src/permissions/config.ts:1-38`

- [ ] **Step 1: Update `FunctionConfig` type**

In `src/permissions/types.ts`, add the `idleTimeout` field:

```typescript
export interface FunctionConfig {
  /** Permission profile name or raw flags array */
  permissions?: string | string[];
  /** Whether this function requires auth (default: true when server auth is enabled) */
  auth?: boolean;
  /** Idle timeout in ms before worker goes cold. Overrides server-level idleTimeout */
  idleTimeout?: number;
}
```

- [ ] **Step 2: Parse `idleTimeout` from `function.json`**

In `src/permissions/config.ts`, inside `loadFunctionConfig()`, after the `auth` parsing block (after line 28), add:

```typescript
    if (typeof parsed.idleTimeout === "number" && parsed.idleTimeout > 0) {
      config.idleTimeout = parsed.idleTimeout;
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/permissions/types.ts src/permissions/config.ts
git commit -m "feat: add idleTimeout to FunctionConfig and function.json parser"
```

### Task 2: Add `idleTimeout` and `onFunctionCold` to `EdgeFunctionServerOptions`

**Files:**
- Modify: `src/server/utils/types.ts:1-93`

- [ ] **Step 1: Add new options**

In `src/server/utils/types.ts`, add after the `onWorkerUnhealthy` option (after line 77):

```typescript
  /** Idle timeout in ms. Worker terminates when idle for this duration. Disabled by default */
  idleTimeout?: number;
  /** Called when a worker is terminated due to idle timeout */
  onFunctionCold?: (name: string) => void;
```

- [ ] **Step 2: Commit**

```bash
git add src/server/utils/types.ts
git commit -m "feat: add idleTimeout and onFunctionCold to EdgeFunctionServerOptions"
```

---

## Chunk 2: WorkerPool Idle Logic

### Task 3: Add idle state tracking and timer methods to WorkerPool

**Files:**
- Modify: `src/server/core/WorkerPool.ts:1-359`

- [ ] **Step 1: Write the failing test for basic idle timeout**

Create `src/test/server/idle-timeout.test.ts`:

```typescript
import { afterEach, describe, expect, it } from "vitest";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import { httpRequest } from "../helpers/http.js";
import { FUNCTIONS_DIR } from "../helpers/fixtures.js";

describe("EdgeFunctionServer – idle timeout", { timeout: 30_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("worker goes cold after idle timeout", async () => {
    const coldFunctions: string[] = [];
    const readyFunctions: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 500,
      onFunctionCold: (name) => coldFunctions.push(name),
      onFunctionReady: (name) => readyFunctions.push(name),
    });
    await server.start();

    // Trigger worker spawn
    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(200);
    expect(readyFunctions).toContain("hello");

    // Wait for idle timeout to fire
    await new Promise((r) => setTimeout(r, 800));

    expect(coldFunctions).toContain("hello");

    // Next request should respawn the worker (cold start)
    readyFunctions.length = 0;
    const res2 = await httpRequest(server.port, "/hello");
    expect(res2.status).toBe(200);
    expect(readyFunctions).toContain("hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/server/idle-timeout.test.ts -v`
Expected: FAIL — `idleTimeout` option has no effect yet, `coldFunctions` will be empty.

- [ ] **Step 3: Add idle state maps to WorkerPool**

In `src/server/core/WorkerPool.ts`, add new state maps after the health check maps (after line 41):

```typescript
  // --- Idle timeout state (grouped for future WorkerLifecycleManager extraction) ---
  #activeRequests = new Map<string, number>();
  #idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
```

- [ ] **Step 4: Add `#resolveIdleTimeout` method**

Add after the `#resolveHealthCheckConfig` method (before the closing `}` of the class):

```typescript
  #resolveIdleTimeout(name: string): number | undefined {
    // Per-function override takes priority
    const fnConfig = this.#registry.getFunctionConfig(name);
    if (fnConfig?.idleTimeout !== undefined) {
      return fnConfig.idleTimeout;
    }
    // Fall back to server-level option
    return this.#serverOptions.idleTimeout;
  }
```

- [ ] **Step 5: Add idle timer methods**

Add after `#resolveIdleTimeout`:

```typescript
  #startIdleTimer(name: string): void {
    const timeout = this.#resolveIdleTimeout(name);
    if (timeout === undefined) return;

    this.#clearIdleTimer(name);

    const timer = setTimeout(() => {
      this.#idleTimers.delete(name);
      const worker = this.#workers.get(name);
      if (!worker) return;

      this.#stopHealthCheck(name);
      worker.terminate();
      this.#workers.delete(name);
      this.#serverOptions.onFunctionCold?.(name);
    }, timeout);

    this.#idleTimers.set(name, timer);
  }

  #clearIdleTimer(name: string): void {
    const timer = this.#idleTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.#idleTimers.delete(name);
    }
  }
```

- [ ] **Step 6: Add active request tracking methods**

Add as public methods after `getActiveWorkerNames()`:

```typescript
  incrementActiveRequests(name: string): void {
    this.#clearIdleTimer(name);
    this.#activeRequests.set(name, (this.#activeRequests.get(name) ?? 0) + 1);
  }

  decrementActiveRequests(name: string): void {
    const count = Math.max(0, (this.#activeRequests.get(name) ?? 0) - 1);
    this.#activeRequests.set(name, count);
    if (count === 0) {
      this.#startIdleTimer(name);
    }
  }
```

- [ ] **Step 7: Clear idle timer and reset active requests on worker exit**

In `getOrCreate()`, inside the worker `exit` event handler (line 77-80), add cleanup for both idle timer and active request count (a crash mid-request would leave a stale count):

```typescript
      worker.addEventListener("exit", () => {
        this.#clearIdleTimer(name);
        this.#activeRequests.delete(name);
        this.#stopHealthCheck(name);
        this.#workers.delete(name);
      });
```

- [ ] **Step 8: Clear idle timer and reset active requests in `restart()`**

In `restart()` (line 91), add cleanup before `this.#stopHealthCheck(name);`:

```typescript
  async restart(name: string): Promise<void> {
    this.#clearIdleTimer(name);
    this.#activeRequests.delete(name);
    this.#stopHealthCheck(name);
    const existing = this.#workers.get(name);
```

- [ ] **Step 9: Clear all idle timers in `terminateAll()` and add `clearAllIdleTimers()`**

Add a public method for clearing all idle timers:

```typescript
  clearAllIdleTimers(): void {
    for (const name of [...this.#idleTimers.keys()]) {
      this.#clearIdleTimer(name);
    }
  }
```

In `terminateAll()`, call it before clearing workers:

```typescript
  terminateAll(): void {
    this.clearAllIdleTimers();
    for (const worker of this.#workers.values()) {
      worker.terminate();
    }
    this.#workers.clear();
    this.#workerPromises.clear();
  }
```

- [ ] **Step 10: Run test to verify it still fails**

Run: `npx vitest run src/test/server/idle-timeout.test.ts -v`
Expected: Still FAIL — `WorkerRequestHandler` doesn't call `incrementActiveRequests`/`decrementActiveRequests` yet, so the idle timer never starts.

- [ ] **Step 11: Commit WorkerPool changes**

```bash
git add src/server/core/WorkerPool.ts src/test/server/idle-timeout.test.ts
git commit -m "feat: add idle timeout state and timer methods to WorkerPool"
```

---

## Chunk 3: Wire Up Request Handler and Server

### Task 4: Track active requests in WorkerRequestHandler

**Files:**
- Modify: `src/server/core/WorkerRequestHandler.ts:1-176`

- [ ] **Step 1: Add `incrementActiveRequests` call before request forwarding**

In the `middleware()` method, after the `this.#pool.incrementRequestCount(functionName);` call (line 55), add:

```typescript
      this.#pool.incrementActiveRequests(functionName);
```

- [ ] **Step 2: Add `decrementActiveRequests` in response completion paths**

The response completes in three places — we need to decrement in all of them:

**a)** In the `ReadableStream` `end` event handler (after `emitStats` on line 99), add:

```typescript
                  this.#pool.decrementActiveRequests(functionName);
```

But we need access to `this.#pool` inside the `ReadableStream` constructor. The closure already captures outer scope, but `start(controller)` uses a plain function. We need to capture `pool` and `functionName` in the closure.

Actually, looking at the code more carefully, `this.#pool` is already in the closure scope of the `middleware()` return function. The `ReadableStream` callbacks capture `functionName` via closure. But `this` changes inside `start()`. So we need to capture a reference.

Replace the response streaming section. After `let statsEmitted = false;` (line 85), wrap the stream handling:

In the `middleware()` method, add a local reference at the top of the returned async function (after line 20):

```typescript
      const pool = this.#pool;
```

Then in the stream's `end` handler (line 97-99), change to:

```typescript
                proxyRes.on("end", () => {
                  controller.close();
                  emitStats(statusCode, false);
                  pool.decrementActiveRequests(functionName);
                });
```

In the stream's `error` handler (line 100-102), change to:

```typescript
                proxyRes.on("error", (err) => {
                  emitStats(statusCode, false);
                  pool.decrementActiveRequests(functionName);
                  controller.error(err);
                });
```

**b)** In the `proxyReq.on("error")` handler (line 117-131), add decrement before the resolve:

```typescript
        proxyReq.on("error", (err) => {
          this.#options.onFunctionError?.(functionName, err);
          const timedOut = (err as any).code === "ERR_REQUEST_TIMEOUT";
          const status = timedOut ? 504 : 502;
          const errorMsg = timedOut
            ? "Request timed out"
            : "Worker request failed";
          this.#emitStats(functionName, startTime, status, timedOut);
          pool.decrementActiveRequests(functionName);
          resolve(
            new Response(JSON.stringify({ error: errorMsg }), {
              status,
              headers: { "Content-Type": "application/json" },
            })
          );
        });
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run src/test/server/idle-timeout.test.ts -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/core/WorkerRequestHandler.ts
git commit -m "feat: track active requests in WorkerRequestHandler for idle timeout"
```

### Task 5: Verify no EdgeFunctionServer changes needed

`terminateAll()` already calls `clearAllIdleTimers()` (added in Task 3 Step 9), and `EdgeFunctionServer.stop()` already calls `terminateAll()`. No additional changes needed in `EdgeFunctionServer.ts`.

- [ ] **Step 1: Run all existing tests to verify no regressions**

Run: `npx vitest run src/test/server/ -v`
Expected: All existing tests PASS

---

## Chunk 4: Additional Tests

### Task 6: Test worker stays warm during active requests

**Files:**
- Modify: `src/test/server/idle-timeout.test.ts`

- [ ] **Step 1: Write test for staying warm during requests**

Add to the `describe` block in `src/test/server/idle-timeout.test.ts`:

```typescript
  it("worker stays warm while requests are in-flight", async () => {
    const coldFunctions: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 300,
      onFunctionCold: (name) => coldFunctions.push(name),
    });
    await server.start();

    // Start a slow request that takes longer than idleTimeout
    const slowPromise = httpRequest(server.port, "/slow?delay=1000");

    // Wait past idle timeout while request is still in-flight
    await new Promise((r) => setTimeout(r, 500));
    expect(coldFunctions).not.toContain("slow");

    // Wait for request to complete
    const res = await slowPromise;
    expect(res.status).toBe(200);

    // Now wait for idle timeout after request completes
    await new Promise((r) => setTimeout(r, 500));
    expect(coldFunctions).toContain("slow");
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/test/server/idle-timeout.test.ts -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/test/server/idle-timeout.test.ts
git commit -m "test: worker stays warm during in-flight requests"
```

### Task 7: Test idle timer resets on new request

**Files:**
- Modify: `src/test/server/idle-timeout.test.ts`

- [ ] **Step 1: Write test for timer reset**

Add to the `describe` block:

```typescript
  it("idle timer resets on new request", async () => {
    const coldFunctions: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 500,
      onFunctionCold: (name) => coldFunctions.push(name),
    });
    await server.start();

    // First request
    await httpRequest(server.port, "/hello");

    // Wait 300ms (less than timeout), then send another request
    await new Promise((r) => setTimeout(r, 300));
    expect(coldFunctions).not.toContain("hello");
    await httpRequest(server.port, "/hello");

    // Wait another 300ms — would have been 600ms total, past original timeout
    await new Promise((r) => setTimeout(r, 300));
    expect(coldFunctions).not.toContain("hello");

    // Now wait for full idle timeout from last request
    await new Promise((r) => setTimeout(r, 400));
    expect(coldFunctions).toContain("hello");
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/test/server/idle-timeout.test.ts -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/test/server/idle-timeout.test.ts
git commit -m "test: idle timer resets on new request"
```

### Task 8: Test per-function `idleTimeout` override

**Files:**
- Create: `src/test/functions/idle-custom/index.ts`
- Create: `src/test/functions/idle-custom/function.json`
- Modify: `src/test/server/idle-timeout.test.ts`

- [ ] **Step 1: Create test fixture function**

Create `src/test/functions/idle-custom/index.ts`:

```typescript
Deno.serve((_req) => new Response("idle-custom"));
```

Create `src/test/functions/idle-custom/function.json`:

```json
{
  "idleTimeout": 200
}
```

- [ ] **Step 2: Write the test**

Add to the `describe` block:

```typescript
  it("per-function idleTimeout override from function.json", async () => {
    const coldFunctions: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 5000,
      onFunctionCold: (name) => coldFunctions.push(name),
    });
    await server.start();

    // idle-custom has idleTimeout: 200 in function.json (overrides server 5000ms)
    const res = await httpRequest(server.port, "/idle-custom");
    expect(res.status).toBe(200);

    // Wait past per-function timeout but well before server default
    await new Promise((r) => setTimeout(r, 500));
    expect(coldFunctions).toContain("idle-custom");
  });
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run src/test/server/idle-timeout.test.ts -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/test/functions/idle-custom/ src/test/server/idle-timeout.test.ts
git commit -m "test: per-function idleTimeout override via function.json"
```

### Task 9: Test `onFunctionCold` callback fires on idle termination

**Files:**
- Modify: `src/test/server/idle-timeout.test.ts`

- [ ] **Step 1: Write test**

Add to the `describe` block:

```typescript
  it("onFunctionCold callback fires with correct function name", async () => {
    const coldCalls: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 300,
      onFunctionCold: (name) => coldCalls.push(name),
    });
    await server.start();

    // Spawn two different functions
    await Promise.all([
      httpRequest(server.port, "/hello"),
      httpRequest(server.port, "/echo"),
    ]);

    // Wait for both to go cold
    await new Promise((r) => setTimeout(r, 600));

    expect(coldCalls.sort()).toEqual(["echo", "hello"]);
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/test/server/idle-timeout.test.ts -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/test/server/idle-timeout.test.ts
git commit -m "test: onFunctionCold fires for each idle function"
```

### Task 10: Test no idle timeout when not configured

**Files:**
- Modify: `src/test/server/idle-timeout.test.ts`

- [ ] **Step 1: Write test**

Add to the `describe` block:

```typescript
  it("no idle timeout when idleTimeout is not set", async () => {
    const coldFunctions: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      // idleTimeout intentionally omitted
      onFunctionCold: (name) => coldFunctions.push(name),
    });
    await server.start();

    await httpRequest(server.port, "/hello");

    // Wait a while — worker should stay warm
    await new Promise((r) => setTimeout(r, 500));
    expect(coldFunctions).toHaveLength(0);

    // Worker still responds (no respawn needed)
    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(200);
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/test/server/idle-timeout.test.ts -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/test/server/idle-timeout.test.ts
git commit -m "test: no idle timeout when not configured (preserves existing behavior)"
```

### Task 11: Test idle timeout + workerMaxDuration coexistence

**Files:**
- Modify: `src/test/server/idle-timeout.test.ts`

- [ ] **Step 1: Write test**

Add to the `describe` block:

```typescript
  it("idle timeout and workerMaxDuration are independent", async () => {
    const coldFunctions: string[] = [];
    const readyFunctions: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 300,
      workerMaxDuration: 10000,
      onFunctionCold: (name) => coldFunctions.push(name),
      onFunctionReady: (name) => readyFunctions.push(name),
    });
    await server.start();

    // Spawn worker
    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(200);

    // Idle timeout (300ms) should fire well before workerMaxDuration (10s)
    await new Promise((r) => setTimeout(r, 600));
    expect(coldFunctions).toContain("hello");

    // Worker should respawn on next request
    readyFunctions.length = 0;
    const res2 = await httpRequest(server.port, "/hello");
    expect(res2.status).toBe(200);
    expect(readyFunctions).toContain("hello");
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/test/server/idle-timeout.test.ts -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/test/server/idle-timeout.test.ts
git commit -m "test: idle timeout and workerMaxDuration coexist independently"
```

### Task 12: Test worker crash during idle timer

**Files:**
- Modify: `src/test/server/idle-timeout.test.ts`

- [ ] **Step 1: Write test**

Add to the `describe` block:

```typescript
  it("worker crash during idle timer causes no errors", async () => {
    const coldFunctions: string[] = [];
    const errors: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 2000,
      onFunctionCold: (name) => coldFunctions.push(name),
      onFunctionError: (name, err) => errors.push(`${name}: ${err.message}`),
    });
    await server.start();

    // Spawn worker
    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(200);

    // Force-restart the worker (simulates crash) while idle timer is pending
    await server.restartFunction("hello");

    // Wait past original idle timeout
    await new Promise((r) => setTimeout(r, 500));

    // onFunctionCold should NOT fire (worker was killed by restart, not idle)
    expect(coldFunctions).not.toContain("hello");

    // No errors should have occurred
    expect(errors).toHaveLength(0);

    // Worker should still work after restart
    const res2 = await httpRequest(server.port, "/hello");
    expect(res2.status).toBe(200);
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/test/server/idle-timeout.test.ts -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/test/server/idle-timeout.test.ts
git commit -m "test: worker crash during idle timer causes no errors"
```

### Task 13: Test eagerSpawn + idle timeout interaction

**Files:**
- Modify: `src/test/server/idle-timeout.test.ts`

- [ ] **Step 1: Write test**

Add to the `describe` block:

```typescript
  it("eagerly spawned workers go cold when idle", async () => {
    const coldFunctions: string[] = [];
    const readyFunctions: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      eagerSpawn: true,
      idleTimeout: 500,
      workerOptions: {
        runFlags: ["--allow-net", "--allow-env", "--allow-read"],
      },
      onFunctionReady: (name) => readyFunctions.push(name),
      onFunctionCold: (name) => coldFunctions.push(name),
    });
    await server.start();

    // Workers should be spawned eagerly
    expect(readyFunctions.length).toBeGreaterThan(0);

    // But no requests sent — all should go cold after idle timeout
    // Note: eagerSpawn calls getOrCreate which spawns workers but doesn't
    // call incrementActiveRequests, so idle timer starts immediately
    // after spawn since active requests = 0
    await new Promise((r) => setTimeout(r, 800));

    // At least one worker should have gone cold
    expect(coldFunctions.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run test — this will FAIL**

Run: `npx vitest run src/test/server/idle-timeout.test.ts -t "eagerly spawned" -v`
Expected: FAIL — `getOrCreate()` doesn't start idle timer after spawn when there are no active requests.

- [ ] **Step 3: Fix: Start idle timer after worker spawn in `getOrCreate()`**

In `WorkerPool.ts`, in `getOrCreate()`, after `this.#startHealthCheck(name, worker);` (line 83), add:

```typescript
      // Start idle timer if no active requests (e.g., eager spawn)
      if ((this.#activeRequests.get(name) ?? 0) === 0) {
        this.#startIdleTimer(name);
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/test/server/idle-timeout.test.ts -v`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run -v`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/core/WorkerPool.ts src/test/server/idle-timeout.test.ts
git commit -m "feat: start idle timer on eager spawn, add eagerSpawn+idle test"
```

---

## Chunk 5: Final Verification

### Task 14: Run full test suite and verify

- [ ] **Step 1: Run complete test suite**

Run: `npx vitest run -v`
Expected: All tests PASS including new idle-timeout tests and all existing tests.

- [ ] **Step 2: Run linter**

Run: `npm run lint` (or whatever the lint command is)
Expected: No lint errors

- [ ] **Step 3: Final commit if any formatting fixes needed**

```bash
git add -A
git commit -m "chore: lint and format"
```

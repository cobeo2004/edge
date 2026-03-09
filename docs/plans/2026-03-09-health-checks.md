# Health Checks Implementation Plan

**Goal:** Add periodic HTTP health-check pings to workers with auto-restart of unhealthy workers.

**Architecture:** `EdgeFunctionServer` manages per-worker health check timers. Each tick sends an HTTP GET to the worker's Unix socket. After N consecutive failures, the worker is terminated and immediately respawned. Config lives on both `DenoWorkerOptions` (carried as data) and `EdgeFunctionServerOptions` (server reads it and runs checks).

**Tech Stack:** Node.js `http` module (same Unix socket pattern as existing `warmRequest()`), TypeScript, Vitest.

---

### Task 1: Add health check options to DenoWorkerOptions

**Files:**
- Modify: `src/worker/types.ts`

**Step 1: Add the three health check fields to `DenoWorkerOptions`**

Add these three optional fields at the end of the `DenoWorkerOptions` interface in `src/worker/types.ts`:

```typescript
  /**
   * Interval in ms between health-check pings. Health checks are disabled
   * when not set. Only used by EdgeFunctionServer.
   */
  healthCheckInterval?: number;

  /**
   * Timeout in ms for each health-check ping. Defaults to 5000.
   * Only used by EdgeFunctionServer.
   */
  healthCheckTimeout?: number;

  /**
   * Number of consecutive health-check failures before the worker is
   * considered unhealthy and restarted. Defaults to 3.
   * Only used by EdgeFunctionServer.
   */
  healthCheckMaxFailures?: number;
```

**Step 2: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/worker/types.ts
git commit -m "feat: add health check options to DenoWorkerOptions"
```

---

### Task 2: Add health check options and callback to EdgeFunctionServerOptions

**Files:**
- Modify: `src/server/EdgeFunctionServer.ts`

**Step 1: Add health check fields and callback to `EdgeFunctionServerOptions`**

Add these four fields at the end of the `EdgeFunctionServerOptions` interface in `src/server/EdgeFunctionServer.ts`:

```typescript
  /** Interval in ms between health-check pings. Disabled when not set */
  healthCheckInterval?: number;
  /** Timeout in ms for each health-check ping. Defaults to 5000 */
  healthCheckTimeout?: number;
  /** Consecutive failures before auto-restart. Defaults to 3 */
  healthCheckMaxFailures?: number;
  /** Called when a worker is restarted due to failed health checks */
  onWorkerUnhealthy?: (name: string, consecutiveFailures: number) => void;
```

**Step 2: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/server/EdgeFunctionServer.ts
git commit -m "feat: add health check options to EdgeFunctionServerOptions"
```

---

### Task 3: Implement health check logic in EdgeFunctionServer

**Files:**
- Modify: `src/server/EdgeFunctionServer.ts`

**Step 1: Add private state for health check tracking**

Add these private fields to the `EdgeFunctionServer` class, after the existing `#restartCounts` field:

```typescript
  #healthCheckTimers = new Map<string, ReturnType<typeof setInterval>>();
  #healthCheckFailures = new Map<string, number>();
```

**Step 2: Add a `#healthCheckWorker` private method**

Add this method to `EdgeFunctionServer`, after the `#emitStats` method. It sends an HTTP GET to the worker's Unix socket with a timeout. This reuses the worker's existing `request()` method:

```typescript
  #resolveHealthCheckConfig(name: string): {
    interval: number;
    timeout: number;
    maxFailures: number;
  } | null {
    // Per-worker overrides take precedence over server-level
    const workerOpts = this.#options.workerOptions ?? {};
    const interval =
      workerOpts.healthCheckInterval ?? this.#options.healthCheckInterval;
    if (interval === undefined) return null;

    return {
      interval,
      timeout:
        workerOpts.healthCheckTimeout ??
        this.#options.healthCheckTimeout ??
        5000,
      maxFailures:
        workerOpts.healthCheckMaxFailures ??
        this.#options.healthCheckMaxFailures ??
        3,
    };
  }

  #startHealthCheck(name: string, worker: DenoHTTPWorker): void {
    const config = this.#resolveHealthCheckConfig(name);
    if (!config) return;

    this.#healthCheckFailures.set(name, 0);

    const timer = setInterval(async () => {
      const healthy = await new Promise<boolean>((resolve) => {
        const timeoutId = setTimeout(() => resolve(false), config.timeout);
        try {
          const req = worker.request(
            "http://deno/__health",
            { method: "GET" },
            (res) => {
              // Drain the response
              res.on("data", () => {});
              res.on("end", () => {
                clearTimeout(timeoutId);
                resolve(true);
              });
              res.on("error", () => {
                clearTimeout(timeoutId);
                resolve(false);
              });
            }
          );
          req.on("error", () => {
            clearTimeout(timeoutId);
            resolve(false);
          });
          req.end();
        } catch {
          clearTimeout(timeoutId);
          resolve(false);
        }
      });

      if (healthy) {
        this.#healthCheckFailures.set(name, 0);
        return;
      }

      const failures = (this.#healthCheckFailures.get(name) ?? 0) + 1;
      this.#healthCheckFailures.set(name, failures);

      if (failures >= config.maxFailures) {
        this.#stopHealthCheck(name);
        this.#options.onWorkerUnhealthy?.(name, failures);
        // Terminate and immediately respawn
        const existing = this.#workers.get(name);
        if (existing) {
          existing.terminate();
          this.#workers.delete(name);
        }
        this.#workerPromises.delete(name);
        if (this.#functions.has(name)) {
          this.#getOrCreateWorker(name).catch(() => {});
        }
      }
    }, config.interval);

    this.#healthCheckTimers.set(name, timer);
  }

  #stopHealthCheck(name: string): void {
    const timer = this.#healthCheckTimers.get(name);
    if (timer) {
      clearInterval(timer);
      this.#healthCheckTimers.delete(name);
    }
    this.#healthCheckFailures.delete(name);
  }
```

**Step 3: Wire health checks into worker lifecycle**

In the `#getOrCreateWorker` method, after the line `this.#options.onFunctionReady?.(name);`, add:

```typescript
      this.#startHealthCheck(name, worker);
```

Change the existing exit listener from:

```typescript
      worker.addEventListener("exit", () => {
        this.#workers.delete(name);
      });
```

to:

```typescript
      worker.addEventListener("exit", () => {
        this.#stopHealthCheck(name);
        this.#workers.delete(name);
      });
```

**Step 4: Wire health checks into `restartFunction`**

In the `restartFunction` method, add `this.#stopHealthCheck(name);` as the first line:

```typescript
  async restartFunction(name: string): Promise<void> {
    this.#stopHealthCheck(name);
    const existing = this.#workers.get(name);
    // ... rest unchanged
```

**Step 5: Wire health checks into `stop()`**

In the `stop()` method, after clearing debounce timers and before terminating workers, add:

```typescript
    for (const name of this.#healthCheckTimers.keys()) {
      this.#stopHealthCheck(name);
    }
```

**Step 6: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 7: Run existing tests to verify no regressions**

Run: `npm test`
Expected: All existing tests pass.

**Step 8: Commit**

```bash
git add src/server/EdgeFunctionServer.ts
git commit -m "feat: implement health check logic in EdgeFunctionServer"
```

---

### Task 4: Create unresponsive worker test fixture

**Files:**
- Create: `src/test/functions/unresponsive/index.ts`

**Step 1: Create a Deno function that becomes unresponsive after first request**

This fixture responds normally to the first request, then blocks the event loop on subsequent requests (simulating a frozen worker). We use a query parameter `?block=true` to trigger the freeze:

```typescript
let blocked = false;

Deno.serve((req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("block") === "true") {
    blocked = true;
    return new Response("blocking");
  }
  if (blocked) {
    // Synchronously block the event loop for 60 seconds
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      // busy-wait
    }
  }
  return new Response("ok");
});
```

**Step 2: Commit**

```bash
git add src/test/functions/unresponsive/index.ts
git commit -m "test: add unresponsive worker fixture for health checks"
```

---

### Task 5: Write health check tests

**Files:**
- Create: `src/test/server/health-checks.test.ts`

**Step 1: Write the test file**

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { EdgeFunctionServer } from "../../server/EdgeFunctionServer.js";
import { httpRequest } from "../helpers/http.js";
import { FUNCTIONS_DIR } from "../helpers/fixtures.js";

describe("EdgeFunctionServer – health checks", { timeout: 30_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("healthy worker: no restart, no callback", async () => {
    const unhealthyCalls: { name: string; failures: number }[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      healthCheckInterval: 100,
      healthCheckTimeout: 2000,
      healthCheckMaxFailures: 3,
      onWorkerUnhealthy: (name, failures) =>
        unhealthyCalls.push({ name, failures }),
    });
    await server.start();

    // Trigger worker spawn
    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(200);

    // Let a few health checks run
    await new Promise((r) => setTimeout(r, 500));

    expect(unhealthyCalls).toHaveLength(0);

    // Worker still responds
    const res2 = await httpRequest(server.port, "/hello");
    expect(res2.status).toBe(200);
  });

  it("unhealthy worker triggers onWorkerUnhealthy and respawns", async () => {
    const unhealthyCalls: { name: string; failures: number }[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      healthCheckInterval: 100,
      healthCheckTimeout: 200,
      healthCheckMaxFailures: 2,
      onWorkerUnhealthy: (name, failures) =>
        unhealthyCalls.push({ name, failures }),
    });
    await server.start();

    // Spawn the worker and make it block
    const res = await httpRequest(server.port, "/unresponsive");
    expect(res.status).toBe(200);

    // Trigger the block
    await httpRequest(server.port, "/unresponsive?block=true");

    // Wait for health checks to detect failure and restart
    // 2 failures × 100ms interval + 200ms timeout each = ~600ms, give extra margin
    await new Promise((r) => setTimeout(r, 2000));

    expect(unhealthyCalls.length).toBeGreaterThanOrEqual(1);
    expect(unhealthyCalls[0]!.name).toBe("unresponsive");
    expect(unhealthyCalls[0]!.failures).toBe(2);

    // Worker should have respawned — new requests should work
    const res2 = await httpRequest(server.port, "/unresponsive");
    expect(res2.status).toBe(200);
    expect(res2.body).toBe("ok");
  });

  it("no health checks when healthCheckInterval is not set", async () => {
    const unhealthyCalls: { name: string; failures: number }[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      // healthCheckInterval intentionally omitted
      onWorkerUnhealthy: (name, failures) =>
        unhealthyCalls.push({ name, failures }),
    });
    await server.start();

    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 300));
    expect(unhealthyCalls).toHaveLength(0);
  });

  it("getWorkerStats shows restart after unhealthy restart", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      healthCheckInterval: 100,
      healthCheckTimeout: 200,
      healthCheckMaxFailures: 2,
    });
    await server.start();

    // Spawn and block
    await httpRequest(server.port, "/unresponsive");
    await httpRequest(server.port, "/unresponsive?block=true");

    // Wait for restart
    await new Promise((r) => setTimeout(r, 2000));

    // Verify it respawned by making a request
    await httpRequest(server.port, "/unresponsive");

    const stats = server.getWorkerStats("unresponsive");
    expect(stats.restartCount).toBeGreaterThanOrEqual(1);
  });
});
```

**Step 2: Run the tests**

Run: `npx vitest run src/test/server/health-checks.test.ts`
Expected: All 4 tests pass.

**Step 3: Run the full test suite to verify no regressions**

Run: `npm test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add src/test/server/health-checks.test.ts
git commit -m "test: add health check tests for EdgeFunctionServer"
```

---

### Task 6: Update documentation

**Files:**
- Modify: `ROADMAP.md`
- Modify: `README.md` (if it documents config options)

**Step 1: Update the Health Checks section in ROADMAP.md**

Change the Health Checks section status from "Not started" to "Done" and update the description to match what was implemented:

```markdown
### Health Checks

**Status:** Done

Periodic HTTP health-check pings to detect frozen/unresponsive workers:
- `healthCheckInterval` — ms between pings (opt-in, disabled by default)
- `healthCheckTimeout` — ms to wait for response (default 5000)
- `healthCheckMaxFailures` — consecutive failures before restart (default 3)
- `onWorkerUnhealthy` callback fired when a worker is restarted
- All options available on both `DenoWorkerOptions` (worker-level) and `EdgeFunctionServerOptions` (server-level)
- Unhealthy workers are terminated and immediately respawned
```

**Step 2: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: document health checks in ROADMAP"
```

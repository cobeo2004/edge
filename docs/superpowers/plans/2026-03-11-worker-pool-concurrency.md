# Worker Pool / Concurrency Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow multiple Deno worker processes per function with auto-scaling, least-connections routing, per-worker idle scale-down, and WorkerLifecycleManager extraction.

**Architecture:** Extract lifecycle concerns from WorkerPool into WorkerLifecycleManager (one per function). Introduce WorkerInstance as per-instance state wrapper. WorkerPool becomes thin coordinator. Routing uses least-connections (lowest activeRequests). Scaling uses active request count + spawningCount coordination to prevent overshooting maxWorkers.

**Tech Stack:** TypeScript, Vitest, Node.js child_process (Deno subprocess spawning)

**Spec:** `docs/superpowers/specs/2026-03-11-worker-pool-concurrency-design.md`

**Branch:** Work on `feat/worker-pool-concurrency`, not `main`. Do NOT use `Co-Authored-By` in commits.

---

## Chunk 1: Configuration Layer + WorkerInstance Interface

### Task 1: Add minWorkers, maxWorkers, eagerSpawn to FunctionConfig

**Files:**
- Modify: `src/permissions/types.ts`
- Modify: `src/permissions/config.ts`
- Test: `src/test/server/config.test.ts` (existing, check if exists — otherwise add tests inline)

- [ ] **Step 1: Update FunctionConfig interface**

In `src/permissions/types.ts`, add three new optional fields:

```ts
export interface FunctionConfig {
  /** Permission profile name or raw flags array */
  permissions?: string | string[];
  /** Whether this function requires auth (default: true when server auth is enabled) */
  auth?: boolean;
  /** Idle timeout in ms before worker goes cold. Overrides server-level idleTimeout */
  idleTimeout?: number;
  /** Minimum number of worker instances for this function */
  minWorkers?: number;
  /** Maximum number of worker instances for this function */
  maxWorkers?: number;
  /** Whether to eagerly spawn workers for this function at startup */
  eagerSpawn?: boolean;
}
```

- [ ] **Step 2: Update config.ts to parse new fields**

In `src/permissions/config.ts`, add parsing after the `idleTimeout` block (line 30-32):

```ts
if (typeof parsed.minWorkers === "number" && parsed.minWorkers >= 0) {
  config.minWorkers = parsed.minWorkers;
}

if (typeof parsed.maxWorkers === "number" && parsed.maxWorkers >= 1) {
  config.maxWorkers = parsed.maxWorkers;
}

// Cross-validate: minWorkers <= maxWorkers
if (
  config.minWorkers !== undefined &&
  config.maxWorkers !== undefined &&
  config.minWorkers > config.maxWorkers
) {
  onError?.(
    new Error(
      `function.json: minWorkers (${config.minWorkers}) > maxWorkers (${config.maxWorkers}), ignoring both`
    )
  );
  delete config.minWorkers;
  delete config.maxWorkers;
}

if (typeof parsed.eagerSpawn === "boolean") {
  config.eagerSpawn = parsed.eagerSpawn;
}
```

- [ ] **Step 3: Run existing tests to verify no regression**

Run: `npx vitest run src/test/`
Expected: All tests pass (no changes to behavior)

- [ ] **Step 4: Commit**

```bash
git add src/permissions/types.ts src/permissions/config.ts
git commit -m "feat: add minWorkers, maxWorkers, eagerSpawn to FunctionConfig"
```

---

### Task 2: Add minWorkers, maxWorkers to EdgeFunctionServerOptions

**Files:**
- Modify: `src/server/utils/types.ts`

- [ ] **Step 1: Add new options**

In `src/server/utils/types.ts`, add after the `idleTimeout` option (line 79):

```ts
/** Minimum worker instances per function. Default: 0 (can scale to cold) */
minWorkers?: number;
/** Maximum worker instances per function. Default: 1 (backward-compatible single worker) */
maxWorkers?: number;
```

- [ ] **Step 2: Run tests to verify no regression**

Run: `npx vitest run src/test/`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/server/utils/types.ts
git commit -m "feat: add minWorkers, maxWorkers to EdgeFunctionServerOptions"
```

---

### Task 3: Create WorkerInstance interface

**Files:**
- Create: `src/server/core/WorkerInstance.ts`

- [ ] **Step 1: Create the WorkerInstance file**

```ts
import type { DenoHTTPWorker } from "../../worker/index.js";

export interface WorkerInstance {
  /** Unique ID: "{functionName}-{counter}" */
  id: string;
  /** Function this instance belongs to */
  functionName: string;
  /** Underlying Deno worker process */
  worker: DenoHTTPWorker;
  /** Number of currently active (in-flight) requests */
  activeRequests: number;
  /** Lifetime total request count */
  totalRequests: number;
  /** Timestamp when this instance was spawned */
  spawnTime: number;
  /** Per-instance idle timer (scale-down) */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Per-instance health check interval */
  healthCheckTimer?: ReturnType<typeof setInterval>;
  /** Consecutive health check failures */
  healthCheckFailures: number;
  /** Whether a health check is currently in-flight */
  healthCheckInFlight: boolean;
}

export type AcquireResult =
  | { kind: "instance"; instance: WorkerInstance }
  | { kind: "spawn" }
  | { kind: "wait"; promise: Promise<void> };

export interface PoolStats {
  functionName: string;
  instanceCount: number;
  totalRequests: number;
  activeRequests: number;
  restartCount: number;
  instances: InstanceStats[];
}

export interface InstanceStats {
  id: string;
  activeRequests: number;
  totalRequests: number;
  uptimeMs: number;
}

export function createWorkerInstance(
  id: string,
  functionName: string,
  worker: DenoHTTPWorker
): WorkerInstance {
  return {
    id,
    functionName,
    worker,
    activeRequests: 0,
    totalRequests: 0,
    spawnTime: Date.now(),
    healthCheckFailures: 0,
    healthCheckInFlight: false,
  };
}
```

- [ ] **Step 2: Run lint**

Run: `npx biome check src/server/core/WorkerInstance.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/server/core/WorkerInstance.ts
git commit -m "feat: create WorkerInstance interface and types"
```

---

### Task 4: Create test fixtures

**Files:**
- Create: `src/test/functions/pool-test/index.ts`
- Create: `src/test/functions/pool-test/function.json`
- Create: `src/test/functions/eager-override/index.ts`
- Create: `src/test/functions/eager-override/function.json`

- [ ] **Step 1: Create pool-test fixture**

`src/test/functions/pool-test/index.ts`:
```ts
Deno.serve((_req) => new Response("pool-test"));
```

`src/test/functions/pool-test/function.json`:
```json
{
  "minWorkers": 1,
  "maxWorkers": 3
}
```

- [ ] **Step 2: Create eager-override fixture**

`src/test/functions/eager-override/index.ts`:
```ts
Deno.serve((_req) => new Response("eager-override"));
```

`src/test/functions/eager-override/function.json`:
```json
{
  "eagerSpawn": true,
  "minWorkers": 2
}
```

- [ ] **Step 3: Update existing test assertions that check function lists**

The `routing.test.ts` "discovers functions" test (line 23) and `lifecycle.test.ts` "eager spawn" test (line 73) both assert exact sorted function lists. Adding `pool-test` and `eager-override` will break these.

In `src/test/server/routing.test.ts`, update the expected array:
```ts
expect(fns).toEqual([
  "eager-override",
  "echo",
  "env-test",
  "hello",
  "idle-custom",
  "import-map-test",
  "npm-import",
  "oom",
  "pool-test",
  "public",
  "shared-test",
  "slow",
  "unresponsive",
  "wasm-test",
]);
```

In `src/test/server/lifecycle.test.ts`, update the expected array in the "eager spawn" test:
```ts
expect(readyFunctions.sort()).toEqual([
  "eager-override",
  "echo",
  "env-test",
  "hello",
  "idle-custom",
  "import-map-test",
  "npm-import",
  "oom",
  "pool-test",
  "public",
  "shared-test",
  "slow",
  "unresponsive",
  "wasm-test",
]);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/test/server/routing.test.ts src/test/server/lifecycle.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/test/functions/pool-test/ src/test/functions/eager-override/ src/test/server/routing.test.ts src/test/server/lifecycle.test.ts
git commit -m "feat: add pool-test and eager-override test fixtures"
```

---

## Chunk 2: WorkerLifecycleManager

### Task 5: Create WorkerLifecycleManager — core structure and acquire()

**Files:**
- Create: `src/server/core/WorkerLifecycleManager.ts`

This is the biggest new file. Build it incrementally.

- [ ] **Step 1: Create the manager with constructor and acquire()**

```ts
import type { DenoHTTPWorker } from "../../worker/index.js";
import type {
  WorkerInstance,
  AcquireResult,
  PoolStats,
  InstanceStats,
} from "./WorkerInstance.js";

export interface WorkerLifecycleManagerOptions {
  functionName: string;
  minWorkers: number;
  maxWorkers: number;
  idleTimeout?: number;
  healthCheckConfig?: {
    interval: number;
    timeout: number;
    maxFailures: number;
  };
  onFunctionCold?: (name: string) => void;
  onFunctionReady?: (name: string) => void;
  onWorkerUnhealthy?: (name: string, failures: number) => void;
  onFunctionError?: (name: string, error: Error) => void;
  onNeedSpawn?: (name: string) => void;
}

export class WorkerLifecycleManager {
  #functionName: string;
  #minWorkers: number;
  #maxWorkers: number;
  #idleTimeout?: number;
  #healthCheckConfig?: {
    interval: number;
    timeout: number;
    maxFailures: number;
  };
  #options: WorkerLifecycleManagerOptions;

  #instances: WorkerInstance[] = [];
  #idCounter = 0;
  #spawningCount = 0;
  #spawnResolvers: Array<() => void> = [];
  #restartCount = 0;
  #readyFired = false;

  constructor(options: WorkerLifecycleManagerOptions) {
    this.#functionName = options.functionName;
    this.#minWorkers = options.minWorkers;
    this.#maxWorkers = options.maxWorkers;
    this.#idleTimeout = options.idleTimeout;
    this.#healthCheckConfig = options.healthCheckConfig;
    this.#options = options;
  }

  get functionName(): string {
    return this.#functionName;
  }

  get instanceCount(): number {
    return this.#instances.length;
  }

  /**
   * Get the least-loaded instance, or signal that a new spawn is needed.
   */
  acquire(): AcquireResult {
    // If no instances exist and room to spawn
    if (this.#instances.length === 0) {
      if (this.#instances.length + this.#spawningCount < this.#maxWorkers) {
        return { kind: "spawn" };
      }
      // Spawn in-flight, wait for it
      return { kind: "wait", promise: this.#waitForSpawn() };
    }

    // Find least-loaded instance
    let leastLoaded = this.#instances[0]!;
    for (let i = 1; i < this.#instances.length; i++) {
      if (this.#instances[i]!.activeRequests < leastLoaded.activeRequests) {
        leastLoaded = this.#instances[i]!;
      }
    }

    // If least-loaded is idle (0 active), use it directly
    if (leastLoaded.activeRequests === 0) {
      return { kind: "instance", instance: leastLoaded };
    }

    // All instances are busy — can we scale up?
    if (this.#instances.length + this.#spawningCount < this.#maxWorkers) {
      return { kind: "spawn" };
    }

    // At capacity with in-flight spawn — wait
    if (this.#spawningCount > 0) {
      return { kind: "wait", promise: this.#waitForSpawn() };
    }

    // At capacity, no spawns in-flight — overload least-loaded
    return { kind: "instance", instance: leastLoaded };
  }

  reserveSpawnSlot(): void {
    this.#spawningCount++;
  }

  releaseSpawnSlot(): void {
    this.#spawningCount = Math.max(0, this.#spawningCount - 1);
    // Notify any waiters that a slot may be available
    for (const resolve of this.#spawnResolvers) {
      resolve();
    }
    this.#spawnResolvers = [];
  }

  nextId(): string {
    return `${this.#functionName}-${this.#idCounter++}`;
  }

  addInstance(instance: WorkerInstance): void {
    this.#instances.push(instance);

    if (!this.#readyFired) {
      this.#readyFired = true;
      this.#options.onFunctionReady?.(this.#functionName);
    }

    // Start health check for this instance
    this.#startHealthCheck(instance);

    // Start idle timer if no active requests
    if (instance.activeRequests === 0) {
      this.#startIdleTimer(instance);
    }
  }

  removeInstance(id: string): void {
    const idx = this.#instances.findIndex((i) => i.id === id);
    if (idx === -1) return;

    const instance = this.#instances[idx]!;
    this.#clearIdleTimer(instance);
    this.#stopHealthCheck(instance);
    instance.worker.terminate();
    this.#instances.splice(idx, 1);

    // Fire onFunctionCold when last instance removed
    if (this.#instances.length === 0 && this.#spawningCount === 0) {
      this.#readyFired = false;
      this.#options.onFunctionCold?.(this.#functionName);
    }
  }

  #waitForSpawn(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#spawnResolvers.push(resolve);
    });
  }

  // --- Active request tracking ---

  incrementActiveRequests(id: string): void {
    const instance = this.#findInstance(id);
    if (!instance) return;
    this.#clearIdleTimer(instance);
    instance.activeRequests++;
    instance.totalRequests++;
  }

  decrementActiveRequests(id: string): void {
    const instance = this.#findInstance(id);
    if (!instance) return;
    instance.activeRequests = Math.max(0, instance.activeRequests - 1);
    if (instance.activeRequests === 0) {
      this.#startIdleTimer(instance);
    }
  }

  // --- Idle timeout ---

  #startIdleTimer(instance: WorkerInstance): void {
    if (this.#idleTimeout === undefined || this.#idleTimeout <= 0) return;
    this.#clearIdleTimer(instance);

    instance.idleTimer = setTimeout(() => {
      instance.idleTimer = undefined;

      // Only scale down if above minWorkers
      if (this.#instances.length <= this.#minWorkers) return;

      this.#stopHealthCheck(instance);
      const idx = this.#instances.findIndex((i) => i.id === instance.id);
      if (idx === -1) return;
      instance.worker.terminate();
      this.#instances.splice(idx, 1);

      // Fire cold callback if last instance
      if (this.#instances.length === 0 && this.#spawningCount === 0) {
        this.#readyFired = false;
        this.#options.onFunctionCold?.(this.#functionName);
      }
    }, this.#idleTimeout);
  }

  #clearIdleTimer(instance: WorkerInstance): void {
    if (instance.idleTimer) {
      clearTimeout(instance.idleTimer);
      instance.idleTimer = undefined;
    }
  }

  clearAllIdleTimers(): void {
    for (const instance of this.#instances) {
      this.#clearIdleTimer(instance);
    }
  }

  // --- Health checks ---

  #startHealthCheck(instance: WorkerInstance): void {
    if (!this.#healthCheckConfig) return;
    const config = this.#healthCheckConfig;

    instance.healthCheckFailures = 0;

    const timer = setInterval(async () => {
      // Skip if instance was removed
      if (!this.#instances.includes(instance)) {
        clearInterval(timer);
        return;
      }
      // Skip if check in-flight
      if (instance.healthCheckInFlight) return;
      instance.healthCheckInFlight = true;

      let req: ReturnType<DenoHTTPWorker["request"]> | undefined;
      const healthy = await new Promise<boolean>((resolve) => {
        const timeoutId = setTimeout(() => {
          req?.destroy();
          resolve(false);
        }, config.timeout);
        try {
          req = instance.worker.request(
            "http://deno/__health",
            { method: "GET" },
            (res) => {
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

      instance.healthCheckInFlight = false;

      // Instance might have been removed during check
      if (!this.#instances.includes(instance)) return;

      if (healthy) {
        instance.healthCheckFailures = 0;
        return;
      }

      instance.healthCheckFailures++;

      if (instance.healthCheckFailures >= config.maxFailures) {
        this.#stopHealthCheck(instance);
        this.#options.onWorkerUnhealthy?.(
          this.#functionName,
          instance.healthCheckFailures
        );

        // Remove this instance
        const idx = this.#instances.findIndex((i) => i.id === instance.id);
        if (idx !== -1) {
          instance.worker.terminate();
          this.#instances.splice(idx, 1);
        }

        // If below minWorkers, signal need for replacement spawn
        if (this.#instances.length < this.#minWorkers) {
          this.#options.onNeedSpawn?.(this.#functionName);
        }
      }
    }, config.interval);

    instance.healthCheckTimer = timer;
  }

  #stopHealthCheck(instance: WorkerInstance): void {
    if (instance.healthCheckTimer) {
      clearInterval(instance.healthCheckTimer);
      instance.healthCheckTimer = undefined;
    }
  }

  stopAllHealthChecks(): void {
    for (const instance of this.#instances) {
      this.#stopHealthCheck(instance);
    }
  }

  // --- Stats ---

  getStats(): PoolStats {
    const now = Date.now();
    const instances: InstanceStats[] = this.#instances.map((i) => ({
      id: i.id,
      activeRequests: i.activeRequests,
      totalRequests: i.totalRequests,
      uptimeMs: now - i.spawnTime,
    }));

    return {
      functionName: this.#functionName,
      instanceCount: this.#instances.length,
      totalRequests: this.#instances.reduce(
        (sum, i) => sum + i.totalRequests,
        0
      ),
      activeRequests: this.#instances.reduce(
        (sum, i) => sum + i.activeRequests,
        0
      ),
      restartCount: this.#restartCount,
      instances,
    };
  }

  // --- Dispose ---

  dispose(): void {
    for (const instance of this.#instances) {
      this.#clearIdleTimer(instance);
      this.#stopHealthCheck(instance);
      instance.worker.terminate();
    }
    this.#instances = [];
    this.#spawnResolvers = [];
  }

  // --- Restart (hot-reload) ---

  restart(): void {
    this.#restartCount++;
    this.dispose();
    this.#readyFired = false;
  }

  // --- Internal helpers ---

  #findInstance(id: string): WorkerInstance | undefined {
    return this.#instances.find((i) => i.id === id);
  }

  /** Get instances array (for WorkerPool to register exit handlers) */
  getInstances(): readonly WorkerInstance[] {
    return this.#instances;
  }

  /** Check if we have instances */
  hasInstances(): boolean {
    return this.#instances.length > 0;
  }
}
```

- [ ] **Step 2: Run lint**

Run: `npx biome check src/server/core/WorkerLifecycleManager.ts`
Expected: No errors (fix any formatting issues)

- [ ] **Step 3: Commit**

```bash
git add src/server/core/WorkerLifecycleManager.ts
git commit -m "feat: create WorkerLifecycleManager with acquire, scaling, health, idle"
```

---

### Task 6: Write WorkerLifecycleManager unit tests

**Files:**
- Create: `src/test/server/worker-lifecycle-manager.test.ts`

These tests exercise the manager's logic using mock workers. They don't spawn real Deno processes.

- [ ] **Step 1: Write unit tests**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerLifecycleManager } from "../../server/core/WorkerLifecycleManager.js";
import { createWorkerInstance } from "../../server/core/WorkerInstance.js";
import type { DenoHTTPWorker } from "../../worker/index.js";

function mockWorker(): DenoHTTPWorker {
  return {
    terminate: vi.fn(),
    shutdown: vi.fn(),
    request: vi.fn(),
    stdout: null as any,
    stderr: null as any,
    addEventListener: vi.fn(),
  } as unknown as DenoHTTPWorker;
}

describe("WorkerLifecycleManager", { timeout: 10_000 }, () => {
  let manager: WorkerLifecycleManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("acquire returns spawn when no instances exist", () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 3,
    });

    const result = manager.acquire();
    expect(result.kind).toBe("spawn");
  });

  it("acquire returns instance when one exists", () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 3,
    });

    const id = manager.nextId();
    const instance = createWorkerInstance(id, "test", mockWorker());
    manager.addInstance(instance);

    const result = manager.acquire();
    expect(result.kind).toBe("instance");
    if (result.kind === "instance") {
      expect(result.instance.id).toBe(id);
    }
  });

  it("acquire returns least-loaded instance", () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 3,
    });

    const w1 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    const w2 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    manager.addInstance(w1);
    manager.addInstance(w2);

    // Make w1 busy
    manager.incrementActiveRequests(w1.id);

    const result = manager.acquire();
    expect(result.kind).toBe("instance");
    if (result.kind === "instance") {
      expect(result.instance.id).toBe(w2.id);
    }
  });

  it("acquire returns spawn when all instances busy and under maxWorkers", () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 3,
    });

    const w1 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    manager.addInstance(w1);
    manager.incrementActiveRequests(w1.id);

    const result = manager.acquire();
    expect(result.kind).toBe("spawn");
  });

  it("acquire returns least-loaded when at maxWorkers and all busy", () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 2,
    });

    const w1 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    const w2 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    manager.addInstance(w1);
    manager.addInstance(w2);
    manager.incrementActiveRequests(w1.id);
    manager.incrementActiveRequests(w1.id); // 2 active
    manager.incrementActiveRequests(w2.id); // 1 active

    const result = manager.acquire();
    expect(result.kind).toBe("instance");
    if (result.kind === "instance") {
      expect(result.instance.id).toBe(w2.id); // least loaded
    }
  });

  it("acquire returns wait when spawn is in-flight at capacity", () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 1,
    });

    manager.reserveSpawnSlot(); // Simulate in-flight spawn

    const result = manager.acquire();
    expect(result.kind).toBe("wait");
  });

  it("spawningCount prevents overshooting maxWorkers", () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 2,
    });

    const w1 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    manager.addInstance(w1);
    manager.incrementActiveRequests(w1.id);

    // First concurrent request triggers spawn
    const r1 = manager.acquire();
    expect(r1.kind).toBe("spawn");

    // Simulate spawn in-flight
    manager.reserveSpawnSlot();

    // Second concurrent request should wait (at capacity: 1 instance + 1 spawning = 2 = maxWorkers)
    const r2 = manager.acquire();
    expect(r2.kind).toBe("wait");
  });

  it("releaseSpawnSlot notifies waiters", async () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 1,
    });

    manager.reserveSpawnSlot();

    const result = manager.acquire();
    expect(result.kind).toBe("wait");

    let resolved = false;
    if (result.kind === "wait") {
      result.promise.then(() => {
        resolved = true;
      });
    }

    // Release the slot
    manager.releaseSpawnSlot();
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(true);
  });

  it("nextId returns monotonically increasing IDs", () => {
    manager = new WorkerLifecycleManager({
      functionName: "hello",
      minWorkers: 0,
      maxWorkers: 3,
    });

    expect(manager.nextId()).toBe("hello-0");
    expect(manager.nextId()).toBe("hello-1");
    expect(manager.nextId()).toBe("hello-2");
  });

  it("removeInstance terminates worker and removes from pool", () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 3,
    });

    const worker = mockWorker();
    const instance = createWorkerInstance(manager.nextId(), "test", worker);
    manager.addInstance(instance);

    expect(manager.instanceCount).toBe(1);
    manager.removeInstance(instance.id);
    expect(manager.instanceCount).toBe(0);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("onFunctionCold fires when last instance removed", () => {
    const coldCalls: string[] = [];
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 3,
      onFunctionCold: (name) => coldCalls.push(name),
    });

    const w1 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    const w2 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    manager.addInstance(w1);
    manager.addInstance(w2);

    manager.removeInstance(w1.id);
    expect(coldCalls).toHaveLength(0); // Not last

    manager.removeInstance(w2.id);
    expect(coldCalls).toEqual(["test"]); // Last instance gone
  });

  it("onFunctionReady fires only once (first instance)", () => {
    const readyCalls: string[] = [];
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 3,
      onFunctionReady: (name) => readyCalls.push(name),
    });

    manager.addInstance(
      createWorkerInstance(manager.nextId(), "test", mockWorker())
    );
    manager.addInstance(
      createWorkerInstance(manager.nextId(), "test", mockWorker())
    );

    expect(readyCalls).toEqual(["test"]); // Only once
  });

  it("idle timer fires and scales down when above minWorkers", async () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 1,
      maxWorkers: 3,
      idleTimeout: 100,
    });

    const w1 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    const w2 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    manager.addInstance(w1);
    manager.addInstance(w2);

    expect(manager.instanceCount).toBe(2);

    // Wait for idle timeout
    await new Promise((r) => setTimeout(r, 200));

    // One should be removed (scaled down to minWorkers=1)
    expect(manager.instanceCount).toBe(1);
  });

  it("idle timer does NOT scale below minWorkers", async () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 2,
      maxWorkers: 3,
      idleTimeout: 100,
    });

    const w1 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    const w2 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    manager.addInstance(w1);
    manager.addInstance(w2);

    await new Promise((r) => setTimeout(r, 200));

    // Should stay at 2 (minWorkers)
    expect(manager.instanceCount).toBe(2);
  });

  it("getStats returns aggregate and per-instance data", () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 3,
    });

    const w1 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    const w2 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    manager.addInstance(w1);
    manager.addInstance(w2);
    manager.incrementActiveRequests(w1.id);
    manager.incrementActiveRequests(w1.id);
    manager.incrementActiveRequests(w2.id);

    const stats = manager.getStats();
    expect(stats.functionName).toBe("test");
    expect(stats.instanceCount).toBe(2);
    expect(stats.totalRequests).toBe(3); // 2 + 1
    expect(stats.activeRequests).toBe(3);
    expect(stats.instances).toHaveLength(2);
    expect(stats.instances[0]!.totalRequests).toBe(2);
    expect(stats.instances[1]!.totalRequests).toBe(1);
  });

  it("restart disposes all and increments restartCount", () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 3,
    });

    const w1 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    manager.addInstance(w1);

    manager.restart();
    expect(manager.instanceCount).toBe(0);
    expect(manager.getStats().restartCount).toBe(1);
  });

  it("incrementActiveRequests is no-op for unknown id", () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 3,
    });

    // Should not throw
    manager.incrementActiveRequests("nonexistent-99");
    manager.decrementActiveRequests("nonexistent-99");
  });

  it("idle timer does not fire onFunctionCold when at minWorkers", async () => {
    const coldCalls: string[] = [];
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 1,
      maxWorkers: 3,
      idleTimeout: 100,
      onFunctionCold: (name) => coldCalls.push(name),
    });

    const w1 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    manager.addInstance(w1);

    await new Promise((r) => setTimeout(r, 200));

    // At minWorkers=1 — should NOT go cold
    expect(coldCalls).toHaveLength(0);
    expect(manager.instanceCount).toBe(1);
  });

  it("onFunctionCold fires when minWorkers:0 and last idle instance removed", async () => {
    const coldCalls: string[] = [];
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 3,
      idleTimeout: 100,
      onFunctionCold: (name) => coldCalls.push(name),
    });

    const w1 = createWorkerInstance(manager.nextId(), "test", mockWorker());
    manager.addInstance(w1);

    await new Promise((r) => setTimeout(r, 200));

    expect(coldCalls).toEqual(["test"]);
    expect(manager.instanceCount).toBe(0);
  });

  it("dispose cleans up all instances", () => {
    manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 0,
      maxWorkers: 3,
    });

    const workers = [mockWorker(), mockWorker(), mockWorker()];
    for (const w of workers) {
      manager.addInstance(
        createWorkerInstance(manager.nextId(), "test", w)
      );
    }

    expect(manager.instanceCount).toBe(3);
    manager.dispose();
    expect(manager.instanceCount).toBe(0);
    for (const w of workers) {
      expect(w.terminate).toHaveBeenCalled();
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/test/server/worker-lifecycle-manager.test.ts`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/test/server/worker-lifecycle-manager.test.ts
git commit -m "test: add WorkerLifecycleManager unit tests"
```

---

## Chunk 3: WorkerPool Refactor

### Task 7: Refactor WorkerPool to use WorkerLifecycleManager

**Files:**
- Modify: `src/server/core/WorkerPool.ts`

This is the critical refactoring step. The WorkerPool becomes a thin coordinator that delegates lifecycle to per-function managers.

- [ ] **Step 1: Rewrite WorkerPool**

Replace the entire content of `src/server/core/WorkerPool.ts` with:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DenoHTTPWorker, newDenoHTTPWorker } from "../../worker/index.js";
import {
  createSecretMasker,
  filterSecretValues,
  loadEnvFile,
} from "../../env/index.js";
import { resolvePermissionFlags } from "../../permissions/profiles.js";
import type { FunctionRegistry } from "./FunctionRegistry.js";
import type { EdgeFunctionServerOptions } from "../utils/types.js";
import {
  WorkerLifecycleManager,
  type WorkerLifecycleManagerOptions,
} from "./WorkerLifecycleManager.js";
import {
  createWorkerInstance,
  type WorkerInstance,
  type PoolStats,
} from "./WorkerInstance.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVE_BOOTSTRAP_PATH = path.resolve(
  __dirname,
  "../../../deno-bootstrap/serve.ts"
);

export interface WorkerPoolOptions {
  registry: FunctionRegistry;
  serverOptions: EdgeFunctionServerOptions;
  envBase: Record<string, string>;
  secretValues: string[];
}

export class WorkerPool {
  #registry: FunctionRegistry;
  #serverOptions: EdgeFunctionServerOptions;
  #envBase: Record<string, string>;
  #secretValues: string[];

  #managers = new Map<string, WorkerLifecycleManager>();
  #workerPromises = new Map<string, Promise<WorkerInstance>>();

  constructor(options: WorkerPoolOptions) {
    this.#registry = options.registry;
    this.#serverOptions = options.serverOptions;
    this.#envBase = options.envBase;
    this.#secretValues = options.secretValues;
  }

  async getOrCreate(name: string): Promise<WorkerInstance> {
    const manager = this.#getOrCreateManager(name);

    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const result = manager.acquire();

      switch (result.kind) {
        case "instance":
          return result.instance;

        case "spawn": {
          manager.reserveSpawnSlot();
          const id = manager.nextId();
          const dedupKey = `${name}-${id}`;

          const existingPromise = this.#workerPromises.get(dedupKey);
          if (existingPromise) {
            manager.releaseSpawnSlot();
            return existingPromise;
          }

          const promise = this.#spawnAndRegister(name, id, manager);
          this.#workerPromises.set(dedupKey, promise);

          try {
            const instance = await promise;
            return instance;
          } catch (err) {
            throw err;
          } finally {
            this.#workerPromises.delete(dedupKey);
            manager.releaseSpawnSlot();
          }
        }

        case "wait":
          await result.promise;
          // Loop and retry acquire
          continue;
      }
    }

    // After max retries, return least-loaded (fallback)
    const fallback = manager.acquire();
    if (fallback.kind === "instance") return fallback.instance;
    throw new Error(
      `Failed to acquire worker for "${name}" after ${MAX_RETRIES} retries`
    );
  }

  async #spawnAndRegister(
    name: string,
    id: string,
    manager: WorkerLifecycleManager
  ): Promise<WorkerInstance> {
    const entrypoint = this.#registry.getEntrypoint(name);
    if (!entrypoint) {
      throw new Error(`Function "${name}" not found`);
    }

    const worker = await this.#spawnWorker(name, id, entrypoint);
    const instance = createWorkerInstance(id, name, worker);

    // Auto-remove on exit so instance is cleaned up
    worker.addEventListener("exit", () => {
      manager.removeInstance(id);
    });

    manager.addInstance(instance);
    return instance;
  }

  async restart(name: string): Promise<void> {
    const manager = this.#managers.get(name);
    if (manager) {
      manager.restart();
    }

    // Clear any in-flight spawn promises for this function
    for (const key of this.#workerPromises.keys()) {
      if (key.startsWith(`${name}-`)) {
        this.#workerPromises.delete(key);
      }
    }

    if (this.#registry.hasFunction(name)) {
      const minWorkers = this.#resolveMinWorkers(name);
      const count = Math.max(minWorkers, 1);
      await Promise.all(
        Array.from({ length: count }, () => this.getOrCreate(name))
      );
    }
  }

  getStats(name: string): PoolStats {
    const manager = this.#managers.get(name);
    if (!manager) {
      return {
        functionName: name,
        instanceCount: 0,
        totalRequests: 0,
        activeRequests: 0,
        restartCount: 0,
        instances: [],
      };
    }
    return manager.getStats();
  }

  /** @deprecated Use incrementActiveRequests instead. Kept for backward compat. */
  incrementRequestCount(name: string): void {
    // No-op: totalRequests is now tracked per-instance inside
    // manager.incrementActiveRequests(). This method is kept to avoid
    // breaking external callers but does nothing.
  }

  incrementActiveRequests(name: string, instanceId: string): void {
    const manager = this.#managers.get(name);
    manager?.incrementActiveRequests(instanceId);
  }

  decrementActiveRequests(name: string, instanceId: string): void {
    const manager = this.#managers.get(name);
    manager?.decrementActiveRequests(instanceId);
  }

  terminateAll(): void {
    for (const manager of this.#managers.values()) {
      manager.dispose();
    }
    this.#managers.clear();
    this.#workerPromises.clear();
  }

  stopAllHealthChecks(): void {
    for (const manager of this.#managers.values()) {
      manager.stopAllHealthChecks();
    }
  }

  getActiveWorkerNames(): string[] {
    const names: string[] = [];
    for (const [name, manager] of this.#managers) {
      if (manager.hasInstances()) {
        names.push(name);
      }
    }
    return names;
  }

  clearAllIdleTimers(): void {
    for (const manager of this.#managers.values()) {
      manager.clearAllIdleTimers();
    }
  }

  // --- Eager spawn support ---

  async eagerSpawn(names: string[]): Promise<void> {
    const promises: Promise<unknown>[] = [];
    for (const name of names) {
      const fnConfig = this.#registry.getFunctionConfig(name);
      const serverEager = this.#serverOptions.eagerSpawn ?? false;
      const fnEager = fnConfig?.eagerSpawn;

      // Per-function override wins, then server-level
      const shouldEagerSpawn = fnEager !== undefined ? fnEager : serverEager;
      if (!shouldEagerSpawn) continue;

      const minWorkers = this.#resolveMinWorkers(name);
      const count = Math.max(minWorkers, 1);
      for (let i = 0; i < count; i++) {
        promises.push(this.getOrCreate(name));
      }
    }
    await Promise.all(promises);
  }

  // --- Private helpers ---

  #getOrCreateManager(name: string): WorkerLifecycleManager {
    let manager = this.#managers.get(name);
    if (manager) return manager;

    const fnConfig = this.#registry.getFunctionConfig(name);
    const rawMin =
      fnConfig?.minWorkers ?? this.#serverOptions.minWorkers ?? 0;
    const rawMax =
      fnConfig?.maxWorkers ?? this.#serverOptions.maxWorkers ?? 1;

    // Validate with warnings
    let validMin = rawMin;
    let validMax = rawMax;
    if (rawMin < 0) {
      console.warn(
        `[edge] "${name}": minWorkers (${rawMin}) < 0, defaulting to 0`
      );
      validMin = 0;
    }
    if (rawMax < 1) {
      console.warn(
        `[edge] "${name}": maxWorkers (${rawMax}) < 1, defaulting to 1`
      );
      validMax = 1;
    }
    if (validMin > validMax) {
      console.warn(
        `[edge] "${name}": minWorkers (${validMin}) > maxWorkers (${validMax}), clamping minWorkers to ${validMax}`
      );
      validMin = validMax;
    }
    const finalMin = validMin;

    const idleTimeout =
      fnConfig?.idleTimeout ?? this.#serverOptions.idleTimeout;
    const healthCheckConfig = this.#resolveHealthCheckConfig();

    manager = new WorkerLifecycleManager({
      functionName: name,
      minWorkers: finalMin,
      maxWorkers: validMax,
      idleTimeout,
      healthCheckConfig: healthCheckConfig ?? undefined,
      onFunctionCold: this.#serverOptions.onFunctionCold,
      onFunctionReady: this.#serverOptions.onFunctionReady,
      onWorkerUnhealthy: this.#serverOptions.onWorkerUnhealthy,
      onFunctionError: this.#serverOptions.onFunctionError,
      onNeedSpawn: (fnName) => {
        // Health check detected we're below minWorkers — spawn replacement
        this.getOrCreate(fnName).catch((err) => {
          this.#serverOptions.onFunctionError?.(fnName, err as Error);
        });
      },
    });

    this.#managers.set(name, manager);
    return manager;
  }

  #resolveMinWorkers(name: string): number {
    const fnConfig = this.#registry.getFunctionConfig(name);
    return fnConfig?.minWorkers ?? this.#serverOptions.minWorkers ?? 0;
  }

  #resolveHealthCheckConfig(): {
    interval: number;
    timeout: number;
    maxFailures: number;
  } | null {
    const workerOpts = this.#serverOptions.workerOptions ?? {};
    const interval =
      workerOpts.healthCheckInterval ?? this.#serverOptions.healthCheckInterval;
    if (interval === undefined) return null;

    return {
      interval,
      timeout:
        workerOpts.healthCheckTimeout ??
        this.#serverOptions.healthCheckTimeout ??
        5000,
      maxFailures:
        workerOpts.healthCheckMaxFailures ??
        this.#serverOptions.healthCheckMaxFailures ??
        3,
    };
  }

  async #spawnWorker(
    name: string,
    instanceId: string,
    entrypoint: string
  ): Promise<DenoHTTPWorker> {
    const userOptions = this.#serverOptions.workerOptions ?? {};

    // Resolve permission flags: functionPermissions > function.json > defaultProfile > "standard"
    let runFlags: string[];
    if (userOptions.runFlags) {
      runFlags = [...userOptions.runFlags];
    } else {
      const serverOverride = this.#serverOptions.functionPermissions?.[name];
      const fnConfig = this.#registry.getFunctionConfig(name);
      const permissionValue = serverOverride ?? fnConfig?.permissions;
      runFlags = [
        ...resolvePermissionFlags(permissionValue, {
          defaultProfile: this.#serverOptions.defaultPermissionProfile,
          customProfiles: this.#serverOptions.permissionProfiles,
        }),
      ];
    }

    // Append shared folder read permissions
    const sharedFolderPaths = this.#registry.getSharedFolderPaths();
    if (sharedFolderPaths.length > 0) {
      const sharedPaths = sharedFolderPaths.join(",");
      const hasFullRead =
        runFlags.includes("--allow-read") || runFlags.includes("--allow-all");
      if (!hasFullRead) {
        const existingIdx = runFlags.findIndex((f) =>
          f.startsWith("--allow-read=")
        );
        if (existingIdx !== -1) {
          runFlags[existingIdx] += `,${sharedPaths}`;
        } else {
          runFlags.push(`--allow-read=${sharedPaths}`);
        }
      }
    }

    // Layer 5: per-function .env
    const functionDir = path.dirname(entrypoint);
    const perFunctionEnv = await loadEnvFile(path.join(functionDir, ".env"));

    // Merge all layers
    const mergedEnv: Record<string, string> = {
      ...this.#envBase,
      ...perFunctionEnv,
      ...(userOptions.env ?? {}),
    };

    // Collect per-function secrets for masking
    let secretValues = this.#secretValues;
    if (this.#serverOptions.maskSecrets !== false) {
      const perFunctionSecrets = filterSecretValues(perFunctionEnv);
      const workerSecrets = userOptions.env
        ? filterSecretValues(userOptions.env)
        : [];
      secretValues = [...secretValues, ...perFunctionSecrets, ...workerSecrets];
    }

    const logLevel =
      this.#serverOptions.logLevel ?? userOptions.logLevel ?? undefined;
    let onLog = userOptions.onLog;

    if (this.#serverOptions.onLog) {
      const serverOnLog = this.#serverOptions.onLog;
      onLog = (level, source, message) =>
        serverOnLog(name, level, source, message);
    } else if (logLevel && logLevel !== "silent" && !onLog) {
      onLog = (_level, source, message) => {
        if (source === "stderr") {
          console.error(`[deno:${instanceId}]`, message);
        } else {
          console.log(`[deno:${instanceId}]`, message);
        }
      };
    }

    // Wrap onLog with secret masker
    if (this.#serverOptions.maskSecrets !== false && onLog) {
      const mask = createSecretMasker(secretValues);
      const originalOnLog = onLog;
      onLog = (level, source, message) =>
        originalOnLog(level, source, mask(message));
    }

    return newDenoHTTPWorker(new URL(`file://${entrypoint}`), {
      ...userOptions,
      denoBootstrapScriptPath:
        userOptions.denoBootstrapScriptPath ?? SERVE_BOOTSTRAP_PATH,
      runFlags,
      importMapPath:
        this.#registry.getImportMapFile() ??
        this.#serverOptions.importMapPath ??
        userOptions.importMapPath,
      configPath: this.#serverOptions.configPath ?? userOptions.configPath,
      env: mergedEnv,
      ...(logLevel ? { logLevel } : {}),
      ...(onLog ? { onLog } : {}),
      memoryLimitMb:
        userOptions.memoryLimitMb ?? this.#serverOptions.memoryLimitMb,
      requestTimeout:
        userOptions.requestTimeout ?? this.#serverOptions.requestTimeout,
      workerMaxDuration:
        userOptions.workerMaxDuration ?? this.#serverOptions.workerMaxDuration,
    });
  }
}
```

- [ ] **Step 2: Run lint**

Run: `npx biome check src/server/core/WorkerPool.ts`
Expected: No errors

- [ ] **Step 3: Run all tests**

Run: `npx vitest run src/test/`
Expected: Some tests may fail — see next tasks for fixes

- [ ] **Step 4: Commit**

```bash
git add src/server/core/WorkerPool.ts
git commit -m "refactor: rewrite WorkerPool to delegate lifecycle to WorkerLifecycleManager"
```

---

### Task 8: Update WorkerRequestHandler to use WorkerInstance

**Files:**
- Modify: `src/server/core/WorkerRequestHandler.ts`

- [ ] **Step 1: Update the handler**

The key changes:
1. `getOrCreate` now returns `WorkerInstance` instead of `DenoHTTPWorker`
2. Use `instance.worker` for proxying
3. Use `instance.id` for active request tracking
4. `incrementActiveRequests` / `decrementActiveRequests` now take `(name, instanceId)`

Replace the content of `src/server/core/WorkerRequestHandler.ts`:

```ts
import type { RequestStats } from "../../worker/index.js";
import type { WorkerPool } from "./WorkerPool.js";
import type { Middleware, RequestContext } from "../utils/types.js";

export interface WorkerRequestHandlerOptions {
  onFunctionError?: (name: string, error: Error) => void;
  onRequestStats?: (stats: RequestStats) => void;
}

export class WorkerRequestHandler {
  #pool: WorkerPool;
  #options: WorkerRequestHandlerOptions;

  constructor(pool: WorkerPool, options: WorkerRequestHandlerOptions) {
    this.#pool = pool;
    this.#options = options;
  }

  middleware(): Middleware {
    return async (ctx: RequestContext, _next: () => Promise<Response>) => {
      const { request, functionName, url } = ctx;

      // Acquire worker instance (least-loaded or freshly spawned)
      let instance: Awaited<ReturnType<WorkerPool["getOrCreate"]>>;
      try {
        instance = await this.#pool.getOrCreate(functionName);
      } catch (err) {
        this.#options.onFunctionError?.(functionName, err as Error);
        return new Response(
          JSON.stringify({ error: "Failed to start function worker" }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        );
      }

      const { worker, id: instanceId } = instance;

      // Rewrite URL: strip the function name prefix
      const segments = url.pathname.split("/").filter(Boolean);
      const remainingPath = `/${segments.slice(1).join("/")}`;
      const rewrittenUrl = `${url.protocol}//${url.host}${remainingPath}${url.search}`;

      // Build headers
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      // Always strip x-auth-claims to prevent spoofing from clients
      delete headers["x-auth-claims"];
      if (ctx.authClaims) {
        headers["x-auth-claims"] = Buffer.from(
          JSON.stringify(ctx.authClaims)
        ).toString("base64url");
      }

      // Track request
      const startTime = Date.now();
      this.#pool.incrementActiveRequests(functionName, instanceId);

      const pool = this.#pool;
      let decremented = false;
      const releaseActiveRequest = () => {
        if (decremented) return;
        decremented = true;
        pool.decrementActiveRequests(functionName, instanceId);
      };

      try {
        return await new Promise<Response>((resolve, reject) => {
          const proxyReq = worker.request(
            rewrittenUrl,
            { method: request.method, headers },
            (proxyRes) => {
              const statusCode = proxyRes.statusCode ?? 200;
              const responseHeaders = new Headers();
              for (const [key, value] of Object.entries(proxyRes.headers)) {
                if (value === undefined) continue;

                const headerName = key.toLowerCase();
                if (Array.isArray(value)) {
                  if (headerName === "set-cookie") {
                    for (const v of value) {
                      responseHeaders.append(key, v);
                    }
                  } else {
                    responseHeaders.set(key, value.join(", "));
                  }
                } else {
                  if (headerName === "set-cookie") {
                    responseHeaders.append(key, value);
                  } else {
                    responseHeaders.set(key, value);
                  }
                }
              }

              let statsEmitted = false;
              const emitStats = (status: number, timedOut: boolean) => {
                if (statsEmitted) return;
                statsEmitted = true;
                this.#emitStats(functionName, startTime, status, timedOut);
              };

              // Handle client disconnect / stream abort
              proxyRes.on("close", () => {
                emitStats(statusCode, false);
                releaseActiveRequest();
              });

              const body = new ReadableStream({
                start(controller) {
                  proxyRes.on("data", (chunk: Buffer) =>
                    controller.enqueue(chunk)
                  );
                  proxyRes.on("end", () => {
                    controller.close();
                    emitStats(statusCode, false);
                    releaseActiveRequest();
                  });
                  proxyRes.on("error", (err) => {
                    emitStats(statusCode, false);
                    releaseActiveRequest();
                    controller.error(err);
                  });
                },
              });

              resolve(
                new Response(body, {
                  status: statusCode,
                  headers: responseHeaders,
                })
              );
            }
          );

          proxyReq.on("error", (err) => {
            this.#options.onFunctionError?.(functionName, err);
            const timedOut = (err as any).code === "ERR_REQUEST_TIMEOUT";
            const status = timedOut ? 504 : 502;
            const errorMsg = timedOut
              ? "Request timed out"
              : "Worker request failed";
            this.#emitStats(functionName, startTime, status, timedOut);
            releaseActiveRequest();
            resolve(
              new Response(JSON.stringify({ error: errorMsg }), {
                status,
                headers: { "Content-Type": "application/json" },
              })
            );
          });

          if (request.body) {
            const reader = request.body.getReader();
            const pump = (): void => {
              reader
                .read()
                .then(({ done, value }) => {
                  if (done) {
                    proxyReq.end();
                    return;
                  }
                  proxyReq.write(value);
                  pump();
                })
                .catch((err) => {
                  proxyReq.destroy(err);
                  reject(err);
                });
            };
            pump();
          } else {
            proxyReq.end();
          }
        });
      } catch (err) {
        releaseActiveRequest();
        throw err;
      }
    };
  }

  #emitStats(
    functionName: string,
    startTime: number,
    statusCode: number,
    timedOut: boolean
  ): void {
    if (!this.#options.onRequestStats) return;
    const endTime = Date.now();
    this.#options.onRequestStats({
      functionName,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      statusCode,
      timedOut,
    });
  }
}
```

- [ ] **Step 2: Run lint**

Run: `npx biome check src/server/core/WorkerRequestHandler.ts`

- [ ] **Step 3: Commit**

```bash
git add src/server/core/WorkerRequestHandler.ts
git commit -m "refactor: update WorkerRequestHandler to use WorkerInstance"
```

---

### Task 9: Update EdgeFunctionServer for eager spawn changes

**Files:**
- Modify: `src/server/core/EdgeFunctionServer.ts`

- [ ] **Step 1: Update the eager spawn logic**

In `EdgeFunctionServer.start()`, replace the eager spawn block (lines 111-117):

```ts
// Old:
if (this.#options.eagerSpawn) {
  await Promise.all(
    this.#registry
      .listFunctions()
      .map((name) => this.#pool!.getOrCreate(name))
  );
}

// New:
await this.#pool.eagerSpawn(this.#registry.listFunctions());
```

This delegates to `WorkerPool.eagerSpawn()` which handles per-function `eagerSpawn` overrides and spawns `max(minWorkers, 1)` instances per function.

- [ ] **Step 2: Update getWorkerStats return type**

The return type of `getWorkerStats` changes from `{ totalRequests, uptimeMs, restartCount }` to `PoolStats`. Update the method:

```ts
getWorkerStats(name: string): {
  totalRequests: number;
  uptimeMs: number;
  restartCount: number;
} {
  if (!this.#pool) throw new Error("Server is not started");
  const stats = this.#pool.getStats(name);
  // Backward-compatible: return flat stats
  return {
    totalRequests: stats.totalRequests,
    uptimeMs: stats.instances.length > 0
      ? Math.max(...stats.instances.map((i) => i.uptimeMs))
      : 0,
    restartCount: stats.restartCount,
  };
}
```

- [ ] **Step 3: Run lint**

Run: `npx biome check src/server/core/EdgeFunctionServer.ts`

- [ ] **Step 4: Commit**

```bash
git add src/server/core/EdgeFunctionServer.ts
git commit -m "refactor: update EdgeFunctionServer for pool concurrency and eager spawn"
```

---

### Task 10: Update exports

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Add new type exports**

Add to `src/server/index.ts`:

```ts
export type {
  WorkerInstance,
  AcquireResult,
  PoolStats,
  InstanceStats,
} from "./core/WorkerInstance.js";
```

- [ ] **Step 2: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: export WorkerInstance, PoolStats types"
```

---

### Task 11: Run all existing tests and fix failures

**Files:**
- Potentially modify: various test files

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run src/test/`

Fix any compilation errors or test failures. Common expected issues:
- Tests that directly access `WorkerPool` methods with old signatures (old `incrementActiveRequests(name)` → new `incrementActiveRequests(name, instanceId)`)
- The `getWorkerStats` backward-compat wrapper should handle most stats-related tests

- [ ] **Step 2: Fix any remaining test failures**

Known likely breakages to look for:

1. **`getWorkerStats` assertions:** Tests that check `uptimeMs` may get slightly different values since it now returns `Math.max(...)` across instances. These should still pass since the behavior is equivalent for single-worker (default).

2. **`eagerSpawn` test in `lifecycle.test.ts`:** The eager spawn logic changed to use `pool.eagerSpawn()`. The test already has the updated function list (Task 4), but verify it still passes.

3. **`idle-timeout.test.ts`:** These tests rely on `incrementActiveRequests(name)` / `decrementActiveRequests(name)` being called by WorkerRequestHandler. The new handler uses `(name, instanceId)` which delegates to the manager. The behavior should be equivalent.

4. **`health-checks.test.ts`:** Health checks are now managed per-instance inside `WorkerLifecycleManager`. The behavior should be equivalent for single-worker (maxWorkers:1 default), but verify the restart detection works.

5. **Any test calling `incrementRequestCount`:** The method is now a no-op. Check that no tests assert `totalRequests` after calling it directly (they likely use `getWorkerStats` which aggregates from instances).

- [ ] **Step 3: Verify all tests pass**

Run: `npx vitest run src/test/`
Expected: All existing tests pass

- [ ] **Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix: update tests for WorkerPool refactor"
```

---

## Chunk 4: Integration Tests

### Task 12: Write integration tests for worker pool concurrency

**Files:**
- Create: `src/test/server/worker-pool-concurrency.test.ts`

These are end-to-end tests that spawn real EdgeFunctionServer instances with real Deno workers.

- [ ] **Step 1: Write integration tests**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import { httpRequest } from "../helpers/http.js";
import { FUNCTIONS_DIR, IMPORT_MAP } from "../helpers/fixtures.js";

describe(
  "EdgeFunctionServer – worker pool concurrency",
  { timeout: 30_000 },
  () => {
    let server: EdgeFunctionServer | undefined;

    afterEach(async () => {
      if (server) {
        await server.stop();
        server = undefined;
      }
    });

    it("default maxWorkers:1 behaves like single worker", async () => {
      const readyCalls: string[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        onFunctionReady: (name) => readyCalls.push(name),
      });
      await server.start();

      const res = await httpRequest(server.port, "/hello");
      expect(res.status).toBe(200);
      expect(res.body).toBe("Hello from edge function!");

      // Only one ready call (single worker)
      expect(readyCalls.filter((n) => n === "hello")).toHaveLength(1);
    });

    it("concurrent requests scale up to maxWorkers", async () => {
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        maxWorkers: 3,
      });
      await server.start();

      // Send 3 concurrent slow requests to trigger scale-up
      const promises = Array.from({ length: 3 }, () =>
        httpRequest(server!.port, "/slow?delay=2000")
      );

      // Give time for scaling
      await new Promise((r) => setTimeout(r, 1000));

      const stats = server.getWorkerStats("slow");
      // Should have spawned multiple workers
      expect(stats.totalRequests).toBeGreaterThan(0);

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(200);
      }
    });

    it("idle worker scales down when above minWorkers", async () => {
      const coldCalls: string[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        maxWorkers: 3,
        minWorkers: 1,
        idleTimeout: 300,
        onFunctionCold: (name) => coldCalls.push(name),
      });
      await server.start();

      // Trigger 2 concurrent requests to scale up
      const [r1, r2] = await Promise.all([
        httpRequest(server.port, "/slow?delay=500"),
        httpRequest(server.port, "/slow?delay=500"),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // Wait for idle timeout to trigger scale-down
      await new Promise((r) => setTimeout(r, 600));

      // Should NOT go fully cold (minWorkers=1)
      expect(coldCalls).not.toContain("slow");

      // Should still be able to serve requests
      const res = await httpRequest(server.port, "/slow?delay=100");
      expect(res.status).toBe(200);
    });

    it("onFunctionCold only fires when last instance terminated", async () => {
      const coldCalls: string[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        maxWorkers: 2,
        minWorkers: 0,
        idleTimeout: 300,
        onFunctionCold: (name) => coldCalls.push(name),
      });
      await server.start();

      await Promise.all([
        httpRequest(server.port, "/slow?delay=500"),
        httpRequest(server.port, "/slow?delay=500"),
      ]);

      // Wait for all idle timeouts
      await new Promise((r) => setTimeout(r, 800));

      // Should fire exactly once for the function going fully cold
      expect(coldCalls.filter((n) => n === "slow")).toHaveLength(1);
    });

    it("per-function maxWorkers override from function.json", async () => {
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        maxWorkers: 1, // server default is 1
      });
      await server.start();

      // pool-test has maxWorkers: 3 in function.json
      // Send 3 concurrent requests
      const promises = Array.from({ length: 3 }, () =>
        httpRequest(server!.port, "/pool-test")
      );

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.body).toBe("pool-test");
      }
    });

    it("at capacity routes to least-loaded without error", async () => {
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        maxWorkers: 2,
      });
      await server.start();

      // Send 4 requests with only 2 workers max — should not error
      const promises = Array.from({ length: 4 }, () =>
        httpRequest(server!.port, "/hello")
      );

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(200);
      }
    });

    it("eagerSpawn spawns max(minWorkers, 1) at startup", async () => {
      const readyCalls: string[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        eagerSpawn: true,
        importMapPath: IMPORT_MAP,
        workerOptions: {
          runFlags: ["--allow-net", "--allow-env", "--allow-read"],
        },
        onFunctionReady: (name) => readyCalls.push(name),
      });
      await server.start();

      // All functions should have at least one ready call
      expect(readyCalls.length).toBeGreaterThan(0);

      // eager-override has eagerSpawn: true, minWorkers: 2
      // Verify it was eagerly spawned
      expect(readyCalls).toContain("eager-override");
    });

    it("per-function eagerSpawn:false skips eager spawning", async () => {
      const readyCalls: string[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        eagerSpawn: false, // Server default is false
        importMapPath: IMPORT_MAP,
        workerOptions: {
          runFlags: ["--allow-net", "--allow-env", "--allow-read"],
        },
        onFunctionReady: (name) => readyCalls.push(name),
      });
      await server.start();

      // eager-override has eagerSpawn: true in function.json, should still spawn
      expect(readyCalls).toContain("eager-override");

      // hello has no eagerSpawn override, server default false → should NOT spawn
      expect(readyCalls).not.toContain("hello");
    });

    it("health check restarts only unhealthy instance, others unaffected", async () => {
      const unhealthyCalls: { name: string; failures: number }[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        maxWorkers: 2,
        healthCheckInterval: 100,
        healthCheckTimeout: 200,
        healthCheckMaxFailures: 2,
        onWorkerUnhealthy: (name, failures) =>
          unhealthyCalls.push({ name, failures }),
      });
      await server.start();

      // Spawn 2 workers: one healthy (hello), one that can block (unresponsive)
      const [r1, r2] = await Promise.all([
        httpRequest(server.port, "/unresponsive"),
        httpRequest(server.port, "/hello"),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // Block unresponsive to make it fail health checks
      await httpRequest(server.port, "/unresponsive?block=true");

      // Wait for health check to detect and restart
      await new Promise((r) => setTimeout(r, 3000));

      // Unresponsive should have been restarted
      expect(unhealthyCalls.length).toBeGreaterThanOrEqual(1);

      // Hello should still work (unaffected)
      const r3 = await httpRequest(server.port, "/hello");
      expect(r3.status).toBe(200);
      expect(r3.body).toBe("Hello from edge function!");

      // Unresponsive should also work after restart
      const r4 = await httpRequest(server.port, "/unresponsive");
      expect(r4.status).toBe(200);
    });

    it("backward compatibility: no config changes = single worker behavior", async () => {
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        // No minWorkers, maxWorkers, or pool config
      });
      await server.start();

      const res1 = await httpRequest(server.port, "/hello");
      expect(res1.status).toBe(200);

      const res2 = await httpRequest(server.port, "/hello");
      expect(res2.status).toBe(200);

      // Should work identically to pre-concurrency behavior
      expect(res2.body).toBe("Hello from edge function!");
    });

    it("restart terminates all instances and respawns", async () => {
      const readyCalls: string[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        maxWorkers: 2,
        onFunctionReady: (name) => readyCalls.push(name),
      });
      await server.start();

      // Spawn workers
      await Promise.all([
        httpRequest(server.port, "/hello"),
        httpRequest(server.port, "/hello"),
      ]);

      readyCalls.length = 0;
      await server.restartFunction("hello");

      // Should have respawned
      const res = await httpRequest(server.port, "/hello");
      expect(res.status).toBe(200);
      expect(readyCalls).toContain("hello");
    });
  }
);
```

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run src/test/server/worker-pool-concurrency.test.ts`
Expected: All pass

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run src/test/`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/test/server/worker-pool-concurrency.test.ts
git commit -m "test: add worker pool concurrency integration tests"
```

---

### Task 13: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run src/test/`
Expected: All tests pass

- [ ] **Step 2: Run lint on all changed files**

Run: `npx biome check src/`
Expected: No errors

- [ ] **Step 3: Verify backward compatibility**

Run: `npx vitest run src/test/server/routing.test.ts src/test/server/lifecycle.test.ts src/test/server/idle-timeout.test.ts src/test/server/health-checks.test.ts`
Expected: All existing tests pass unchanged (except the function list assertions updated in Task 4)

- [ ] **Step 4: Final commit if any remaining changes**

```bash
git add -A
git commit -m "chore: final cleanup for worker pool concurrency"
```

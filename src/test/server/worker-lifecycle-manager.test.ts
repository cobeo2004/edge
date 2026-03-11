import { describe, it, expect, vi, afterEach } from "vitest";
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
  let manager: WorkerLifecycleManager | undefined;

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
  });

  // 1. acquire returns spawn when no instances exist
  it("acquire returns spawn when no instances exist", () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 5,
    });
    const result = manager.acquire();
    expect(result.kind).toBe("spawn");
  });

  // 2. acquire returns instance when one exists
  it("acquire returns instance when one exists", () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 5,
    });
    const w = mockWorker();
    const inst = createWorkerInstance(manager.nextId(), "fn", w);
    manager.addInstance(inst);

    const result = manager.acquire();
    expect(result.kind).toBe("instance");
    if (result.kind === "instance") {
      expect(result.instance.id).toBe(inst.id);
    }
  });

  // 3. acquire returns least-loaded instance (idle instance chosen over busy one)
  it("acquire returns least-loaded instance (idle over busy)", () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 5,
    });

    const w1 = mockWorker();
    const w2 = mockWorker();
    const inst1 = createWorkerInstance(manager.nextId(), "fn", w1);
    const inst2 = createWorkerInstance(manager.nextId(), "fn", w2);

    // inst1 is busy, inst2 is idle — least-loaded should be inst2 (activeRequests=0)
    inst1.activeRequests = 3;
    inst2.activeRequests = 0;

    manager.addInstance(inst1);
    manager.addInstance(inst2);

    const result = manager.acquire();
    // inst2 is idle (activeRequests===0) so it should be returned directly
    expect(result.kind).toBe("instance");
    if (result.kind === "instance") {
      expect(result.instance.id).toBe(inst2.id);
    }
  });

  // 3. acquire returns least-loaded instance (proper test at capacity)
  it("acquire returns least-loaded instance when at capacity and all busy", () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 2,
    });

    const w1 = mockWorker();
    const w2 = mockWorker();
    const inst1 = createWorkerInstance(manager.nextId(), "fn", w1);
    const inst2 = createWorkerInstance(manager.nextId(), "fn", w2);

    inst1.activeRequests = 5;
    inst2.activeRequests = 2;

    manager.addInstance(inst1);
    manager.addInstance(inst2);

    const result = manager.acquire();
    expect(result.kind).toBe("instance");
    if (result.kind === "instance") {
      expect(result.instance.id).toBe(inst2.id);
    }
  });

  // 4. acquire returns spawn when all instances busy and under maxWorkers
  it("acquire returns spawn when all instances busy and under maxWorkers", () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 5,
    });

    const w = mockWorker();
    const inst = createWorkerInstance(manager.nextId(), "fn", w);
    inst.activeRequests = 2;
    manager.addInstance(inst);

    const result = manager.acquire();
    expect(result.kind).toBe("spawn");
  });

  // 5. acquire returns least-loaded when at maxWorkers and all busy (no spawns in-flight)
  it("acquire returns least-loaded when at maxWorkers and all busy", () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 2,
    });

    const w1 = mockWorker();
    const w2 = mockWorker();
    const inst1 = createWorkerInstance(manager.nextId(), "fn", w1);
    const inst2 = createWorkerInstance(manager.nextId(), "fn", w2);

    inst1.activeRequests = 10;
    inst2.activeRequests = 3;

    manager.addInstance(inst1);
    manager.addInstance(inst2);

    // No spawning in-flight, at capacity
    const result = manager.acquire();
    expect(result.kind).toBe("instance");
    if (result.kind === "instance") {
      expect(result.instance.id).toBe(inst2.id);
    }
  });

  // 6. acquire returns wait when spawn is in-flight at capacity
  it("acquire returns wait when spawn is in-flight at capacity", () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 1,
    });

    // Reserve a spawn slot so spawningCount = 1 = maxWorkers
    manager.reserveSpawnSlot();

    const result = manager.acquire();
    expect(result.kind).toBe("wait");
    if (result.kind === "wait") {
      expect(result.promise).toBeInstanceOf(Promise);
    }
  });

  // 7. spawningCount prevents overshooting maxWorkers
  it("spawningCount prevents overshooting maxWorkers", () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 2,
    });

    // Reserve both slots
    manager.reserveSpawnSlot();
    manager.reserveSpawnSlot();

    // No instances yet but spawningCount == maxWorkers => wait
    const result = manager.acquire();
    expect(result.kind).toBe("wait");
  });

  // 8. releaseSpawnSlot notifies waiters
  it("releaseSpawnSlot notifies waiters", async () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
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

    // Not resolved yet
    expect(resolved).toBe(false);

    // Release the slot — should notify waiters
    manager.releaseSpawnSlot();

    // Allow microtasks to run
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  // 9. nextId returns monotonically increasing IDs
  it("nextId returns monotonically increasing IDs", () => {
    manager = new WorkerLifecycleManager({
      functionName: "myfn",
      minWorkers: 0,
      maxWorkers: 5,
    });

    const id0 = manager.nextId();
    const id1 = manager.nextId();
    const id2 = manager.nextId();

    expect(id0).toBe("myfn-0");
    expect(id1).toBe("myfn-1");
    expect(id2).toBe("myfn-2");
  });

  // 10. removeInstance terminates worker and removes from pool
  it("removeInstance terminates worker and removes from pool", () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 5,
    });

    const w = mockWorker();
    const inst = createWorkerInstance(manager.nextId(), "fn", w);
    manager.addInstance(inst);

    expect(manager.instanceCount).toBe(1);

    manager.removeInstance(inst.id);

    expect(manager.instanceCount).toBe(0);
    expect(w.terminate).toHaveBeenCalledOnce();
  });

  // 11. onFunctionCold fires when last instance removed
  it("onFunctionCold fires when last instance removed", () => {
    const onFunctionCold = vi.fn();
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 5,
      onFunctionCold,
    });

    const w = mockWorker();
    const inst = createWorkerInstance(manager.nextId(), "fn", w);
    manager.addInstance(inst);

    expect(onFunctionCold).not.toHaveBeenCalled();

    manager.removeInstance(inst.id);

    expect(onFunctionCold).toHaveBeenCalledOnce();
    expect(onFunctionCold).toHaveBeenCalledWith("fn");
  });

  // 12. onFunctionReady fires only once (first instance)
  it("onFunctionReady fires only once (first instance)", () => {
    const onFunctionReady = vi.fn();
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 5,
      onFunctionReady,
    });

    const w1 = mockWorker();
    const w2 = mockWorker();
    const inst1 = createWorkerInstance(manager.nextId(), "fn", w1);
    const inst2 = createWorkerInstance(manager.nextId(), "fn", w2);

    manager.addInstance(inst1);
    manager.addInstance(inst2);

    expect(onFunctionReady).toHaveBeenCalledOnce();
    expect(onFunctionReady).toHaveBeenCalledWith("fn");
  });

  // 13. idle timer fires and scales down when above minWorkers
  it("idle timer fires and scales down when above minWorkers", async () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 5,
      idleTimeout: 100,
    });

    const w = mockWorker();
    const inst = createWorkerInstance(manager.nextId(), "fn", w);
    manager.addInstance(inst);

    expect(manager.instanceCount).toBe(1);

    // Wait for idle timer to fire
    await new Promise((r) => setTimeout(r, 200));

    expect(manager.instanceCount).toBe(0);
    expect(w.terminate).toHaveBeenCalledOnce();
  });

  // 14. idle timer does NOT scale below minWorkers
  it("idle timer does NOT scale below minWorkers", async () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 1,
      maxWorkers: 5,
      idleTimeout: 100,
    });

    const w = mockWorker();
    const inst = createWorkerInstance(manager.nextId(), "fn", w);
    manager.addInstance(inst);

    expect(manager.instanceCount).toBe(1);

    // Wait for idle timer to fire
    await new Promise((r) => setTimeout(r, 200));

    // Should NOT have scaled down because instanceCount (1) <= minWorkers (1)
    expect(manager.instanceCount).toBe(1);
    expect(w.terminate).not.toHaveBeenCalled();
  });

  // 15. getStats returns aggregate and per-instance data
  it("getStats returns aggregate and per-instance data", () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 5,
    });

    const w1 = mockWorker();
    const w2 = mockWorker();
    const id1 = manager.nextId();
    const id2 = manager.nextId();
    const inst1 = createWorkerInstance(id1, "fn", w1);
    const inst2 = createWorkerInstance(id2, "fn", w2);

    inst1.activeRequests = 2;
    inst1.totalRequests = 10;
    inst2.activeRequests = 3;
    inst2.totalRequests = 7;

    manager.addInstance(inst1);
    manager.addInstance(inst2);

    const stats = manager.getStats();

    expect(stats.functionName).toBe("fn");
    expect(stats.instanceCount).toBe(2);
    expect(stats.activeRequests).toBe(5);
    expect(stats.totalRequests).toBe(17);
    expect(stats.restartCount).toBe(0);
    expect(stats.instances).toHaveLength(2);

    const s1 = stats.instances.find((s) => s.id === id1);
    const s2 = stats.instances.find((s) => s.id === id2);

    expect(s1).toBeDefined();
    expect(s1?.activeRequests).toBe(2);
    expect(s1?.totalRequests).toBe(10);

    expect(s2).toBeDefined();
    expect(s2?.activeRequests).toBe(3);
    expect(s2?.totalRequests).toBe(7);
  });

  // 16. restart disposes all and increments restartCount
  it("restart disposes all and increments restartCount", () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 5,
    });

    const w1 = mockWorker();
    const w2 = mockWorker();
    const inst1 = createWorkerInstance(manager.nextId(), "fn", w1);
    const inst2 = createWorkerInstance(manager.nextId(), "fn", w2);

    manager.addInstance(inst1);
    manager.addInstance(inst2);

    expect(manager.instanceCount).toBe(2);

    manager.restart();

    expect(manager.instanceCount).toBe(0);
    expect(w1.terminate).toHaveBeenCalledOnce();
    expect(w2.terminate).toHaveBeenCalledOnce();

    const stats = manager.getStats();
    expect(stats.restartCount).toBe(1);
  });

  // 17. incrementActiveRequests is no-op for unknown id
  it("incrementActiveRequests is no-op for unknown id", () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 5,
    });

    // Should not throw
    expect(() => {
      manager!.incrementActiveRequests("unknown-id");
    }).not.toThrow();

    expect(manager.instanceCount).toBe(0);
  });

  // 18. idle timer does not fire onFunctionCold when at minWorkers
  it("idle timer does not fire onFunctionCold when at minWorkers", async () => {
    const onFunctionCold = vi.fn();
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 1,
      maxWorkers: 5,
      idleTimeout: 100,
      onFunctionCold,
    });

    const w = mockWorker();
    const inst = createWorkerInstance(manager.nextId(), "fn", w);
    manager.addInstance(inst);

    await new Promise((r) => setTimeout(r, 200));

    // Instance is preserved (at minWorkers), so cold should NOT fire
    expect(onFunctionCold).not.toHaveBeenCalled();
  });

  // 19. onFunctionCold fires when minWorkers:0 and last idle instance removed
  it("onFunctionCold fires when minWorkers:0 and last idle instance removed via idle timer", async () => {
    const onFunctionCold = vi.fn();
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 5,
      idleTimeout: 100,
      onFunctionCold,
    });

    const w = mockWorker();
    const inst = createWorkerInstance(manager.nextId(), "fn", w);
    manager.addInstance(inst);

    await new Promise((r) => setTimeout(r, 200));

    expect(manager.instanceCount).toBe(0);
    expect(onFunctionCold).toHaveBeenCalledOnce();
    expect(onFunctionCold).toHaveBeenCalledWith("fn");
  });

  // 20. dispose cleans up all instances
  it("dispose cleans up all instances", () => {
    manager = new WorkerLifecycleManager({
      functionName: "fn",
      minWorkers: 0,
      maxWorkers: 5,
    });

    const w1 = mockWorker();
    const w2 = mockWorker();
    const w3 = mockWorker();
    const inst1 = createWorkerInstance(manager.nextId(), "fn", w1);
    const inst2 = createWorkerInstance(manager.nextId(), "fn", w2);
    const inst3 = createWorkerInstance(manager.nextId(), "fn", w3);

    manager.addInstance(inst1);
    manager.addInstance(inst2);
    manager.addInstance(inst3);

    expect(manager.instanceCount).toBe(3);

    manager.dispose();

    expect(manager.instanceCount).toBe(0);
    expect(w1.terminate).toHaveBeenCalledOnce();
    expect(w2.terminate).toHaveBeenCalledOnce();
    expect(w3.terminate).toHaveBeenCalledOnce();
  });
});

import { describe, it, expect } from "vitest";
import { WorkerLifecycleManager } from "../../server/core/WorkerLifecycleManager.js";

function createManager(
  overrides: Partial<
    ConstructorParameters<typeof WorkerLifecycleManager>[0]
  > = {}
) {
  return new WorkerLifecycleManager({
    functionName: "test-fn",
    minWorkers: 0,
    maxWorkers: 2,
    ...overrides,
  });
}

describe("WorkerLifecycleManager — WebSocket awareness", () => {
  describe("connection count tracking", () => {
    it("should return 0 for unknown instance", () => {
      const mgr = createManager();
      expect(mgr.getWebSocketCount("unknown-id")).toBe(0);
    });

    it("should increment count correctly", () => {
      const mgr = createManager();
      mgr.incrementWebSocketCount("inst-1");
      expect(mgr.getWebSocketCount("inst-1")).toBe(1);
      mgr.incrementWebSocketCount("inst-1");
      expect(mgr.getWebSocketCount("inst-1")).toBe(2);
    });

    it("should decrement count correctly", () => {
      const mgr = createManager();
      mgr.incrementWebSocketCount("inst-1");
      mgr.incrementWebSocketCount("inst-1");
      mgr.decrementWebSocketCount("inst-1");
      expect(mgr.getWebSocketCount("inst-1")).toBe(1);
      mgr.decrementWebSocketCount("inst-1");
      expect(mgr.getWebSocketCount("inst-1")).toBe(0);
    });

    it("should not decrement below 0", () => {
      const mgr = createManager();
      mgr.decrementWebSocketCount("inst-1");
      expect(mgr.getWebSocketCount("inst-1")).toBe(0);
      mgr.decrementWebSocketCount("inst-1");
      expect(mgr.getWebSocketCount("inst-1")).toBe(0);
    });

    it("should track counts per instance independently", () => {
      const mgr = createManager();
      mgr.incrementWebSocketCount("inst-1");
      mgr.incrementWebSocketCount("inst-1");
      mgr.incrementWebSocketCount("inst-2");

      expect(mgr.getWebSocketCount("inst-1")).toBe(2);
      expect(mgr.getWebSocketCount("inst-2")).toBe(1);

      mgr.decrementWebSocketCount("inst-1");
      expect(mgr.getWebSocketCount("inst-1")).toBe(1);
      expect(mgr.getWebSocketCount("inst-2")).toBe(1);
    });
  });

  describe("websocketKeepsAlive option", () => {
    it("should default to true", () => {
      const mgr = createManager();
      // Verify indirectly: incrementing an unknown instance should not throw
      expect(() => mgr.incrementWebSocketCount("inst-1")).not.toThrow();
    });

    it("should accept explicit false", () => {
      const mgr = createManager({ websocketKeepsAlive: false });
      mgr.incrementWebSocketCount("inst-1");
      expect(mgr.getWebSocketCount("inst-1")).toBe(1);
    });
  });
});

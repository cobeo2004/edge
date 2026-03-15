import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebSocketProxyHandler } from "../../server/core/WebSocketProxyHandler.js";
import type { WebSocketProxyHandlerOptions } from "../../server/core/WebSocketProxyHandler.js";

describe("WebSocketProxyHandler", () => {
  const defaultOpts: WebSocketProxyHandlerOptions = {
    maxWebSocketConnections: 10,
  };

  let handler: WebSocketProxyHandler;

  beforeEach(() => {
    handler = new WebSocketProxyHandler({ ...defaultOpts });
  });

  describe("connection tracking", () => {
    it("should add and count connections", () => {
      handler.addConnection("fn1", "w1", "c1");
      handler.addConnection("fn1", "w1", "c2");
      expect(handler.getConnectionCount("fn1", "w1")).toBe(2);
    });

    it("should remove connections", () => {
      handler.addConnection("fn1", "w1", "c1");
      handler.addConnection("fn1", "w1", "c2");
      handler.removeConnection("fn1", "w1", "c1");
      expect(handler.getConnectionCount("fn1", "w1")).toBe(1);
    });

    it("should track counts independently per worker", () => {
      handler.addConnection("fn1", "w1", "c1");
      handler.addConnection("fn1", "w1", "c2");
      handler.addConnection("fn1", "w2", "c3");
      expect(handler.getConnectionCount("fn1", "w1")).toBe(2);
      expect(handler.getConnectionCount("fn1", "w2")).toBe(1);
    });

    it("should return 0 for unknown function/worker", () => {
      expect(handler.getConnectionCount("unknown", "w1")).toBe(0);
      expect(handler.getConnectionCount("fn1", "unknown")).toBe(0);
    });
  });

  describe("maxWebSocketConnections enforcement", () => {
    it("should return false from canAcceptConnection when at limit", () => {
      const h = new WebSocketProxyHandler({ maxWebSocketConnections: 2 });
      h.addConnection("fn1", "w1", "c1");
      h.addConnection("fn1", "w1", "c2");
      expect(h.canAcceptConnection("fn1", "w1")).toBe(false);
    });

    it("should return true from canAcceptConnection when below limit", () => {
      const h = new WebSocketProxyHandler({ maxWebSocketConnections: 2 });
      h.addConnection("fn1", "w1", "c1");
      expect(h.canAcceptConnection("fn1", "w1")).toBe(true);
    });

    it("should return true for empty worker", () => {
      expect(handler.canAcceptConnection("fn1", "w1")).toBe(true);
    });
  });

  describe("lifecycle hooks", () => {
    it("should fire onWebSocketConnect on addConnection", () => {
      const onConnect = vi.fn();
      const h = new WebSocketProxyHandler({
        maxWebSocketConnections: 10,
        onWebSocketConnect: onConnect,
      });
      h.addConnection("fn1", "w1", "c1");
      expect(onConnect).toHaveBeenCalledWith("fn1", "c1");
    });

    it("should fire onWebSocketClose on removeConnection with code/reason", () => {
      const onClose = vi.fn();
      const h = new WebSocketProxyHandler({
        maxWebSocketConnections: 10,
        onWebSocketClose: onClose,
      });
      h.addConnection("fn1", "w1", "c1");
      h.removeConnection("fn1", "w1", "c1", 1000, "normal");
      expect(onClose).toHaveBeenCalledWith("fn1", "c1", 1000, "normal");
    });

    it("should fire onWebSocketClose with defaults when no code/reason", () => {
      const onClose = vi.fn();
      const h = new WebSocketProxyHandler({
        maxWebSocketConnections: 10,
        onWebSocketClose: onClose,
      });
      h.addConnection("fn1", "w1", "c1");
      h.removeConnection("fn1", "w1", "c1");
      expect(onClose).toHaveBeenCalledWith("fn1", "c1", 1005, "");
    });

    it("should fire onWebSocketError via emitError", () => {
      const onError = vi.fn();
      const h = new WebSocketProxyHandler({
        maxWebSocketConnections: 10,
        onWebSocketError: onError,
      });
      const err = new Error("test error");
      h.emitError("fn1", "c1", err);
      expect(onError).toHaveBeenCalledWith("fn1", "c1", err);
    });

    it("should not throw when hooks are not registered", () => {
      const h = new WebSocketProxyHandler({ maxWebSocketConnections: 10 });
      expect(() => h.addConnection("fn1", "w1", "c1")).not.toThrow();
      expect(() => h.removeConnection("fn1", "w1", "c1")).not.toThrow();
      expect(() => h.emitError("fn1", "c1", new Error("x"))).not.toThrow();
    });
  });

  describe("closeAllConnections", () => {
    it("should remove all connections for a worker", () => {
      handler.addConnection("fn1", "w1", "c1");
      handler.addConnection("fn1", "w1", "c2");
      handler.addConnection("fn1", "w1", "c3");
      handler.closeAllConnections("fn1", "w1", 1001, "going away");
      expect(handler.getConnectionCount("fn1", "w1")).toBe(0);
    });

    it("should fire onClose for each connection", () => {
      const onClose = vi.fn();
      const h = new WebSocketProxyHandler({
        maxWebSocketConnections: 10,
        onWebSocketClose: onClose,
      });
      h.addConnection("fn1", "w1", "c1");
      h.addConnection("fn1", "w1", "c2");
      h.closeAllConnections("fn1", "w1", 1001, "shutdown");
      expect(onClose).toHaveBeenCalledTimes(2);
      expect(onClose).toHaveBeenCalledWith("fn1", "c1", 1001, "shutdown");
      expect(onClose).toHaveBeenCalledWith("fn1", "c2", 1001, "shutdown");
    });

    it("should handle unknown worker gracefully", () => {
      expect(() =>
        handler.closeAllConnections("fn1", "unknown", 1001, "x")
      ).not.toThrow();
    });
  });

  describe("closeAllConnectionsForFunction", () => {
    it("should remove connections across all workers for a function", () => {
      handler.addConnection("fn1", "w1", "c1");
      handler.addConnection("fn1", "w1", "c2");
      handler.addConnection("fn1", "w2", "c3");
      handler.addConnection("fn2", "w3", "c4");
      handler.closeAllConnectionsForFunction("fn1", 1001, "shutdown");
      expect(handler.getConnectionCount("fn1", "w1")).toBe(0);
      expect(handler.getConnectionCount("fn1", "w2")).toBe(0);
      expect(handler.getConnectionCount("fn2", "w3")).toBe(1);
    });

    it("should fire onClose for each removed connection", () => {
      const onClose = vi.fn();
      const h = new WebSocketProxyHandler({
        maxWebSocketConnections: 10,
        onWebSocketClose: onClose,
      });
      h.addConnection("fn1", "w1", "c1");
      h.addConnection("fn1", "w2", "c2");
      h.closeAllConnectionsForFunction("fn1", 1000, "done");
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it("should handle unknown function gracefully", () => {
      expect(() =>
        handler.closeAllConnectionsForFunction("unknown", 1001, "x")
      ).not.toThrow();
    });
  });

  describe("per-worker limit override", () => {
    it("respects per-worker limit override", () => {
      const handler = new WebSocketProxyHandler({
        maxWebSocketConnections: 100,
      });
      handler.addConnection("fn", "w1", "c1");
      handler.addConnection("fn", "w1", "c2");

      // With per-worker limit of 2, should reject
      expect(handler.canAcceptConnection("fn", "w1", 2)).toBe(false);

      // With per-worker limit of 3, should accept
      expect(handler.canAcceptConnection("fn", "w1", 3)).toBe(true);

      // Without override, uses global default (100), should accept
      expect(handler.canAcceptConnection("fn", "w1")).toBe(true);
    });

    it("function A at limit rejects while function B still accepts", () => {
      const handler = new WebSocketProxyHandler({
        maxWebSocketConnections: 100,
      });
      handler.addConnection("fnA", "wA", "c1");
      handler.addConnection("fnA", "wA", "c2");
      handler.addConnection("fnB", "wB", "c3");

      // fnA at per-worker limit of 2
      expect(handler.canAcceptConnection("fnA", "wA", 2)).toBe(false);
      // fnB at 1 connection, per-worker limit of 5 — still accepts
      expect(handler.canAcceptConnection("fnB", "wB", 5)).toBe(true);
    });
  });

  describe("global connection cap", () => {
    it("rejects when total connections reach global cap", () => {
      const handler = new WebSocketProxyHandler({
        maxWebSocketConnections: 100,
        globalMaxWebSocketConnections: 3,
      });
      handler.addConnection("fnA", "w1", "c1");
      handler.addConnection("fnA", "w1", "c2");
      handler.addConnection("fnB", "w2", "c3");

      // Per-worker limit not hit (100), but global cap (3) reached
      expect(handler.canAcceptConnection("fnA", "w1")).toBe(false);
      expect(handler.canAcceptConnection("fnB", "w2")).toBe(false);
      // New function/worker also rejected
      expect(handler.canAcceptConnection("fnC", "w3")).toBe(false);
    });

    it("accepts after connection removed brings below global cap", () => {
      const handler = new WebSocketProxyHandler({
        maxWebSocketConnections: 100,
        globalMaxWebSocketConnections: 2,
      });
      handler.addConnection("fn", "w1", "c1");
      handler.addConnection("fn", "w1", "c2");
      expect(handler.canAcceptConnection("fn", "w1")).toBe(false);

      handler.removeConnection("fn", "w1", "c1");
      expect(handler.canAcceptConnection("fn", "w1")).toBe(true);
    });

    it("getTotalConnectionCount tracks across functions and workers", () => {
      const handler = new WebSocketProxyHandler({
        maxWebSocketConnections: 100,
      });
      expect(handler.getTotalConnectionCount()).toBe(0);

      handler.addConnection("fnA", "w1", "c1");
      expect(handler.getTotalConnectionCount()).toBe(1);

      handler.addConnection("fnB", "w2", "c2");
      expect(handler.getTotalConnectionCount()).toBe(2);

      handler.removeConnection("fnA", "w1", "c1");
      expect(handler.getTotalConnectionCount()).toBe(1);
    });

    it("no global cap when globalMaxWebSocketConnections not set", () => {
      const handler = new WebSocketProxyHandler({
        maxWebSocketConnections: 2,
      });
      handler.addConnection("fnA", "w1", "c1");
      handler.addConnection("fnB", "w2", "c2");
      handler.addConnection("fnC", "w3", "c3");

      // Per-worker limit (2) not hit for any worker, no global cap set
      expect(handler.canAcceptConnection("fnD", "w4")).toBe(true);
    });

    it("per-worker limit > global cap — per-worker passes but global rejects", () => {
      const handler = new WebSocketProxyHandler({
        maxWebSocketConnections: 100,
        globalMaxWebSocketConnections: 2,
      });
      handler.addConnection("fn", "w1", "c1");
      handler.addConnection("fn", "w1", "c2");

      // Per-worker limit is 100 (not reached), but global cap is 2 (reached)
      expect(handler.canAcceptConnection("fn", "w1")).toBe(false);
    });
  });

  describe("generateConnectionId", () => {
    it("should return unique UUIDs", () => {
      const id1 = handler.generateConnectionId();
      const id2 = handler.generateConnectionId();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });
  });
});

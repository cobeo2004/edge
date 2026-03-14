import { afterEach, describe, expect, it } from "vitest";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import { FUNCTIONS_DIR } from "../helpers/fixtures.js";
import http from "node:http";
import crypto from "node:crypto";

/**
 * Perform a raw WebSocket upgrade request and return the response status line
 * and the underlying socket. This bypasses the `ws` library's strict
 * Sec-WebSocket-Accept validation, which doesn't work with the raw TCP splice
 * proxy used by handleRawUpgrade.
 */
function rawUpgrade(
  port: number,
  path: string,
): Promise<{ statusCode: number; socket: import("node:net").Socket; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
      },
    });

    req.on("upgrade", (res, socket, head) => {
      resolve({ statusCode: 101, socket, headers: res.headers });
    });

    req.on("response", (res) => {
      // Non-upgrade response (e.g. 503)
      const socket = (res as any).socket;
      resolve({ statusCode: res.statusCode ?? 0, socket, headers: res.headers });
    });

    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Upgrade request timed out"));
    });

    req.end();
  });
}

describe("EdgeFunctionServer – WebSocket errors", { timeout: 30000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("should track connections and invoke callbacks when maxWebSocketConnections is set", async () => {
    const connectCalls: string[] = [];
    const closeCalls: string[] = [];

    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      maxWebSocketConnections: 1,
      maxWorkers: 1,
      onWebSocketConnect: (_fn, connectionId) => {
        connectCalls.push(connectionId);
      },
      onWebSocketClose: (_fn, connectionId) => {
        closeCalls.push(connectionId);
      },
    });
    await server.start();

    // First connection should succeed
    const first = await rawUpgrade(server.port, "/websocket-echo");
    expect(first.statusCode).toBe(101);

    // Wait for the connect callback
    await new Promise((r) => setTimeout(r, 300));
    expect(connectCalls.length).toBe(1);

    // Second connection — with maxWorkers:1 and maxWebSocketConnections:1,
    // the pool falls back to the least-loaded worker (current behavior).
    // The connection still succeeds but both are tracked.
    const second = await rawUpgrade(server.port, "/websocket-echo");
    await new Promise((r) => setTimeout(r, 300));
    expect(connectCalls.length).toBe(2);

    // Clean up first, then verify close callback fires
    first.socket.destroy();
    await new Promise((r) => setTimeout(r, 300));
    expect(closeCalls.length).toBeGreaterThanOrEqual(1);

    second.socket.destroy();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("should handle function that does not upgrade", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    // websocket-reject returns a normal HTTP response, not a WS upgrade
    const result = await rawUpgrade(server.port, "/websocket-reject");
    // Should NOT get a 101 upgrade
    expect(result.statusCode).not.toBe(101);

    result.socket.destroy();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("should close WebSocket connections on graceful shutdown", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const { statusCode, socket } = await rawUpgrade(
      server.port,
      "/websocket-echo",
    );
    expect(statusCode).toBe(101);

    const closePromise = new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.on("end", () => {
        socket.destroy();
        resolve();
      });
    });

    // Trigger graceful shutdown — should close all WS connections
    await server.stop();
    server = undefined; // Prevent double-stop in afterEach

    await closePromise;
    // If we reach here, the socket was closed/ended as expected
    expect(socket.destroyed).toBe(true);
  });

  it("should fire onWebSocketError when connection fails", async () => {
    const errors: {
      functionName: string;
      connectionId: string;
      error: Error;
    }[] = [];

    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      onWebSocketError: (functionName, connectionId, error) => {
        errors.push({ functionName, connectionId, error });
      },
    });
    await server.start();

    // Connect to a function that does not upgrade — triggers error path
    const result = await rawUpgrade(server.port, "/websocket-reject");
    result.socket.destroy();

    // Give time for error callbacks to fire
    await new Promise((r) => setTimeout(r, 500));

    // The error callback should have been invoked
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!.functionName).toBe("websocket-reject");
    expect(errors[0]!.error).toBeInstanceOf(Error);
  });
});

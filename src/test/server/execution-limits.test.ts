import { afterEach, describe, expect, it } from "vitest";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import { httpRequest } from "../helpers/http.js";
import { FUNCTIONS_DIR } from "../helpers/fixtures.js";
import type { RequestStats } from "../../worker/types.js";

describe("EdgeFunctionServer – execution limits", { timeout: 30_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("requestTimeout returns 504 on slow function", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      requestTimeout: 200,
    });
    await server.start();

    const res = await httpRequest(server.port, "/slow?delay=5000");
    expect(res.status).toBe(504);
    const json = JSON.parse(res.body);
    expect(json.error).toBe("Request timed out");
  });

  it("requestTimeout: fast request succeeds", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      requestTimeout: 5000,
    });
    await server.start();

    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(200);
  });

  it("onRequestStats callback fires with correct fields", async () => {
    const stats: RequestStats[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      onRequestStats: (s) => stats.push(s),
    });
    await server.start();

    await httpRequest(server.port, "/hello");
    // Wait a tick for the stats callback to fire (it's in the stream "end" event)
    await new Promise((r) => setTimeout(r, 50));

    expect(stats.length).toBe(1);
    expect(stats[0]!.functionName).toBe("hello");
    expect(stats[0]!.statusCode).toBe(200);
    expect(stats[0]!.timedOut).toBe(false);
    expect(stats[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(stats[0]!.startTime).toBeLessThanOrEqual(stats[0]!.endTime);
  });

  it("onRequestStats reports timeout", async () => {
    const stats: RequestStats[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      requestTimeout: 200,
      onRequestStats: (s) => stats.push(s),
    });
    await server.start();

    await httpRequest(server.port, "/slow?delay=5000");

    expect(stats.length).toBe(1);
    expect(stats[0]!.functionName).toBe("slow");
    expect(stats[0]!.statusCode).toBe(504);
    expect(stats[0]!.timedOut).toBe(true);
  });

  it("getWorkerStats returns accurate counts", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    await httpRequest(server.port, "/hello");
    await httpRequest(server.port, "/hello");

    const stats = server.getWorkerStats("hello");
    expect(stats.totalRequests).toBe(2);
    expect(stats.uptimeMs).toBeGreaterThan(0);
    expect(stats.restartCount).toBe(0);
  });

  it("getWorkerStats returns zeros for unknown function", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const stats = server.getWorkerStats("nonexistent");
    expect(stats.totalRequests).toBe(0);
    expect(stats.uptimeMs).toBe(0);
    expect(stats.restartCount).toBe(0);
  });
});

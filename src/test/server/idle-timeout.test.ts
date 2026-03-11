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

  it("worker stays warm while requests are in-flight", async () => {
    const coldFunctions: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 300,
      onFunctionCold: (name) => coldFunctions.push(name),
    });
    await server.start();

    const slowPromise = httpRequest(server.port, "/slow?delay=1000");
    await new Promise((r) => setTimeout(r, 500));
    expect(coldFunctions).not.toContain("slow");

    const res = await slowPromise;
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 500));
    expect(coldFunctions).toContain("slow");
  });

  it("idle timer resets on new request", async () => {
    const coldFunctions: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 500,
      onFunctionCold: (name) => coldFunctions.push(name),
    });
    await server.start();

    await httpRequest(server.port, "/hello");
    await new Promise((r) => setTimeout(r, 300));
    expect(coldFunctions).not.toContain("hello");
    await httpRequest(server.port, "/hello");

    await new Promise((r) => setTimeout(r, 300));
    expect(coldFunctions).not.toContain("hello");

    await new Promise((r) => setTimeout(r, 400));
    expect(coldFunctions).toContain("hello");
  });

  it("per-function idleTimeout override from function.json", async () => {
    const coldFunctions: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 5000,
      onFunctionCold: (name) => coldFunctions.push(name),
    });
    await server.start();

    const res = await httpRequest(server.port, "/idle-custom");
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 500));
    expect(coldFunctions).toContain("idle-custom");
  });

  it("onFunctionCold callback fires with correct function name", async () => {
    const coldCalls: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 300,
      onFunctionCold: (name) => coldCalls.push(name),
    });
    await server.start();

    await Promise.all([
      httpRequest(server.port, "/hello"),
      httpRequest(server.port, "/echo"),
    ]);

    await new Promise((r) => setTimeout(r, 600));
    expect(coldCalls.sort()).toEqual(["echo", "hello"]);
  });

  it("no idle timeout when idleTimeout is not set", async () => {
    const coldFunctions: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      onFunctionCold: (name) => coldFunctions.push(name),
    });
    await server.start();

    await httpRequest(server.port, "/hello");
    await new Promise((r) => setTimeout(r, 500));
    expect(coldFunctions).toHaveLength(0);

    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(200);
  });
});

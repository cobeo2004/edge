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

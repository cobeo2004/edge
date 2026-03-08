import { afterEach, describe, expect, it } from "vitest";
import { EdgeFunctionServer } from "../../server/EdgeFunctionServer.js";
import { httpRequest } from "../helpers/http.js";
import { FUNCTIONS_DIR } from "../helpers/fixtures.js";

describe("EdgeFunctionServer – routing", { timeout: 15_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("discovers functions", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();
    const fns = server.listFunctions();
    expect(fns).toEqual([
      "echo",
      "hello",
      "import-map-test",
      "npm-import",
      "wasm-test",
    ]);
  });

  it("routes to hello function", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();
    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(200);
    expect(res.body).toBe("Hello from edge function!");
  });

  it("rewrites path for echo function", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();
    const res = await httpRequest(server.port, "/echo/sub/path?q=1");
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.path).toBe("/sub/path");
    expect(json.search).toBe("?q=1");
    expect(json.method).toBe("GET");
  });

  it("returns 404 for unknown function", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();
    const res = await httpRequest(server.port, "/nonexistent");
    expect(res.status).toBe(404);
    const json = JSON.parse(res.body);
    expect(json.error).toBe("Function not found");
  });

  it("handles POST with body", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();
    const res = await httpRequest(server.port, "/echo", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello world",
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.method).toBe("POST");
    expect(json.body).toBe("hello world");
  });

  it("echo path is / when no trailing path", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();
    const res = await httpRequest(server.port, "/echo");
    const json = JSON.parse(res.body);
    expect(json.path).toBe("/");
    expect(json.search).toBe("");
  });
});

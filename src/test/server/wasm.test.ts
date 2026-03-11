import { afterEach, describe, expect, it } from "vitest";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import { httpRequest, httpRequestRaw } from "../helpers/http.js";
import { FUNCTIONS_DIR } from "../helpers/fixtures.js";

describe("EdgeFunctionServer – wasm-test function", { timeout: 30_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("returns 400 when no query params provided", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      workerOptions: {
        runFlags: ["--allow-net", "--allow-read", "--allow-env"],
      },
    });
    await server.start();
    const res = await httpRequest(server.port, "/wasm-test");
    expect(res.status).toBe(400);
  });

  it("returns 400 when image param is missing", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      workerOptions: {
        runFlags: ["--allow-net", "--allow-read", "--allow-env"],
      },
    });
    await server.start();
    const res = await httpRequest(server.port, "/wasm-test?width=100");
    expect(res.status).toBe(400);
  });

  it("returns 400 when neither width nor height is provided", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      workerOptions: {
        runFlags: ["--allow-net", "--allow-read", "--allow-env"],
      },
    });
    await server.start();
    const res = await httpRequest(
      server.port,
      "/wasm-test?image=https://example.com/img.png",
    );
    expect(res.status).toBe(400);
    expect(res.body).toContain("width");
  });

  it("returns 400 for invalid image URL", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      workerOptions: {
        runFlags: ["--allow-net", "--allow-read", "--allow-env"],
      },
    });
    await server.start();
    const res = await httpRequest(
      server.port,
      "/wasm-test?image=not-a-url&width=100",
    );
    expect(res.status).toBe(400);
    expect(res.body).toContain("'image' must be a valid URL");
  });

  it("resizes a real image", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      workerOptions: {
        runFlags: ["--allow-net", "--allow-read", "--allow-env"],
      },
    });
    await server.start();

    const imageUrl = encodeURIComponent("https://picsum.photos/200/200.jpg");
    const res = await httpRequestRaw(
      server.port,
      `/wasm-test?image=${imageUrl}&width=50`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\//);
    expect(res.body.length).toBeGreaterThan(0);
  });
});

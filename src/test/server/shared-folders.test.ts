import { afterEach, describe, expect, it } from "vitest";
import { EdgeFunctionServer } from "../../server/EdgeFunctionServer.js";
import { httpRequest } from "../helpers/http.js";
import { FUNCTIONS_DIR, IMPORT_MAP } from "../helpers/fixtures.js";

describe("EdgeFunctionServer – shared folders", { timeout: 15_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("excludes underscore-prefixed folders from function discovery", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();
    const fns = server.listFunctions();
    expect(fns).not.toContain("_shared");
    expect(fns).toContain("hello");
    expect(fns).toContain("echo");
  });

  it("functions can import from _shared/ via bare specifier", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();
    const res = await httpRequest(server.port, "/shared-test");
    expect(res.status).toBe(200);
    expect(res.body).toBe("shared works");
  });

  it("functions can import nested shared modules via bare specifier", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();
    const res = await httpRequest(server.port, "/shared-test/db");
    expect(res.status).toBe(200);
    expect(res.body).toBe("postgres://localhost:5432/test");
  });

  it("merges user import map with auto-generated shared entries", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      importMapPath: IMPORT_MAP,
      workerOptions: {
        runFlags: ["--allow-net", "--allow-env", "--allow-read"],
      },
    });
    await server.start();

    // User import map function still works
    const res1 = await httpRequest(server.port, "/import-map-test");
    expect(res1.status).toBe(200);
    expect(res1.body).toBe("hello from edge");

    // Shared folder function also works
    const res2 = await httpRequest(server.port, "/shared-test");
    expect(res2.status).toBe(200);
    expect(res2.body).toBe("shared works");
  });
});

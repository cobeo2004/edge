import { afterEach, describe, expect, it } from "vitest";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import { httpRequest } from "../helpers/http.js";
import { FUNCTIONS_DIR, IMPORT_MAP, DENO_CONFIG } from "../helpers/fixtures.js";

describe("EdgeFunctionServer – config", { timeout: 15_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("importMapPath resolves mapped imports in edge functions", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      importMapPath: IMPORT_MAP,
      workerOptions: {
        runFlags: ["--allow-net", "--allow-env", "--allow-read"],
      },
    });
    await server.start();
    const res = await httpRequest(server.port, "/import-map-test");
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello from edge");
  });

  it("configPath resolves imports from deno.json in edge functions", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      configPath: DENO_CONFIG,
      workerOptions: {
        runFlags: ["--allow-net", "--allow-env", "--allow-read"],
      },
    });
    await server.start();
    const res = await httpRequest(server.port, "/import-map-test");
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello from edge");
  });
});

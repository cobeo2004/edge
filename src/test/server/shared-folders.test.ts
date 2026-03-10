import fsp from "node:fs/promises";
import path from "node:path";
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

  it(
    "restarts all workers when shared file changes",
    { timeout: 20_000 },
    async () => {
      const restarts: string[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        hotReload: true,
        watchSharedFolders: true,
        onFunctionReady: (name) => restarts.push(name),
      });
      await server.start();

      // Trigger a request so the worker is running
      const res1 = await httpRequest(server.port, "/shared-test");
      expect(res1.status).toBe(200);
      restarts.length = 0; // Clear initial ready events

      // Touch a shared file to trigger hot-reload
      const sharedFile = path.join(FUNCTIONS_DIR, "_shared", "cors.ts");
      const original = await fsp.readFile(sharedFile, "utf-8");
      try {
        await fsp.writeFile(sharedFile, original + "\n// touch");

        // Wait for debounce + restart
        await new Promise((r) => setTimeout(r, 1000));

        // Worker should have been restarted
        expect(restarts).toContain("shared-test");
      } finally {
        // Always restore file even if test fails
        await fsp.writeFile(sharedFile, original);
      }
    }
  );

  it(
    "does not restart workers on shared change when watchSharedFolders is false",
    { timeout: 20_000 },
    async () => {
      const restarts: string[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        hotReload: true,
        watchSharedFolders: false,
        onFunctionReady: (name) => restarts.push(name),
      });
      await server.start();

      // Trigger a request so the worker is running
      const res1 = await httpRequest(server.port, "/shared-test");
      expect(res1.status).toBe(200);
      restarts.length = 0;

      // Touch a shared file
      const sharedFile = path.join(FUNCTIONS_DIR, "_shared", "cors.ts");
      const original = await fsp.readFile(sharedFile, "utf-8");
      try {
        await fsp.writeFile(sharedFile, original + "\n// touch");

        // Wait for debounce window to pass
        await new Promise((r) => setTimeout(r, 500));

        // No restart should have happened
        expect(restarts).toHaveLength(0);
      } finally {
        // Always restore file even if test fails
        await fsp.writeFile(sharedFile, original);
      }
    }
  );
});

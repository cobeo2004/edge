import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EdgeFunctionServer } from "../../server/EdgeFunctionServer.js";
import { httpRequest } from "../helpers/http.js";

describe(
  "EdgeFunctionServer – permission profiles",
  { timeout: 15_000 },
  () => {
    let server: EdgeFunctionServer | undefined;
    let tmpFunctionsDir: string;

    beforeEach(async () => {
      tmpFunctionsDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), "perm-test-")
      );
    });

    afterEach(async () => {
      if (server) {
        await server.stop();
        server = undefined;
      }
      await fsp.rm(tmpFunctionsDir, { recursive: true, force: true });
    });

    async function createFunction(
      name: string,
      code: string,
      functionJson?: object
    ) {
      const fnDir = path.join(tmpFunctionsDir, name);
      await fsp.mkdir(fnDir, { recursive: true });
      await fsp.writeFile(path.join(fnDir, "index.ts"), code);
      if (functionJson) {
        await fsp.writeFile(
          path.join(fnDir, "function.json"),
          JSON.stringify(functionJson)
        );
      }
    }

    it("uses default standard profile", async () => {
      await createFunction(
        "net-test",
        `Deno.serve((_req) => new Response("ok"));`
      );
      server = new EdgeFunctionServer({
        functionsDir: tmpFunctionsDir,
        port: 0,
      });
      await server.start();
      const res = await httpRequest(server.port, "/net-test");
      expect(res.status).toBe(200);
    });

    it("applies per-function permission from functionPermissions", async () => {
      await createFunction(
        "permissive-fn",
        `Deno.serve((_req) => new Response("ok"));`
      );
      server = new EdgeFunctionServer({
        functionsDir: tmpFunctionsDir,
        port: 0,
        defaultPermissionProfile: "strict",
        functionPermissions: {
          "permissive-fn": "permissive",
        },
      });
      await server.start();
      const res = await httpRequest(server.port, "/permissive-fn");
      expect(res.status).toBe(200);
    });

    it("applies per-function permission from function.json", async () => {
      await createFunction(
        "custom-fn",
        `Deno.serve((_req) => new Response("ok"));`,
        { permissions: "permissive" }
      );
      server = new EdgeFunctionServer({
        functionsDir: tmpFunctionsDir,
        port: 0,
        defaultPermissionProfile: "strict",
      });
      await server.start();
      const res = await httpRequest(server.port, "/custom-fn");
      expect(res.status).toBe(200);
    });

    it("supports custom permission profiles", async () => {
      await createFunction(
        "custom-profile",
        `Deno.serve((_req) => new Response("ok"));`
      );
      server = new EdgeFunctionServer({
        functionsDir: tmpFunctionsDir,
        port: 0,
        permissionProfiles: {
          "net-only": ["--allow-net"],
        },
        functionPermissions: {
          "custom-profile": "net-only",
        },
      });
      await server.start();
      const res = await httpRequest(server.port, "/custom-profile");
      expect(res.status).toBe(200);
    });

    it("supports raw flags array in functionPermissions", async () => {
      await createFunction(
        "raw-flags",
        `Deno.serve((_req) => new Response("ok"));`
      );
      server = new EdgeFunctionServer({
        functionsDir: tmpFunctionsDir,
        port: 0,
        functionPermissions: {
          "raw-flags": ["--allow-net", "--allow-read"],
        },
      });
      await server.start();
      const res = await httpRequest(server.port, "/raw-flags");
      expect(res.status).toBe(200);
    });
  }
);

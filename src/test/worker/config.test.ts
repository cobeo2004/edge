import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";
import { newDenoHTTPWorker } from "../../index.js";
import { jsonRequest, cleanupSockets } from "../helpers/worker.js";
import { echoFile, echoScript } from "../helpers/fixtures.js";

describe("DenoHTTPWorker – config", { timeout: 1000 }, () => {
  beforeAll(() => {
    cleanupSockets();
  });

  describe("runFlags editing", () => {
    it.each([
      "--allow-read",
      "--allow-write",
      "--allow-read=/dev/null",
      "--allow-write=/dev/null",
      "--allow-read=foo,/dev/null",
      "--allow-write=bar,/dev/null",
    ])("should handle %s", async (flag) => {
      const worker = await newDenoHTTPWorker(echoScript, {
        printOutput: true,
        runFlags: [flag],
      });
      await jsonRequest(worker, "http://localhost");
      await worker.terminate();
    });
  });

  it("should be able to import script", async () => {
    const url = new URL(`file://${echoFile}`);
    const worker = await newDenoHTTPWorker(url, {
      printOutput: true,
      printCommandAndArguments: true,
    });

    await jsonRequest(worker, "http://localhost");
    worker.terminate();
  });

  it("importMapPath resolves mapped imports", async () => {
    const tmpDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), "deno-import-map-")
    );
    const importMapPath = path.join(tmpDir, "import_map.json");
    const libPath = path.join(tmpDir, "my_lib.ts");

    await fsp.writeFile(
      libPath,
      'export const greeting = "hello from import map";'
    );
    await fsp.writeFile(
      importMapPath,
      JSON.stringify({ imports: { "my-lib": libPath } })
    );

    try {
      const worker = await newDenoHTTPWorker(
        `
        import { greeting } from "my-lib";
        export default {
          async fetch(req: Request): Promise<Response> {
            return Response.json({ greeting });
          }
        }
        `,
        {
          importMapPath,
          runFlags: [`--allow-read=${tmpDir}`],
        }
      );
      const json = await jsonRequest(worker, "http://localhost/");
      expect(json).toEqual({ greeting: "hello from import map" });
      worker.terminate();
    } finally {
      await fsp.rm(tmpDir, { recursive: true });
    }
  });

  it("configPath resolves imports from deno.json", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "deno-config-"));
    const configPath = path.join(tmpDir, "deno.json");
    const libPath = path.join(tmpDir, "my_lib.ts");

    await fsp.writeFile(
      libPath,
      'export const greeting = "hello from deno config";'
    );
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        imports: { "config-lib": libPath },
        nodeModulesDir: "auto",
      })
    );

    try {
      const worker = await newDenoHTTPWorker(
        `
        import { greeting } from "config-lib";
        export default {
          async fetch(req: Request): Promise<Response> {
            return Response.json({ greeting });
          }
        }
        `,
        {
          configPath,
          runFlags: [`--allow-read=${tmpDir}`],
        }
      );
      const json = await jsonRequest(worker, "http://localhost/");
      expect(json).toEqual({ greeting: "hello from deno config" });
      worker.terminate();
    } finally {
      await fsp.rm(tmpDir, { recursive: true });
    }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import { newDenoHTTPWorker } from "../../worker/index.js";
import { httpRequest } from "../helpers/http.js";
import { Buffer } from "node:buffer";
import {
  FUNCTIONS_DIR,
  IMPORT_MAP,
  SERVE_BOOTSTRAP,
} from "../helpers/fixtures.js";

describe("EdgeFunctionServer – lifecycle", { timeout: 15_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("serves multiple functions", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const [helloRes, echoRes] = await Promise.all([
      httpRequest(server.port, "/hello"),
      httpRequest(server.port, "/echo"),
    ]);

    expect(helloRes.status).toBe(200);
    expect(helloRes.body).toBe("Hello from edge function!");
    expect(echoRes.status).toBe(200);
    const echoJson = JSON.parse(echoRes.body);
    expect(echoJson.path).toBe("/");
  });

  it("recovers after worker crash", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const res1 = await httpRequest(server.port, "/hello");
    expect(res1.status).toBe(200);

    await server.restartFunction("hello");

    const res2 = await httpRequest(server.port, "/hello");
    expect(res2.status).toBe(200);
    expect(res2.body).toBe("Hello from edge function!");
  });

  it("eager spawn creates workers at startup", async () => {
    const readyFunctions: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      eagerSpawn: true,
      importMapPath: IMPORT_MAP,
      workerOptions: {
        runFlags: ["--allow-net", "--allow-env", "--allow-read"],
      },
      onFunctionReady: (name) => readyFunctions.push(name),
    });
    await server.start();

    expect(readyFunctions.sort()).toEqual([
      "echo",
      "env-test",
      "hello",
      "import-map-test",
      "npm-import",
      "oom",
      "public",
      "shared-test",
      "slow",
      "unresponsive",
      "wasm-test",
    ]);
  });

  it("Deno.serve bootstrap works standalone", async () => {
    const helloFile = path.resolve(FUNCTIONS_DIR, "hello/index.ts");
    const worker = await newDenoHTTPWorker(new URL(`file://${helloFile}`), {
      denoBootstrapScriptPath: SERVE_BOOTSTRAP,
      runFlags: ["--allow-net", "--allow-env"],
    });

    const body = await new Promise<string>((resolve, reject) => {
      const req = worker.request("http://localhost/test", {}, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });

    expect(body).toBe("Hello from edge function!");
    worker.terminate();
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { type SpawnOptions, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { newDenoHTTPWorker } from "../../index.js";
import { jsonRequest, cleanupSockets } from "../helpers/worker.js";
import { echoScript } from "../helpers/fixtures.js";

describe("DenoHTTPWorker – basic", { timeout: 1000 }, () => {
  beforeAll(() => {
    cleanupSockets();
  });

  it("onSpawn is called", async () => {
    let pid: number | undefined;
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          let headers = {};
          for (let [key, value] of req.headers.entries()) {
            headers[key] = value;
          }
          return Response.json({ ok: req.url, headers: headers })
        } }
      `,
      {
        onSpawn: (process) => {
          pid = process.pid;
        },
        printOutput: true,
      },
    );
    expect(pid).toBeDefined();
    worker.terminate();
  });

  it("alternate spawnFunc can be provided", async () => {
    let firstArg = "";
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          let headers = {};
          for (let [key, value] of req.headers.entries()) {
            headers[key] = value;
          }
          return Response.json({ ok: req.url, headers: headers })
        } }
      `,
      {
        spawnFunc: (command: string, args: string[], options: SpawnOptions) => {
          firstArg = args[0] as string;
          return spawn(command, args, options);
        },
      },
    );
    expect(firstArg).toEqual("run");
    worker.terminate();
  });

  it("don't crash on socket removal", async () => {
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          await Deno.removeSync(Deno.args[0]);
          return Response.json({ ok: req.url })
        } }
      `,
      { printOutput: true },
    );
    const json = await jsonRequest(worker, "https://localhost/hello?isee=you", {
      headers: { accept: "application/json" },
    });
    expect(json).toEqual({
      ok: "https://localhost/hello?isee=you",
    });
    worker.terminate();
  });

  it("json response multiple requests", async () => {
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          let headers = {};
          for (let [key, value] of req.headers.entries()) {
            headers[key] = value;
          }
          return Response.json({ ok: req.url, headers: headers })
        } }
      `,
      { printOutput: true },
    );
    for (let i = 0; i < 10; i++) {
      const json = await jsonRequest(
        worker,
        "https://localhost/hello?isee=you",
        { headers: { accept: "application/json" } },
      );
      expect(json).toEqual({
        ok: "https://localhost/hello?isee=you",
        headers: { accept: "application/json" },
      });
    }
    worker.terminate();
  });

  it("host and connection is not overwritten", async () => {
    const worker = await newDenoHTTPWorker(echoScript, {
      printOutput: true,
    });
    const resp: any = await jsonRequest(worker, "https://localhost/", {
      headers: { connection: "happy", host: "fish" },
    });
    expect(resp.headers.connection).toEqual("happy");
    expect(resp.headers.host).toEqual("fish");
    worker.terminate();
  });

  it("use http directly", async () => {
    const worker = await newDenoHTTPWorker(echoScript, { printOutput: true });

    await new Promise((resolve) => setTimeout(resolve, 300));

    const t0 = performance.now();
    const json = await new Promise((resolve) => {
      const req = worker.request("http://localhost/hi", {}, (resp) => {
        const body: any[] = [];
        resp.on("data", (chunk) => {
          body.push(chunk);
        });
        resp.on("end", () => {
          resolve(JSON.parse(Buffer.concat(body).toString()));
        });
      });
      req.end();
    });
    console.log("http request time", performance.now() - t0);
    expect(json).toEqual({
      url: "http://localhost/hi",
      headers: {},
      body: "",
      method: "GET",
    });
    worker.terminate();
  });

  it("can implement val town with http.request", async () => {
    const { vtScript } = await import("../helpers/fixtures.js");
    const { DEFAULT_HTTP_VAL } = await import("../helpers/worker.js");

    const worker = await newDenoHTTPWorker(vtScript, { printOutput: true });

    const t0 = performance.now();
    await new Promise((resolve, reject) => {
      const req = worker.request(
        "http://vt",
        {
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        },
        (resp) => {
          const body: any[] = [];
          resp.on("data", (chunk) => {
            body.push(chunk);
          });
          resp.on("end", () => {
            resolve(Buffer.concat(body).toString());
          });
        },
      );
      req.on("error", reject);
      req.write(`data:text/tsx,${encodeURIComponent(DEFAULT_HTTP_VAL)}`);
      req.end();
    });

    const text = await new Promise((resolve) => {
      const req = worker.request(
        "https://localhost:1234",
        { headers: {} },
        (resp) => {
          const body: any[] = [];
          resp.on("data", (chunk) => {
            body.push(chunk);
          });
          resp.on("end", () => {
            resolve(Buffer.concat(body).toString());
          });
        },
      );
      req.end();
    });
    expect(text).toEqual('{"ok":true}');
    console.log("Double request http2 val:", performance.now() - t0);
    worker.terminate();
  });
});

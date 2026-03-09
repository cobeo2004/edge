import { describe, expect, it } from "vitest";
import { newDenoHTTPWorker } from "../../index.js";
import { jsonRequest } from "../helpers/worker.js";

describe("DenoHTTPWorker – execution limits", { timeout: 30_000 }, () => {
  it("memoryLimitMb: normal request succeeds", async () => {
    const worker = await newDenoHTTPWorker(
      `export default { async fetch(req: Request): Promise<Response> {
          return Response.json({ ok: true });
        }}`,
      { memoryLimitMb: 64 }
    );
    const json = await jsonRequest(worker, "https://localhost/test");
    expect(json).toEqual({ ok: true });
    worker.terminate();
  });

  it("memoryLimitMb: OOM kills the process", async () => {
    const worker = await newDenoHTTPWorker(
      `export default { async fetch(req: Request): Promise<Response> {
          const arrays: number[][] = [];
          while (true) {
            arrays.push(new Array(1_000_000).fill(0));
          }
        }}`,
      { memoryLimitMb: 32 }
    );

    const exitPromise = new Promise<{ code: number; signal: string }>(
      (resolve) => {
        worker.addEventListener("exit", (code, signal) => {
          resolve({ code, signal });
        });
      }
    );

    // The request should fail because OOM kills the process
    try {
      await jsonRequest(worker, "https://localhost/test");
    } catch {
      // expected — process dies
    }

    const { code } = await exitPromise;
    // OOM should result in a non-zero exit code
    expect(code).not.toBe(0);
  });

  it("memoryLimitMb: appends to existing --v8-flags", async () => {
    const worker = await newDenoHTTPWorker(
      `export default { async fetch(req: Request): Promise<Response> {
          return Response.json({ ok: true });
        }}`,
      {
        memoryLimitMb: 64,
        runFlags: ["--v8-flags=--expose-gc"],
      }
    );
    const json = await jsonRequest(worker, "https://localhost/test");
    expect(json).toEqual({ ok: true });
    worker.terminate();
  });

  it("requestTimeout: slow request times out but worker survives", async () => {
    const worker = await newDenoHTTPWorker(
      `export default { async fetch(req: Request): Promise<Response> {
          const url = new URL(req.url);
          if (url.pathname === "/slow") {
            await new Promise(r => setTimeout(r, 5000));
          }
          return Response.json({ alive: true });
        }}`,
      { requestTimeout: 200 }
    );

    // First request should time out
    await expect(
      jsonRequest(worker, "https://localhost/slow")
    ).rejects.toThrow("timed out");

    // Worker should still be alive — a fast request should succeed
    const json = await jsonRequest(worker, "https://localhost/fast");
    expect(json).toEqual({ alive: true });

    worker.terminate();
  });

  it("workerMaxDuration: worker auto-terminates after duration", async () => {
    const worker = await newDenoHTTPWorker(
      `export default { async fetch(req: Request): Promise<Response> {
          return Response.json({ ok: true });
        }}`,
      { workerMaxDuration: 500 }
    );

    // Should work immediately
    const json = await jsonRequest(worker, "https://localhost/test");
    expect(json).toEqual({ ok: true });

    // Wait for the max duration timer to fire
    const exitPromise = new Promise<void>((resolve) => {
      worker.addEventListener("exit", () => resolve());
    });

    await exitPromise;
    // If we get here, the worker was terminated by the timer
  });
});

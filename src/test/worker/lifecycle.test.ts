import { describe, expect, it, test } from "vitest";
import { newDenoHTTPWorker } from "../../index.js";
import { EarlyExitDenoHTTPWorkerError } from "../../worker/types.js";
import { jsonRequest } from "../helpers/worker.js";

test("EarlyExitDenoHTTPWorkerError", () => {
  expect(
    new EarlyExitDenoHTTPWorkerError("Test", "", "hi", 10, "SIGKILL")
  ).toHaveProperty("signal", "SIGKILL");
});

describe("DenoHTTPWorker – lifecycle", { timeout: 1000 }, () => {
  it("onError", async () => {
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          return {} // not a response
        }, onError (error: Error): Response {
          return Response.json({ error: error.message }, { status: 500 })
        }}
      `,
      { printOutput: true }
    );
    const json = await jsonRequest(worker, "https://localhost/hello?isee=you", {
      headers: { accept: "application/json" },
    });
    expect(json).toEqual({
      error:
        "Return value from serve handler must be a response or a promise resolving to a response",
    });

    worker.terminate();
  });

  it("onError not handled", { timeout: 20_000 }, async () => {
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          setTimeout(() => {
            throw new Error("uncaught!")
          })
          return Response.json(null)
        }, onError (error: Error): Response {
          return Response.json({ error: error.message }, { status: 500 })
        }}
      `,
      { printOutput: false }
    );
    jsonRequest(worker, "https://localhost/hello?isee=you", {
      headers: { accept: "application/json" },
    }).catch(() => {});

    for (;;) {
      const stderr = worker.stderr.read();
      if (stderr) {
        expect(stderr.toString()).toContain("Error: uncaught!");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    worker.terminate();
  });

  it("unhandled rejection", { timeout: 20_000 }, async () => {
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          Promise.reject(new Error("uncaught!"))
          return Response.json(null)
        }, onError (error: Error): Response {
          return Response.json({ error: error.message }, { status: 500 })
        }}
      `,
      { printOutput: false }
    );
    jsonRequest(worker, "https://localhost/hello?isee=you", {
      headers: { accept: "application/json" },
    }).catch(() => {});

    for (;;) {
      const stderr = worker.stderr.read();
      if (stderr) {
        expect(stderr.toString()).toContain("Error: uncaught!");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    worker.terminate();
  });

  it("shutdown gracefully", async () => {
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          new Promise((resolve) => setTimeout(() => {resolve(); console.log("hi")}, 200));
          return Response.json({ ok: req.url })
        }}
      `,
      { printOutput: true }
    );

    let logs = "";
    worker.stderr.on("data", (data) => (logs += data));
    worker.stdout.on("data", (data) => (logs += data));

    const exitPromise = new Promise<void>((resolve) => {
      worker.addEventListener("exit", (code) => {
        expect(code).toEqual(0);
        expect(logs).toContain("hi");
        resolve();
      });
    });
    const json = await jsonRequest(worker, "https://localhost/hello?isee=you");
    expect(json).toEqual({
      ok: "https://localhost/hello?isee=you",
    });
    worker.shutdown();
    await exitPromise;
  });
});

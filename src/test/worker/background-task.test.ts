import { describe, it, expect, afterEach } from "vitest";
import { newDenoHTTPWorker, type DenoHTTPWorker } from "../../worker/index.js";
import { SERVE_BOOTSTRAP } from "../helpers/fixtures.js";
import type { IncomingMessage } from "node:http";
import { Buffer } from "node:buffer";
import path from "node:path";

const FUNCTIONS_DIR = path.resolve(import.meta.dirname!, "../functions");
const BG_TASK_ENTRY = path.join(FUNCTIONS_DIR, "background-task", "index.ts");
const BG_ERROR_ENTRY = path.join(
  FUNCTIONS_DIR,
  "background-task-error",
  "index.ts"
);

function textRequest(
  worker: DenoHTTPWorker,
  url: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = worker.request(
      `http://localhost${url}`,
      {},
      (resp: IncomingMessage) => {
        const chunks: Buffer[] = [];
        resp.on("error", reject);
        resp.on("data", (chunk: Buffer) => chunks.push(chunk));
        resp.on("end", () => {
          resolve({
            status: resp.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Background Tasks", () => {
  let worker: DenoHTTPWorker;

  afterEach(() => {
    worker?.terminate();
  });

  it("response returns before background task completes", async () => {
    let bgStarted = false;
    let bgComplete = false;

    worker = await newDenoHTTPWorker(new URL(`file://${BG_TASK_ENTRY}`), {
      denoBootstrapScriptPath: SERVE_BOOTSTRAP,
      onBackgroundTaskStarted: () => {
        bgStarted = true;
      },
      onBackgroundTaskComplete: () => {
        bgComplete = true;
      },
    });

    const { body } = await textRequest(worker, "/background");
    expect(body).toBe("accepted");
    expect(bgStarted).toBe(true);
    // Task is 500ms, response should return before it completes
    expect(bgComplete).toBe(false);

    // Wait for background task to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    expect(bgComplete).toBe(true);
  }, 10_000);

  it("tracks backgroundTaskCount on worker", async () => {
    worker = await newDenoHTTPWorker(new URL(`file://${BG_TASK_ENTRY}`), {
      denoBootstrapScriptPath: SERVE_BOOTSTRAP,
    });

    expect(worker.backgroundTaskCount).toBe(0);

    await textRequest(worker, "/background");
    // Task started but not yet complete (500ms delay)
    expect(worker.backgroundTaskCount).toBe(1);

    // Wait for completion
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    expect(worker.backgroundTaskCount).toBe(0);
  }, 10_000);

  it("handles rejected background task without crashing", async () => {
    let bgComplete = false;

    worker = await newDenoHTTPWorker(new URL(`file://${BG_ERROR_ENTRY}`), {
      denoBootstrapScriptPath: SERVE_BOOTSTRAP,
      onBackgroundTaskComplete: () => {
        bgComplete = true;
      },
    });

    const { body } = await textRequest(worker, "/");
    expect(body).toBe("accepted");

    // Wait for rejection to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(bgComplete).toBe(true);
    expect(worker.backgroundTaskCount).toBe(0);
  }, 10_000);

  it("ignores non-waitUntil requests", async () => {
    worker = await newDenoHTTPWorker(new URL(`file://${BG_TASK_ENTRY}`), {
      denoBootstrapScriptPath: SERVE_BOOTSTRAP,
    });

    const { body } = await textRequest(worker, "/");
    expect(body).toBe("ok");
    expect(worker.backgroundTaskCount).toBe(0);
  }, 10_000);
});

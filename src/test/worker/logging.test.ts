import { describe, expect, it } from "vitest";
import { type LogLevel, newDenoHTTPWorker } from "../../index.js";
import { jsonRequest } from "../helpers/worker.js";

describe("DenoHTTPWorker – logLevel", { timeout: 1000 }, () => {
  it("logLevel info captures stdout and stderr via onLog", async () => {
    const logs: { level: LogLevel; source: string; message: string }[] = [];
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch(req: Request): Promise<Response> {
          console.log("stdout-line");
          console.error("stderr-line");
          return Response.json({ ok: true });
        }}
        `,
      {
        logLevel: "info",
        onLog: (level, source, message) => {
          logs.push({ level, source, message });
        },
      }
    );
    await jsonRequest(worker, "http://localhost/");
    // Give readline a moment to flush
    await new Promise((r) => setTimeout(r, 100));
    worker.terminate();

    expect(
      logs.some(
        (l) => l.source === "stdout" && l.message.includes("stdout-line")
      )
    ).toBe(true);
    expect(
      logs.some(
        (l) => l.source === "stderr" && l.message.includes("stderr-line")
      )
    ).toBe(true);
  });

  it("logLevel warn captures only stderr via onLog", async () => {
    const logs: { level: LogLevel; source: string; message: string }[] = [];
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch(req: Request): Promise<Response> {
          console.log("stdout-hidden");
          console.error("stderr-visible");
          return Response.json({ ok: true });
        }}
        `,
      {
        logLevel: "warn",
        onLog: (level, source, message) => {
          logs.push({ level, source, message });
        },
      }
    );
    await jsonRequest(worker, "http://localhost/");
    await new Promise((r) => setTimeout(r, 100));
    worker.terminate();

    expect(logs.some((l) => l.source === "stdout")).toBe(false);
    expect(
      logs.some(
        (l) => l.source === "stderr" && l.message.includes("stderr-visible")
      )
    ).toBe(true);
  });

  it("logLevel debug logs spawn command via onLog", async () => {
    const logs: { level: LogLevel; source: string; message: string }[] = [];
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch(req: Request): Promise<Response> {
          return Response.json({ ok: true });
        }}
        `,
      {
        logLevel: "debug",
        onLog: (level, source, message) => {
          logs.push({ level, source, message });
        },
      }
    );
    await jsonRequest(worker, "http://localhost/");
    worker.terminate();

    expect(
      logs.some(
        (l) =>
          l.source === "command" && l.message.includes("Spawning deno process")
      )
    ).toBe(true);
  });

  it("printOutput true still works (backward compat)", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    console.error = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      const worker = await newDenoHTTPWorker(
        `
          export default { async fetch(req: Request): Promise<Response> {
            console.log("compat-test");
            return Response.json({ ok: true });
          }}
          `,
        { printOutput: true }
      );
      await jsonRequest(worker, "http://localhost/");
      await new Promise((r) => setTimeout(r, 100));
      worker.terminate();

      expect(
        logs.some((l) => l.includes("[deno]") && l.includes("compat-test"))
      ).toBe(true);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import type { LogLevel } from "../../worker/index.js";
import { httpRequest } from "../helpers/http.js";
import { FUNCTIONS_DIR } from "../helpers/fixtures.js";

describe("EdgeFunctionServer – logging", { timeout: 15_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("logLevel debug with onLog includes function name", async () => {
    const logs: {
      functionName: string;
      level: LogLevel;
      source: string;
      message: string;
    }[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      logLevel: "debug",
      onLog: (functionName, level, source, message) => {
        logs.push({ functionName, level, source, message });
      },
    });
    await server.start();
    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(200);
    // Give readline a moment to flush
    await new Promise((r) => setTimeout(r, 100));

    const helloLogs = logs.filter((l) => l.functionName === "hello");
    expect(helloLogs.length).toBeGreaterThan(0);
    expect(
      helloLogs.some(
        (l) =>
          l.source === "command" && l.message.includes("Spawning deno process"),
      ),
    ).toBe(true);
  });
});

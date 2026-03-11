import { afterEach, describe, expect, it } from "vitest";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import { httpRequest } from "../helpers/http.js";
import { FUNCTIONS_DIR } from "../helpers/fixtures.js";
import type { LogLevel } from "../../worker/types.js";

describe("EdgeFunctionServer – env", { timeout: 15_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("loads global .env vars", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const res = await httpRequest(server.port, "/env-test/?var=GLOBAL_VAR");
    const json = JSON.parse(res.body);
    expect(json.GLOBAL_VAR).toBe("global_value");
  });

  it("loads per-function .env vars", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const res = await httpRequest(server.port, "/env-test/?var=MY_SECRET");
    const json = JSON.parse(res.body);
    expect(json.MY_SECRET).toBe("per_function_secret");
  });

  it("per-function .env overrides global .env", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const res = await httpRequest(server.port, "/env-test/?var=SHARED_VAR");
    const json = JSON.parse(res.body);
    expect(json.SHARED_VAR).toBe("from_per_function");
  });

  it("programmatic env overrides .env files", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      env: { GLOBAL_VAR: "programmatic_override" },
    });
    await server.start();

    const res = await httpRequest(server.port, "/env-test/?var=GLOBAL_VAR");
    const json = JSON.parse(res.body);
    expect(json.GLOBAL_VAR).toBe("programmatic_override");
  });

  it("masks secrets in log output", async () => {
    const logs: string[] = [];

    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      env: { LOG_SECRET: "super_secret_value" },
      logLevel: "info",
      onLog: (
        _name: string,
        _level: LogLevel,
        _source: "stdout" | "stderr" | "command",
        message: string
      ) => {
        logs.push(message);
      },
    });
    await server.start();

    // Make a request to trigger logging (fixture logs the env value)
    await httpRequest(server.port, "/env-test/?var=LOG_SECRET");

    // Verify the secret value is masked in logs
    const secretLogs = logs.filter((log) => log.includes("LOG_SECRET"));
    expect(secretLogs.length).toBeGreaterThan(0);
    for (const log of secretLogs) {
      expect(log).not.toContain("super_secret_value");
      expect(log).toContain("***");
    }
  });

  it("does not mask when maskSecrets is false", async () => {
    const logs: string[] = [];

    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      env: { LOG_SECRET: "super_secret_value" },
      maskSecrets: false,
      logLevel: "info",
      onLog: (
        _name: string,
        _level: LogLevel,
        _source: "stdout" | "stderr" | "command",
        message: string
      ) => {
        logs.push(message);
      },
    });
    await server.start();

    await httpRequest(server.port, "/env-test/?var=LOG_SECRET");

    // With maskSecrets=false, secrets should appear unmasked in the logs
    expect(logs.some((log) => log.includes("super_secret_value"))).toBe(true);
  });
});

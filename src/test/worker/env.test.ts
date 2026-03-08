import { afterEach, describe, expect, it } from "vitest";
import { newDenoHTTPWorker } from "../../index.js";
import { jsonRequest } from "../helpers/worker.js";

describe("DenoHTTPWorker – env", { timeout: 15_000 }, () => {
  let worker: Awaited<ReturnType<typeof newDenoHTTPWorker>> | undefined;

  afterEach(() => {
    if (worker) {
      worker.terminate();
      worker = undefined;
    }
  });

  it("passes env vars to the Deno process", async () => {
    const script = `export default {
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const varName = url.searchParams.get("var") ?? "";
        const value = Deno.env.get(varName) ?? "";
        return Response.json({ [varName]: value });
      }
    }`;

    worker = await newDenoHTTPWorker(script, {
      runFlags: ["--allow-net", "--allow-env"],
      env: { TEST_CUSTOM_VAR: "custom_value" },
    });

    const result = await jsonRequest(
      worker,
      "http://localhost/?var=TEST_CUSTOM_VAR"
    );
    expect(result.TEST_CUSTOM_VAR).toBe("custom_value");
  });

  it("env overrides spawnOptions.env", async () => {
    const script = `export default {
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const varName = url.searchParams.get("var") ?? "";
        const value = Deno.env.get(varName) ?? "";
        return Response.json({ [varName]: value });
      }
    }`;

    worker = await newDenoHTTPWorker(script, {
      runFlags: ["--allow-net", "--allow-env"],
      spawnOptions: {
        env: { ...process.env, MY_VAR: "from_spawn" },
      },
      env: { MY_VAR: "from_env_option" },
    });

    const result = await jsonRequest(worker, "http://localhost/?var=MY_VAR");
    expect(result.MY_VAR).toBe("from_env_option");
  });

  it("process.env vars are still accessible without env option", async () => {
    const script = `export default {
      async fetch(req: Request): Promise<Response> {
        const value = Deno.env.get("PATH") ?? "not_found";
        return Response.json({ hasPath: value !== "not_found" });
      }
    }`;

    worker = await newDenoHTTPWorker(script, {
      runFlags: ["--allow-net", "--allow-env"],
    });

    const result = await jsonRequest(worker, "http://localhost/");
    expect(result.hasPath).toBe(true);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import http from "node:http";
import { EdgeFunctionServer } from "./server/EdgeFunctionServer.js";
import { newDenoHTTPWorker } from "./worker/index.js";
import type { LogLevel } from "./worker/index.js";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.resolve(__dirname, "./test/functions");
const SERVE_BOOTSTRAP = path.resolve(__dirname, "../deno-bootstrap/serve.ts");
const IMPORT_MAP = path.resolve(__dirname, "./test/import_map.json");
const DENO_CONFIG = path.resolve(__dirname, "./test/deno_config.json");

function httpRequest(
  port: number,
  urlPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}${urlPath}`,
      { method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function httpRequestRaw(
  port: number,
  urlPath: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}${urlPath}`,
      { method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("EdgeFunctionServer", { timeout: 15_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("discovers functions", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    // start triggers scan
    await server.start();
    const fns = server.listFunctions();
    expect(fns).toEqual(["echo", "hello", "import-map-test", "npm-import", "wasm-test"]);
  });

  it("routes to hello function", async () => {
    const port = 17601;
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port,
    });
    await server.start();
    const res = await httpRequest(port, "/hello");
    expect(res.status).toBe(200);
    expect(res.body).toBe("Hello from edge function!");
  });

  it("rewrites path for echo function", async () => {
    const port = 17602;
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port,
    });
    await server.start();
    const res = await httpRequest(port, "/echo/sub/path?q=1");
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.path).toBe("/sub/path");
    expect(json.search).toBe("?q=1");
    expect(json.method).toBe("GET");
  });

  it("returns 404 for unknown function", async () => {
    const port = 17603;
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port,
    });
    await server.start();
    const res = await httpRequest(port, "/nonexistent");
    expect(res.status).toBe(404);
    const json = JSON.parse(res.body);
    expect(json.error).toBe("Function not found");
  });

  it("handles POST with body", async () => {
    const port = 17604;
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port,
    });
    await server.start();
    const res = await httpRequest(port, "/echo", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello world",
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.method).toBe("POST");
    expect(json.body).toBe("hello world");
  });

  it("serves multiple functions", async () => {
    const port = 17605;
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port,
    });
    await server.start();

    const [helloRes, echoRes] = await Promise.all([
      httpRequest(port, "/hello"),
      httpRequest(port, "/echo"),
    ]);

    expect(helloRes.status).toBe(200);
    expect(helloRes.body).toBe("Hello from edge function!");
    expect(echoRes.status).toBe(200);
    const echoJson = JSON.parse(echoRes.body);
    expect(echoJson.path).toBe("/");
  });

  it("recovers after worker crash", async () => {
    const port = 17606;
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port,
    });
    await server.start();

    // First request to spawn the worker
    const res1 = await httpRequest(port, "/hello");
    expect(res1.status).toBe(200);

    // Terminate the worker directly via restartFunction (simulates crash)
    await server.restartFunction("hello");

    // Next request should spawn a new worker
    const res2 = await httpRequest(port, "/hello");
    expect(res2.status).toBe(200);
    expect(res2.body).toBe("Hello from edge function!");
  });

  it("eager spawn creates workers at startup", async () => {
    const port = 17607;
    const readyFunctions: string[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port,
      eagerSpawn: true,
      importMapPath: IMPORT_MAP,
      workerOptions: { runFlags: ["--allow-net", "--allow-env", "--allow-read"] },
      onFunctionReady: (name) => readyFunctions.push(name),
    });
    await server.start();

    // All functions should have been spawned
    expect(readyFunctions.sort()).toEqual(["echo", "hello", "import-map-test", "npm-import", "wasm-test"]);
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

  it("echo path is / when no trailing path", async () => {
    const port = 17608;
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port,
    });
    await server.start();
    const res = await httpRequest(port, "/echo");
    const json = JSON.parse(res.body);
    expect(json.path).toBe("/");
    expect(json.search).toBe("");
  });

  it("importMapPath resolves mapped imports in edge functions", async () => {
    const port = 17614;
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port,
      importMapPath: IMPORT_MAP,
      workerOptions: { runFlags: ["--allow-net", "--allow-env", "--allow-read"] },
    });
    await server.start();
    const res = await httpRequest(port, "/import-map-test");
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello from edge");
  });

  it("configPath resolves imports from deno.json in edge functions", async () => {
    const port = 17615;
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port,
      configPath: DENO_CONFIG,
      workerOptions: { runFlags: ["--allow-net", "--allow-env", "--allow-read"] },
    });
    await server.start();
    const res = await httpRequest(port, "/import-map-test");
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello from edge");
  });

  it("logLevel debug with onLog includes function name", async () => {
    const port = 17616;
    const logs: { functionName: string; level: LogLevel; source: string; message: string }[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port,
      logLevel: "debug",
      onLog: (functionName, level, source, message) => {
        logs.push({ functionName, level, source, message });
      },
    });
    await server.start();
    const res = await httpRequest(port, "/hello");
    expect(res.status).toBe(200);
    // Give readline a moment to flush
    await new Promise((r) => setTimeout(r, 100));

    // debug level should capture the spawn command with function name "hello"
    const helloLogs = logs.filter((l) => l.functionName === "hello");
    expect(helloLogs.length).toBeGreaterThan(0);
    expect(helloLogs.some((l) => l.source === "command" && l.message.includes("Spawning deno process"))).toBe(true);
  });

  describe("wasm-test function", { timeout: 30_000 }, () => {
    it("returns 400 when no query params provided", async () => {
      const port = 17609;
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port,
        workerOptions: { runFlags: ["--allow-net", "--allow-read", "--allow-env"] },
      });
      await server.start();
      const res = await httpRequest(port, "/wasm-test");
      expect(res.status).toBe(400);
    });

    it("returns 400 when image param is missing", async () => {
      const port = 17610;
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port,
        workerOptions: { runFlags: ["--allow-net", "--allow-read", "--allow-env"] },
      });
      await server.start();
      const res = await httpRequest(port, "/wasm-test?width=100");
      expect(res.status).toBe(400);
    });

    it("returns 400 when neither width nor height is provided", async () => {
      const port = 17611;
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port,
        workerOptions: { runFlags: ["--allow-net", "--allow-read", "--allow-env"] },
      });
      await server.start();
      const res = await httpRequest(port, "/wasm-test?image=https://example.com/img.png");
      expect(res.status).toBe(400);
      expect(res.body).toContain("width");
    });

    it("returns 400 for invalid image URL", async () => {
      const port = 17612;
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port,
        workerOptions: { runFlags: ["--allow-net", "--allow-read", "--allow-env"] },
      });
      await server.start();
      const res = await httpRequest(port, "/wasm-test?image=not-a-url&width=100");
      expect(res.status).toBe(400);
      expect(res.body).toContain("'image' must be a valid URL");
    });

    it("resizes a real image", async () => {
      const port = 17613;
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port,
        workerOptions: { runFlags: ["--allow-net", "--allow-read", "--allow-env"] },
      });
      await server.start();

      // Use a small, publicly available test image
      const imageUrl = encodeURIComponent("https://picsum.photos/200/200.jpg");
      const res = await httpRequestRaw(port, `/wasm-test?image=${imageUrl}&width=50`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^image\//);
      // The response should be non-empty binary data
      expect(res.body.length).toBeGreaterThan(0);
    });
  });
});

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { newDenoHTTPWorker } from "../../index.js";
import type { DenoHTTPWorker } from "../../index.js";
import { cleanupSockets } from "../helpers/worker.js";
import { FUNCTIONS_DIR, SERVE_BOOTSTRAP } from "../helpers/fixtures.js";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WEBSOCKET_ECHO = pathToFileURL(
  path.join(FUNCTIONS_DIR, "websocket-echo", "index.ts"),
).href;

describe("Bootstrap WebSocket passthrough", () => {
  let worker: DenoHTTPWorker;

  beforeAll(() => cleanupSockets());

  afterEach(async () => {
    if (worker) await worker.terminate();
  });

  it("should pass WebSocket upgrade through to the user handler", async () => {
    worker = await newDenoHTTPWorker(
      `import "${WEBSOCKET_ECHO}"`,
      {
        runFlags: ["--allow-all"],
        denoBootstrapScriptPath: SERVE_BOOTSTRAP,
      },
    );

    const key = crypto.randomBytes(16).toString("base64");
    const socketPath = worker.socketPath;

    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({ path: socketPath }, () => {
        const request = [
          "GET / HTTP/1.1",
          "Host: localhost",
          "X-Deno-Worker-URL: http://localhost/websocket-echo",
          "X-Deno-Worker-Host: localhost",
          "X-Deno-Worker-Connection: Upgrade",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n");
        socket.write(request);
      });

      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
        if (data.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on("error", reject);
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error("timeout"));
      });
    });

    expect(response).toContain("101");
    expect(response.toLowerCase()).toContain("upgrade: websocket");
  }, 15000);
});

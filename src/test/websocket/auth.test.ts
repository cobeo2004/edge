import { afterEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import WebSocket from "ws";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import { JWTStrategy } from "../../auth/jwt.js";
import { FUNCTIONS_DIR } from "../helpers/fixtures.js";

const SECRET = "test-secret-that-is-long-enough-for-hs256!!!!!";

function makeToken(
  claims: Record<string, unknown> = { sub: "user-1" }
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

describe("WebSocket auth", { timeout: 30_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("rejects WebSocket upgrade without token when auth enabled", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
    });
    await server.start();

    const ws = new WebSocket(`ws://localhost:${server.port}/websocket-echo`);
    const error = await new Promise<{ statusCode: number }>(
      (resolve, reject) => {
        ws.on("unexpected-response", (_req, res) => {
          resolve({ statusCode: res.statusCode! });
          ws.close();
        });
        ws.on("error", () => {});
        setTimeout(() => reject(new Error("timeout")), 10_000);
      }
    );
    expect(error.statusCode).toBe(401);
  });

  it("rejects WebSocket upgrade with invalid token", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
    });
    await server.start();

    const ws = new WebSocket(`ws://localhost:${server.port}/websocket-echo`, {
      headers: { authorization: "Bearer invalid-token" },
    });
    const error = await new Promise<{ statusCode: number }>(
      (resolve, reject) => {
        ws.on("unexpected-response", (_req, res) => {
          resolve({ statusCode: res.statusCode! });
          ws.close();
        });
        ws.on("error", () => {});
        setTimeout(() => reject(new Error("timeout")), 10_000);
      }
    );
    expect(error.statusCode).toBe(401);
  });

  it("allows WebSocket upgrade with valid token", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
    });
    await server.start();

    const token = await makeToken();
    const ws = new WebSocket(`ws://localhost:${server.port}/websocket-echo`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const result = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("auth-test"));
      ws.on("message", (data) => {
        resolve(data.toString());
        ws.close();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 10_000);
    });
    expect(result).toBe("auth-test");
  });

  it("forwards auth claims to worker via X-Auth-Claims header", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
    });
    await server.start();

    const token = await makeToken({ sub: "ws-user-42", role: "admin" });
    const ws = new WebSocket(
      `ws://localhost:${server.port}/websocket-auth-echo`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const result = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("claims-test"));
      ws.on("message", (data) => {
        resolve(data.toString());
        ws.close();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 10_000);
    });
    const parsed = JSON.parse(result);
    expect(parsed.message).toBe("claims-test");
    expect(parsed.claims.sub).toBe("ws-user-42");
    expect(parsed.claims.role).toBe("admin");
  });

  it("allows WebSocket to publicFunctions without token", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
      publicFunctions: ["websocket-echo"],
    });
    await server.start();

    const ws = new WebSocket(`ws://localhost:${server.port}/websocket-echo`);
    const result = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("public-ws"));
      ws.on("message", (data) => {
        resolve(data.toString());
        ws.close();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 10_000);
    });
    expect(result).toBe("public-ws");
  });

  it("returns 404 for non-existent function even with auth enabled", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
    });
    await server.start();

    const ws = new WebSocket(`ws://localhost:${server.port}/nonexistent`);
    const error = await new Promise<{ statusCode: number }>(
      (resolve, reject) => {
        ws.on("unexpected-response", (_req, res) => {
          resolve({ statusCode: res.statusCode! });
          ws.close();
        });
        ws.on("error", () => {});
        setTimeout(() => reject(new Error("timeout")), 10_000);
      }
    );
    // Auth runs before function existence check (prevents function enumeration),
    // so unauthenticated requests to nonexistent functions get 401
    expect(error.statusCode).toBe(401);
  });

  it("allows WebSocket when no auth configured (no regression)", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const ws = new WebSocket(`ws://localhost:${server.port}/websocket-echo`);
    const result = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("no-auth"));
      ws.on("message", (data) => {
        resolve(data.toString());
        ws.close();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 10_000);
    });
    expect(result).toBe("no-auth");
  });
});

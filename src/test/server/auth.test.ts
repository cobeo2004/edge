import { afterEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import { JWTStrategy } from "../../auth/jwt.js";
import { httpRequest } from "../helpers/http.js";
import { FUNCTIONS_DIR } from "../helpers/fixtures.js";
import type { AuthStrategy } from "../../auth/types.js";
import { Buffer } from "node:buffer";

const SECRET = "test-secret-that-is-long-enough-for-hs256!!!!!";

function makeToken(
  claims: Record<string, unknown> = { sub: "user-1" },
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

describe("EdgeFunctionServer – auth", { timeout: 15_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("passes requests through when no auth configured", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();
    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(200);
  });

  it("rejects requests without token when auth enabled", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
    });
    await server.start();
    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Unauthorized");
  });

  it("allows requests with valid token", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
    });
    await server.start();
    const token = await makeToken();
    const res = await httpRequest(server.port, "/hello", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("forwards claims as base64url-encoded X-Auth-Claims header to worker", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
    });
    await server.start();
    const token = await makeToken({ sub: "user-42", role: "admin" });
    const res = await httpRequest(server.port, "/echo", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    // Claims are now base64url-encoded
    const raw = json.headers["x-auth-claims"];
    const claims = JSON.parse(Buffer.from(raw, "base64url").toString());
    expect(claims.sub).toBe("user-42");
    expect(claims.role).toBe("admin");
  });

  it("rejects requests with invalid token", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
    });
    await server.start();
    const res = await httpRequest(server.port, "/hello", {
      headers: { authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(401);
  });

  it("skips auth for publicFunctions", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
      publicFunctions: ["hello"],
    });
    await server.start();
    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(200);

    // Other functions still require auth
    const res2 = await httpRequest(server.port, "/echo");
    expect(res2.status).toBe(401);
  });

  it("uses custom onAuthFailure response", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
      onAuthFailure: (_req, result) =>
        new Response(JSON.stringify({ custom: true, reason: result.error }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    });
    await server.start();
    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.custom).toBe(true);
  });

  it("skips auth for functions with auth: false in function.json", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
    });
    await server.start();

    // public function has auth: false in function.json
    const res = await httpRequest(server.port, "/public");
    expect(res.status).toBe(200);
    expect(res.body).toBe("Public endpoint");

    // hello function still requires auth
    const res2 = await httpRequest(server.port, "/hello");
    expect(res2.status).toBe(401);
  });

  it("strips spoofed x-auth-claims header on public endpoints", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
      publicFunctions: ["echo"],
    });
    await server.start();
    // Client sends a spoofed x-auth-claims header
    const res = await httpRequest(server.port, "/echo", {
      headers: { "x-auth-claims": "eyJhZG1pbiI6dHJ1ZX0" },
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    // The spoofed header must be stripped
    expect(json.headers["x-auth-claims"]).toBeUndefined();
  });

  it("handles auth strategy that throws during extractCredentials", async () => {
    const throwingStrategy: AuthStrategy = {
      extractCredentials() {
        throw new Error("extract boom");
      },
      verify() {
        return Promise.resolve({ valid: true });
      },
    };

    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: throwingStrategy,
    });
    await server.start();
    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.message).toBe("extract boom");
  });

  it("handles auth strategy that throws during verify", async () => {
    const throwingStrategy: AuthStrategy = {
      extractCredentials(request: Request) {
        return Promise.resolve(request.headers.get("authorization"));
      },
      verify() {
        throw new Error("verify boom");
      },
    };

    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: throwingStrategy,
    });
    await server.start();
    const res = await httpRequest(server.port, "/hello", {
      headers: { authorization: "Bearer something" },
    });
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.message).toBe("verify boom");
  });

  it("routes thrown auth errors through onAuthFailure", async () => {
    const throwingStrategy: AuthStrategy = {
      extractCredentials(request: Request) {
        return Promise.resolve(request.headers.get("authorization"));
      },
      verify() {
        throw new Error("verify boom");
      },
    };

    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: throwingStrategy,
      onAuthFailure: (_req, result) =>
        new Response(JSON.stringify({ custom: true, reason: result.error }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    });
    await server.start();
    const res = await httpRequest(server.port, "/hello", {
      headers: { authorization: "Bearer something" },
    });
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.custom).toBe(true);
    expect(body.reason).toBe("verify boom");
  });

  it("uses custom AuthStrategy implementation", async () => {
    const apiKeyStrategy: AuthStrategy = {
      extractCredentials(request: Request) {
        return Promise.resolve(request.headers.get("x-api-key"));
      },
      verify(credentials: string) {
        if (credentials === "valid-key") {
          return Promise.resolve({ valid: true, claims: { keyId: "k1" } });
        }
        return Promise.resolve({ valid: false, error: "Invalid API key" });
      },
    };

    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: apiKeyStrategy,
    });
    await server.start();

    const res1 = await httpRequest(server.port, "/hello", {
      headers: { "x-api-key": "valid-key" },
    });
    expect(res1.status).toBe(200);

    const res2 = await httpRequest(server.port, "/hello", {
      headers: { "x-api-key": "bad-key" },
    });
    expect(res2.status).toBe(401);
  });
});

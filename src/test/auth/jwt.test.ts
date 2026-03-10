import { describe, expect, it } from "vitest";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { JWTStrategy } from "../../auth/jwt.js";
import http from "node:http";

function makeRequest(
  token?: string,
  opts?: { headerName?: string; method?: string }
): Request {
  const headers: Record<string, string> = {};
  if (token) {
    headers[opts?.headerName ?? "authorization"] = `Bearer ${token}`;
  }
  return new Request("http://localhost/test", {
    method: opts?.method ?? "GET",
    headers,
  });
}

describe("JWTStrategy", { timeout: 10_000 }, () => {
  describe("HMAC (HS256)", () => {
    const secret = "super-secret-key-that-is-long-enough-for-hs256!!";

    it("verifies a valid token", async () => {
      const strategy = new JWTStrategy({ secret });
      const token = await new SignJWT({ sub: "user-1", role: "admin" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(new TextEncoder().encode(secret));

      const creds = await strategy.extractCredentials(makeRequest(token));
      expect(creds).toBe(token);

      const result = await strategy.verify(creds!);
      expect(result.valid).toBe(true);
      expect(result.claims?.sub).toBe("user-1");
      expect(result.claims?.role).toBe("admin");
    });

    it("rejects an expired token", async () => {
      const strategy = new JWTStrategy({ secret });
      const token = await new SignJWT({ sub: "user-1" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(new TextEncoder().encode(secret));

      const result = await strategy.verify(token);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("rejects a token signed with wrong secret", async () => {
      const strategy = new JWTStrategy({ secret });
      const token = await new SignJWT({ sub: "user-1" })
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("1h")
        .sign(
          new TextEncoder().encode("wrong-secret-that-is-long-enough!!!!!")
        );

      const result = await strategy.verify(token);
      expect(result.valid).toBe(false);
    });

    it("validates issuer when configured", async () => {
      const strategy = new JWTStrategy({ secret, issuer: "my-app" });
      const validToken = await new SignJWT({ sub: "user-1" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("my-app")
        .setExpirationTime("1h")
        .sign(new TextEncoder().encode(secret));

      const validResult = await strategy.verify(validToken);
      expect(validResult.valid).toBe(true);

      const invalidToken = await new SignJWT({ sub: "user-1" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("wrong-app")
        .setExpirationTime("1h")
        .sign(new TextEncoder().encode(secret));

      const invalidResult = await strategy.verify(invalidToken);
      expect(invalidResult.valid).toBe(false);
    });

    it("validates audience when configured", async () => {
      const strategy = new JWTStrategy({ secret, audience: "api" });
      const token = await new SignJWT({ sub: "user-1" })
        .setProtectedHeader({ alg: "HS256" })
        .setAudience("api")
        .setExpirationTime("1h")
        .sign(new TextEncoder().encode(secret));

      const result = await strategy.verify(token);
      expect(result.valid).toBe(true);
    });
  });

  describe("RSA (RS256)", () => {
    it("verifies with RSA key pair", async () => {
      const { privateKey, publicKey } = await generateKeyPair("RS256");
      const strategy = new JWTStrategy({ key: publicKey });

      const token = await new SignJWT({ sub: "user-1" })
        .setProtectedHeader({ alg: "RS256" })
        .setExpirationTime("1h")
        .sign(privateKey);

      const result = await strategy.verify(token);
      expect(result.valid).toBe(true);
      expect(result.claims?.sub).toBe("user-1");
    });
  });

  describe("JWKS endpoint", () => {
    it("verifies token using JWKS server", async () => {
      const { privateKey, publicKey } = await generateKeyPair("RS256");
      const publicJWK = await exportJWK(publicKey);
      publicJWK.kid = "test-key-id";
      publicJWK.alg = "RS256";
      publicJWK.use = "sig";

      const jwksServer = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ keys: [publicJWK] }));
      });
      await new Promise<void>((resolve) => jwksServer.listen(0, resolve));
      const jwksPort = (jwksServer.address() as { port: number }).port;

      try {
        const strategy = new JWTStrategy({
          jwksEndpoint: `http://127.0.0.1:${jwksPort}`,
        });

        const token = await new SignJWT({ sub: "user-1" })
          .setProtectedHeader({ alg: "RS256", kid: "test-key-id" })
          .setExpirationTime("1h")
          .sign(privateKey);

        const result = await strategy.verify(token);
        expect(result.valid).toBe(true);
        expect(result.claims?.sub).toBe("user-1");
      } finally {
        jwksServer.close();
      }
    });
  });

  describe("token extraction", () => {
    it("extracts from Authorization Bearer header by default", async () => {
      const strategy = new JWTStrategy({ secret: "x".repeat(32) });
      const token = await strategy.extractCredentials(makeRequest("my-token"));
      expect(token).toBe("my-token");
    });

    it("returns null when no Authorization header", async () => {
      const strategy = new JWTStrategy({ secret: "x".repeat(32) });
      const token = await strategy.extractCredentials(makeRequest());
      expect(token).toBeNull();
    });

    it("returns null for non-Bearer auth", async () => {
      const strategy = new JWTStrategy({ secret: "x".repeat(32) });
      const req = new Request("http://localhost/test", {
        headers: { authorization: "Basic abc123" },
      });
      const token = await strategy.extractCredentials(req);
      expect(token).toBeNull();
    });

    it("extracts from query param when configured", async () => {
      const strategy = new JWTStrategy({
        secret: "x".repeat(32),
        tokenLocation: "query",
        tokenKey: "token",
      });
      const req = new Request("http://localhost/test?token=my-token");
      const token = await strategy.extractCredentials(req);
      expect(token).toBe("my-token");
    });

    it("extracts from cookie when configured", async () => {
      const strategy = new JWTStrategy({
        secret: "x".repeat(32),
        tokenLocation: "cookie",
        tokenKey: "session",
      });
      const req = new Request("http://localhost/test", {
        headers: { cookie: "other=x; session=my-token; foo=bar" },
      });
      const token = await strategy.extractCredentials(req);
      expect(token).toBe("my-token");
    });
  });
});

import { describe, expect, it } from "vitest";
import { authenticateRequest } from "../../server/core/authenticateRequest.js";
import type { AuthStrategy, AuthResult } from "../../auth/types.js";

const validStrategy: AuthStrategy = {
  extractCredentials(request: Request) {
    return Promise.resolve(request.headers.get("authorization"));
  },
  verify(credentials: string) {
    if (credentials === "Bearer valid") {
      return Promise.resolve({ valid: true, claims: { sub: "user-1" } });
    }
    return Promise.resolve({ valid: false, error: "Invalid token" });
  },
};

function makeRegistry(configs: Record<string, { auth?: boolean }> = {}) {
  return {
    getFunctionConfig(name: string) {
      return configs[name] ?? undefined;
    },
  } as any;
}

describe("authenticateRequest", () => {
  it("returns authenticated for public functions (publicFunctions list)", async () => {
    const result = await authenticateRequest({
      request: new Request("http://localhost/health"),
      functionName: "health",
      auth: validStrategy,
      registry: makeRegistry(),
      publicFunctions: ["health"],
    });
    expect(result.authenticated).toBe(true);
  });

  it("returns authenticated for functions with auth: false in registry", async () => {
    const result = await authenticateRequest({
      request: new Request("http://localhost/public"),
      functionName: "public",
      auth: validStrategy,
      registry: makeRegistry({ public: { auth: false } }),
      publicFunctions: [],
    });
    expect(result.authenticated).toBe(true);
  });

  it("returns authenticated with claims for valid credentials", async () => {
    const result = await authenticateRequest({
      request: new Request("http://localhost/api", {
        headers: { authorization: "Bearer valid" },
      }),
      functionName: "api",
      auth: validStrategy,
      registry: makeRegistry(),
      publicFunctions: [],
    });
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.claims).toEqual({ sub: "user-1" });
    }
  });

  it("returns 401 response for missing credentials", async () => {
    const result = await authenticateRequest({
      request: new Request("http://localhost/api"),
      functionName: "api",
      auth: validStrategy,
      registry: makeRegistry(),
      publicFunctions: [],
    });
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.response.status).toBe(401);
    }
  });

  it("returns 401 response for invalid credentials", async () => {
    const result = await authenticateRequest({
      request: new Request("http://localhost/api", {
        headers: { authorization: "Bearer bad" },
      }),
      functionName: "api",
      auth: validStrategy,
      registry: makeRegistry(),
      publicFunctions: [],
    });
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.response.status).toBe(401);
    }
  });

  it("returns 401 when extractCredentials throws", async () => {
    const throwing: AuthStrategy = {
      extractCredentials() { throw new Error("boom"); },
      verify() { return Promise.resolve({ valid: true }); },
    };
    const result = await authenticateRequest({
      request: new Request("http://localhost/api"),
      functionName: "api",
      auth: throwing,
      registry: makeRegistry(),
      publicFunctions: [],
    });
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.message).toBe("boom");
    }
  });

  it("returns 401 when verify throws", async () => {
    const throwing: AuthStrategy = {
      extractCredentials(req: Request) {
        return Promise.resolve(req.headers.get("authorization"));
      },
      verify() { throw new Error("verify boom"); },
    };
    const result = await authenticateRequest({
      request: new Request("http://localhost/api", {
        headers: { authorization: "Bearer something" },
      }),
      functionName: "api",
      auth: throwing,
      registry: makeRegistry(),
      publicFunctions: [],
    });
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      const body = await result.response.json();
      expect(body.message).toBe("verify boom");
    }
  });

  it("uses onAuthFailure callback for custom responses", async () => {
    const result = await authenticateRequest({
      request: new Request("http://localhost/api"),
      functionName: "api",
      auth: validStrategy,
      registry: makeRegistry(),
      publicFunctions: [],
      onAuthFailure: (_req, error) =>
        new Response(JSON.stringify({ custom: true }), { status: 403 }),
    });
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.custom).toBe(true);
    }
  });
});

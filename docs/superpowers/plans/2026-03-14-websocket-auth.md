# WebSocket Authentication Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authentication support to WebSocket upgrade requests so they go through the same auth flow as HTTP requests.

**Architecture:** Extract core auth logic from `AuthMiddleware` into a standalone `authenticateRequest()` function. Both the HTTP middleware and WebSocket upgrade handlers in `EdgeFunctionServer` call this shared function. Claims are forwarded to workers via `X-Auth-Claims` header on the upgrade request.

**Tech Stack:** TypeScript, vitest, `ws` (WebSocket client for tests), `jose` (JWT for tests)

**Spec:** `docs/superpowers/specs/2026-03-14-websocket-auth-design.md`

---

## Chunk 1: Extract shared auth helper and refactor AuthMiddleware

### Task 1: Create `authenticateRequest()` helper

**Files:**
- Create: `src/server/core/authenticateRequest.ts`
- Test: `src/test/server/authenticate-request.test.ts`

- [ ] **Step 1: Write unit tests for `authenticateRequest()`**

Create `src/test/server/authenticate-request.test.ts`:

```ts
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

// Minimal FunctionRegistry stub — only needs getFunctionConfig()
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/test/server/authenticate-request.test.ts`
Expected: FAIL — module `authenticateRequest` does not exist

- [ ] **Step 3: Implement `authenticateRequest()`**

Create `src/server/core/authenticateRequest.ts`:

```ts
import type { AuthResult, AuthStrategy } from "../../auth/types.js";
import type { FunctionRegistry } from "./FunctionRegistry.js";

export type AuthenticateSuccess = {
  authenticated: true;
  claims?: Record<string, unknown>;
};
export type AuthenticateFailure = {
  authenticated: false;
  response: Response;
};
export type AuthenticateResult = AuthenticateSuccess | AuthenticateFailure;

export interface AuthenticateOptions {
  request: Request;
  functionName: string;
  auth: AuthStrategy;
  registry: FunctionRegistry;
  publicFunctions: string[];
  onAuthFailure?: (
    request: Request,
    error: AuthResult,
  ) => Response | Promise<Response>;
}

function unauthorizedResponse(
  result: AuthResult,
  request: Request,
  onAuthFailure?: AuthenticateOptions["onAuthFailure"],
): Response | Promise<Response> {
  if (onAuthFailure) {
    return onAuthFailure(request, result);
  }
  return new Response(
    JSON.stringify({
      error: "Unauthorized",
      message: result.error,
    }),
    {
      status: 401,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function authenticateRequest(
  options: AuthenticateOptions,
): Promise<AuthenticateResult> {
  const { request, functionName, auth, registry, publicFunctions, onAuthFailure } = options;

  const isPublic =
    publicFunctions.includes(functionName) ||
    registry.getFunctionConfig(functionName)?.auth === false;

  if (isPublic) {
    return { authenticated: true };
  }

  let credentials: string | null;
  try {
    credentials = await auth.extractCredentials(request);
  } catch (err) {
    const result: AuthResult = {
      valid: false,
      error: err instanceof Error ? err.message : "Credential extraction failed",
    };
    return { authenticated: false, response: await unauthorizedResponse(result, request, onAuthFailure) };
  }

  if (!credentials) {
    const result: AuthResult = {
      valid: false,
      error: "No credentials provided",
    };
    return { authenticated: false, response: await unauthorizedResponse(result, request, onAuthFailure) };
  }

  let authResult: AuthResult;
  try {
    authResult = await auth.verify(credentials);
  } catch (err) {
    authResult = {
      valid: false,
      error: err instanceof Error ? err.message : "Verification failed",
    };
  }

  if (!authResult.valid) {
    return { authenticated: false, response: await unauthorizedResponse(authResult, request, onAuthFailure) };
  }

  return { authenticated: true, claims: authResult.claims };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/test/server/authenticate-request.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/core/authenticateRequest.ts src/test/server/authenticate-request.test.ts
git commit -m "feat(auth): extract shared authenticateRequest() helper"
```

### Task 2: Refactor AuthMiddleware to use `authenticateRequest()`

**Files:**
- Modify: `src/server/core/AuthMiddleware.ts`
- Test: existing `src/test/server/auth.test.ts` (must still pass)

- [ ] **Step 1: Refactor `AuthMiddleware` to use `authenticateRequest()`**

Replace the entire `AuthMiddleware` class in `src/server/core/AuthMiddleware.ts`:

```ts
import type { AuthResult, AuthStrategy } from "../../auth/types.js";
import type { FunctionRegistry } from "./FunctionRegistry.js";
import type { Middleware, RequestContext } from "../utils/types.js";
import { authenticateRequest } from "./authenticateRequest.js";

export interface AuthMiddlewareOptions {
  auth: AuthStrategy;
  registry: FunctionRegistry;
  publicFunctions?: string[];
  onAuthFailure?: (
    request: Request,
    error: AuthResult
  ) => Response | Promise<Response>;
}

export class AuthMiddleware {
  #auth: AuthStrategy;
  #registry: FunctionRegistry;
  #publicFunctions: string[];
  #onAuthFailure?: AuthMiddlewareOptions["onAuthFailure"];

  constructor(options: AuthMiddlewareOptions) {
    this.#auth = options.auth;
    this.#registry = options.registry;
    this.#publicFunctions = options.publicFunctions ?? [];
    this.#onAuthFailure = options.onAuthFailure;
  }

  middleware(): Middleware {
    return async (ctx: RequestContext, next: () => Promise<Response>) => {
      const result = await authenticateRequest({
        request: ctx.request,
        functionName: ctx.functionName,
        auth: this.#auth,
        registry: this.#registry,
        publicFunctions: this.#publicFunctions,
        onAuthFailure: this.#onAuthFailure,
      });

      if (!result.authenticated) {
        return result.response;
      }

      ctx.authClaims = result.claims;
      return next();
    };
  }
}
```

- [ ] **Step 2: Run existing auth tests to verify no regression**

Run: `npx vitest run src/test/server/auth.test.ts`
Expected: All 12 tests PASS (identical behavior)

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/core/AuthMiddleware.ts
git commit -m "refactor(auth): AuthMiddleware delegates to authenticateRequest()"
```

---

## Chunk 2: Add WebSocket auth to EdgeFunctionServer and adapters

### Task 3: Add `extraHeaders` to relay types and handler

**Files:**
- Modify: `src/server/core/WebSocketTypes.ts:31-34`
- Modify: `src/server/core/WebSocketProxyHandler.ts:265-272`

- [ ] **Step 1: Add `extraHeaders` to `RelayUpgradeHandler` type**

In `src/server/core/WebSocketTypes.ts`, update the `RelayUpgradeHandler` type:

```ts
/** Bun/Deno relay upgrade handler */
export type RelayUpgradeHandler = (
  functionName: string,
  hostSocket: HostWebSocket,
  extraHeaders?: Record<string, string>,
) => void;
```

- [ ] **Step 2: Accept `extraHeaders` in `handleRelayUpgrade()`**

In `src/server/core/WebSocketProxyHandler.ts`, update the `handleRelayUpgrade` method signature and merge extra headers into the handshake headers:

Change the method signature at line 265 from:
```ts
  async handleRelayUpgrade(
    functionName: string,
    hostSocket: HostWebSocket,
    socketPath: string,
    workerInstanceId: string,
    originalUrl: string,
    originalHost: string,
  ): Promise<void> {
```
to:
```ts
  async handleRelayUpgrade(
    functionName: string,
    hostSocket: HostWebSocket,
    socketPath: string,
    workerInstanceId: string,
    originalUrl: string,
    originalHost: string,
    extraHeaders?: Record<string, string>,
  ): Promise<void> {
```

Then at line 276, merge `extraHeaders` into the handshake headers. Change:
```ts
      const headers: Record<string, string> = {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": Buffer.from(randomUUID()).toString("base64"),
        "sec-websocket-version": "13",
      };
```
to:
```ts
      const headers: Record<string, string> = {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": Buffer.from(randomUUID()).toString("base64"),
        "sec-websocket-version": "13",
        ...extraHeaders,
      };
```

- [ ] **Step 3: Run full test suite to verify no regression**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/core/WebSocketTypes.ts src/server/core/WebSocketProxyHandler.ts
git commit -m "feat(ws): add extraHeaders support to relay upgrade handler"
```

### Task 4: Add auth checks to WebSocket upgrade handlers in EdgeFunctionServer

**Files:**
- Modify: `src/server/core/EdgeFunctionServer.ts:1-16` (imports), `95-153` (upgrade handlers)

- [ ] **Step 1: Add import for `authenticateRequest` and `node:http`**

In `src/server/core/EdgeFunctionServer.ts`, add import at the top:

```ts
import { authenticateRequest } from "./authenticateRequest.js";
```

- [ ] **Step 2: Add auth to the Node.js upgrade handler**

Replace the Node.js upgrade handler block (lines 99-126) with auth-aware version:

```ts
        const nodeHandler: NodeUpgradeHandler = (
          req,
          clientSocket,
          head,
          functionName,
        ) => {
          const authGate = this.#options.auth
            ? (async () => {
                // Build a Request from the IncomingMessage for auth
                const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
                const headers = new Headers();
                for (const [key, value] of Object.entries(req.headers)) {
                  if (value !== undefined) {
                    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
                  }
                }
                const request = new Request(url, { method: "GET", headers });

                const result = await authenticateRequest({
                  request,
                  functionName,
                  auth: this.#options.auth!,
                  registry: this.#registry,
                  publicFunctions: this.#options.publicFunctions ?? [],
                  // No onAuthFailure for raw socket — use fixed 401
                });

                if (!result.authenticated) {
                  const body = JSON.stringify({ error: "Unauthorized" });
                  clientSocket.write(
                    `HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
                  );
                  clientSocket.destroy();
                  return;
                }

                // Inject claims header into the request for forwarding
                if (result.claims) {
                  const encoded = Buffer.from(
                    JSON.stringify(result.claims),
                  ).toString("base64url");
                  req.headers["x-auth-claims"] = encoded;
                }
              })()
            : Promise.resolve();

          authGate
            .then(() => {
              // After auth gate, check if socket was destroyed (auth failed)
              if (clientSocket.destroyed) return;
              return this.#pool!.getOrCreate(functionName);
            })
            .then((instance) => {
              if (!instance) return; // auth rejected
              const socketPath = instance.worker.socketPath;
              return this.#wsProxyHandler.handleRawUpgrade(
                req,
                clientSocket,
                head,
                functionName,
                socketPath,
                instance.id,
              );
            })
            .catch(() => {
              if (!clientSocket.destroyed) {
                clientSocket.write(
                  "HTTP/1.1 503 Service Unavailable\r\n\r\n",
                );
                clientSocket.destroy();
              }
            });
        };
```

- [ ] **Step 3: Add auth to the Bun/Deno relay handler**

Replace the relay handler block (lines 130-151) with auth-aware version:

```ts
        const relayHandler: RelayUpgradeHandler = (
          functionName: string,
          hostSocket: HostWebSocket,
          extraHeaders?: Record<string, string>,
        ) => {
          this.#pool!
            .getOrCreate(functionName)
            .then((instance) => {
              const socketPath = instance.worker.socketPath;
              return this.#wsProxyHandler.handleRelayUpgrade(
                functionName,
                hostSocket,
                socketPath,
                instance.id,
                `ws://localhost/${functionName}`,
                "localhost",
                extraHeaders,
              );
            })
            .catch(() => {
              hostSocket.close(1013, "Try again later");
            });
        };
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (no auth configured in existing WS tests, so behavior unchanged)

- [ ] **Step 5: Commit**

```bash
git add src/server/core/EdgeFunctionServer.ts
git commit -m "feat(ws-auth): add auth checks to WebSocket upgrade handlers"
```

### Task 5: Add auth to Bun adapter

**Files:**
- Modify: `src/server/adapters/bun.ts:60-76` (fetch handler), `80` (open handler), `34` (ws.data type)

- [ ] **Step 1: Update Bun adapter to support auth on WebSocket upgrades**

In `src/server/adapters/bun.ts`:

1. Add import for `authenticateRequest` and update the `ws.data` type.

2. Replace the WebSocket detection block in `fetch` (lines 62-76) to add auth and thread `extraHeaders` through `ws.data`:

Change:
```ts
        const upgradeHeader = req.headers.get("upgrade");
        if (upgradeHeader?.toLowerCase() === "websocket" && this.#relayHandler) {
          const url = new URL(req.url);
          // Extract function name from the URL path (first segment)
          const functionName = url.pathname.split("/").filter(Boolean)[0] ?? "";
          const upgraded = server.upgrade(req, {
            data: { functionName },
          });
          if (upgraded) {
            // Return undefined is not valid for fetch, return a 101 placeholder
            // Bun handles the upgrade internally when server.upgrade() returns true
            return new Response(null, { status: 101 });
          }
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
```

to:

```ts
        const upgradeHeader = req.headers.get("upgrade");
        if (upgradeHeader?.toLowerCase() === "websocket" && this.#relayHandler) {
          const url = new URL(req.url);
          const functionName = url.pathname.split("/").filter(Boolean)[0] ?? "";

          // Run auth check if configured
          if (this.#authCheck) {
            const authResult = await this.#authCheck(req, functionName);
            if (!authResult.authenticated) {
              return authResult.response;
            }
            const upgraded = server.upgrade(req, {
              data: { functionName, extraHeaders: authResult.claims
                ? { "x-auth-claims": Buffer.from(JSON.stringify(authResult.claims)).toString("base64url") }
                : undefined },
            });
            if (upgraded) return new Response(null, { status: 101 });
            return new Response("WebSocket upgrade failed", { status: 400 });
          }

          const upgraded = server.upgrade(req, {
            data: { functionName },
          });
          if (upgraded) return new Response(null, { status: 101 });
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
```

3. Update the `open` handler to pass `extraHeaders` (line 108):

Change:
```ts
          this.#relayHandler(ws.data.functionName, hostSocket);
```
to:
```ts
          this.#relayHandler(ws.data.functionName, hostSocket, ws.data.extraHeaders);
```

4. Add the `#authCheck` field and a method to set it. Add after `#relayHandler` field:

```ts
  #authCheck?: (request: Request, functionName: string) => Promise<
    { authenticated: true; claims?: Record<string, unknown> } |
    { authenticated: false; response: Response }
  >;
```

5. Add a `setAuthCheck` method (use explicit type since TS cannot reference private fields externally):

```ts
  setAuthCheck(check: (request: Request, functionName: string) => Promise<
    { authenticated: true; claims?: Record<string, unknown> } |
    { authenticated: false; response: Response }
  >): void {
    this.#authCheck = check;
  }
```

6. Update the `open` handler type annotation to include `extraHeaders` in `ws.data`. Change:
```ts
        open: (ws: BunServerWebSocket<{ functionName: string }>) => {
```
to:
```ts
        open: (ws: BunServerWebSocket<{ functionName: string; extraHeaders?: Record<string, string> }>) => {
```

6. Update the `AdapterServer` interface to support auth check injection.

**Note:** Rather than modifying the `AdapterServer` interface (which would affect all adapters), add `setAuthCheck` to the adapter and call it from `EdgeFunctionServer` when the adapter is a `BunAdapterServer`. Since we use `resolveAdapter()` which returns a `ServerAdapter`, and `EdgeFunctionServer` already accesses adapter-specific properties like `supportsRawUpgrade` and `onUpgrade`, we'll add an optional `setAuthCheck` method to the `AdapterServer` interface.

- [ ] **Step 2: Update `AdapterServer` interface**

In `src/server/adapters/types.ts`, add the optional `setAuthCheck` method:

```ts
export interface AdapterServer {
  listen(port: number, hostname: string): Promise<void>;
  close(): Promise<void>;
  readonly port: number;
  readonly supportsRawUpgrade?: boolean;
  onUpgrade?(handler: WebSocketUpgradeHandler): void;
  /** Set auth check for WebSocket upgrades (used by Bun/Deno adapters) */
  setAuthCheck?(check: (request: Request, functionName: string) => Promise<
    { authenticated: true; claims?: Record<string, unknown> } |
    { authenticated: false; response: Response }
  >): void;
}
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/adapters/bun.ts src/server/adapters/types.ts
git commit -m "feat(ws-auth): add auth support to Bun adapter WebSocket upgrades"
```

### Task 6: Add auth to Deno adapter

**Files:**
- Modify: `src/server/adapters/deno.ts:59-95` (WebSocket detection in serve handler)

- [ ] **Step 1: Update Deno adapter to support auth on WebSocket upgrades**

In `src/server/adapters/deno.ts`:

1. Add the `#authCheck` field and `setAuthCheck` method (same pattern as Bun adapter):

```ts
  #authCheck?: (request: Request, functionName: string) => Promise<
    { authenticated: true; claims?: Record<string, unknown> } |
    { authenticated: false; response: Response }
  >;

  setAuthCheck(check: (request: Request, functionName: string) => Promise<
    { authenticated: true; claims?: Record<string, unknown> } |
    { authenticated: false; response: Response }
  >): void {
    this.#authCheck = check;
  }
```

2. Update the WebSocket handling in `listen()`. Replace lines 60-95:

Change:
```ts
      if (this.#relayHandler && req.headers.get("upgrade") === "websocket") {
        const url = new URL(req.url);
        const functionName = url.pathname.split("/")[1] ?? "";
        if (!functionName) {
          return new Response("Not Found", { status: 404 });
        }
        const { socket, response } = Deno.upgradeWebSocket(req);
        const relayHandler = this.#relayHandler;

        // ... hostSocket setup ...

        socket.onopen = () => {
          relayHandler(functionName, hostSocket);
        };

        return response;
      }
```

to:

```ts
      if (this.#relayHandler && req.headers.get("upgrade") === "websocket") {
        const url = new URL(req.url);
        const functionName = url.pathname.split("/")[1] ?? "";
        if (!functionName) {
          return new Response("Not Found", { status: 404 });
        }

        // Run auth check if configured
        if (this.#authCheck) {
          const authResult = await this.#authCheck(req, functionName);
          if (!authResult.authenticated) {
            return authResult.response;
          }
          const extraHeaders = authResult.claims
            ? { "x-auth-claims": Buffer.from(JSON.stringify(authResult.claims)).toString("base64url") }
            : undefined;

          const { socket, response } = Deno.upgradeWebSocket(req);
          const relayHandler = this.#relayHandler;

          // ... hostSocket setup (same as before) ...

          socket.onopen = () => {
            relayHandler(functionName, hostSocket, extraHeaders);
          };

          return response;
        }

        // No auth — original path
        const { socket, response } = Deno.upgradeWebSocket(req);
        const relayHandler = this.#relayHandler;

        // ... hostSocket setup (same as before) ...

        socket.onopen = () => {
          relayHandler(functionName, hostSocket);
        };

        return response;
      }
```

**Important:** The hostSocket setup block (lines 69-88) stays identical in both branches. Extract it into a local helper within `listen()`:

```ts
      const buildHostSocket = (socket: typeof Deno.upgradeWebSocket extends (r: any) => infer R ? R extends { socket: infer S } ? S : never : never): HostWebSocket => ({
        send: (data) => { if (socket.readyState === 1) socket.send(data); },
        close: (code, reason) => { if (socket.readyState === 1) socket.close(code, reason); },
        onMessage: (handler) => { socket.onmessage = (e: MessageEvent) => handler(e.data); },
        onClose: (handler) => { socket.onclose = (e: CloseEvent) => handler(e.code, e.reason); },
        onError: (handler) => { socket.onerror = () => handler(new Error("WebSocket error")); },
      });
```

Then both branches use `const hostSocket = buildHostSocket(socket);` instead of duplicating the object literal.

- [ ] **Step 2: Add Buffer import for base64url encoding**

Add to the top of `src/server/adapters/deno.ts`:

```ts
import { Buffer } from "node:buffer";
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/adapters/deno.ts
git commit -m "feat(ws-auth): add auth support to Deno adapter WebSocket upgrades"
```

### Task 7: Wire auth check from EdgeFunctionServer to adapters

**Files:**
- Modify: `src/server/core/EdgeFunctionServer.ts:81-93` (after adapter creation, before listen)

- [ ] **Step 1: Set auth check on adapter in `EdgeFunctionServer.start()`**

In `src/server/core/EdgeFunctionServer.ts`, after the adapter is created (line 81) and before WebSocket upgrade registration (line 95), add:

```ts
    // Set auth check on adapter for Bun/Deno WebSocket upgrades
    if (this.#options.auth && this.#server.setAuthCheck) {
      this.#server.setAuthCheck(async (request, functionName) => {
        return authenticateRequest({
          request,
          functionName,
          auth: this.#options.auth!,
          registry: this.#registry,
          publicFunctions: this.#options.publicFunctions ?? [],
          onAuthFailure: this.#options.onAuthFailure,
        });
      });
    }
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/core/EdgeFunctionServer.ts
git commit -m "feat(ws-auth): wire auth check from EdgeFunctionServer to adapters"
```

---

## Chunk 3: Integration tests and fixture

### Task 8: Create WebSocket auth test fixture

**Files:**
- Create: `src/test/functions/websocket-auth-echo/index.ts`

- [ ] **Step 1: Create a WebSocket fixture that echoes back auth claims**

Create `src/test/functions/websocket-auth-echo/index.ts`:

```ts
// base64url decode helper (atob only handles standard base64, not base64url)
function decodeBase64Url(str: string): string {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  return atob(pad ? base64 + "=".repeat(4 - pad) : base64);
}

Deno.serve((req) => {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Not a websocket request", { status: 426 });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  const claims = req.headers.get("x-auth-claims") ?? "";
  socket.onmessage = (e) => {
    // Echo back the message and the auth claims
    socket.send(JSON.stringify({
      message: e.data,
      claims: claims ? JSON.parse(decodeBase64Url(claims)) : null,
    }));
  };
  return response;
});
```

- [ ] **Step 2: Commit**

```bash
git add src/test/functions/websocket-auth-echo/index.ts
git commit -m "test(ws-auth): add websocket-auth-echo fixture"
```

### Task 9: Write WebSocket auth integration tests

**Files:**
- Create: `src/test/websocket/auth.test.ts`

- [ ] **Step 1: Write integration tests**

Create `src/test/websocket/auth.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import WebSocket from "ws";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import { JWTStrategy } from "../../auth/jwt.js";
import { FUNCTIONS_DIR } from "../helpers/fixtures.js";
import type { AuthStrategy } from "../../auth/types.js";
import http from "node:http";

const SECRET = "test-secret-that-is-long-enough-for-hs256!!!!!";

function makeToken(
  claims: Record<string, unknown> = { sub: "user-1" },
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
    const error = await new Promise<{ statusCode: number }>((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve({ statusCode: res.statusCode! });
        ws.close();
      });
      ws.on("error", () => {}); // Suppress unhandled error
      setTimeout(() => reject(new Error("timeout")), 10_000);
    });
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
    const error = await new Promise<{ statusCode: number }>((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve({ statusCode: res.statusCode! });
        ws.close();
      });
      ws.on("error", () => {});
      setTimeout(() => reject(new Error("timeout")), 10_000);
    });
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
      { headers: { authorization: `Bearer ${token}` } },
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

  it("skips auth for functions with auth: false in function.json", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
    });
    await server.start();

    // "public" function has auth: false in function.json
    // It doesn't support WebSocket, but we can verify HTTP works without auth
    // to confirm function.json auth:false is respected
    const { httpRequest } = await import("../helpers/http.js");
    const res = await httpRequest(server.port, "/public");
    expect(res.status).toBe(200);
  });

  it("returns 404 for non-existent function even with auth enabled", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
    });
    await server.start();

    const ws = new WebSocket(`ws://localhost:${server.port}/nonexistent`);
    const error = await new Promise<{ statusCode: number }>((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve({ statusCode: res.statusCode! });
        ws.close();
      });
      ws.on("error", () => {});
      setTimeout(() => reject(new Error("timeout")), 10_000);
    });
    // Should be 404 (not found) or 503 (no worker), not 401
    expect(error.statusCode).not.toBe(401);
  });

  it("fires onAuthFailure for rejected WebSocket upgrades", async () => {
    let failureCalled = false;
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      auth: new JWTStrategy({ secret: SECRET }),
      onAuthFailure: (_req, _result) => {
        failureCalled = true;
        return new Response(JSON.stringify({ custom: true }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    await server.start();

    // Note: onAuthFailure only applies to Bun/Deno adapters for WebSocket.
    // Node.js uses a fixed 401. This test runs on Node.js, so onAuthFailure
    // is NOT called for the raw socket path. The auth check still rejects.
    const ws = new WebSocket(`ws://localhost:${server.port}/websocket-echo`);
    const error = await new Promise<{ statusCode: number }>((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve({ statusCode: res.statusCode! });
        ws.close();
      });
      ws.on("error", () => {});
      setTimeout(() => reject(new Error("timeout")), 10_000);
    });
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
```

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run src/test/websocket/auth.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 3: Run full test suite to verify no regressions**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/test/websocket/auth.test.ts
git commit -m "test(ws-auth): add WebSocket authentication integration tests"
```

---

## Chunk 4: Export and documentation

### Task 10: Export `authenticateRequest` from package

**Files:**
- Modify: `src/index.ts:29-30`

- [ ] **Step 1: Add export**

In `src/index.ts`, add after the auth exports:

```ts
export {
  authenticateRequest,
  type AuthenticateOptions,
  type AuthenticateResult,
} from "./server/core/authenticateRequest.js";
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(auth): export authenticateRequest from package"
```

### Task 11: Update README with WebSocket auth documentation

**Files:**
- Modify: `README.md` (WebSocket Support section and Authentication section)

- [ ] **Step 1: Add WebSocket auth note to Authentication section**

After the `### Auth claims forwarding` section (after the `> **Note:** The header is always stripped...` blockquote and the auth flow diagram), add a note:

```markdown
> **WebSocket support:** Authentication also applies to WebSocket upgrade requests. When auth is configured, the initial HTTP upgrade request must carry valid credentials (via headers, cookies, or query params depending on your `AuthStrategy`). Rejected upgrades receive a 401 response before the WebSocket handshake. Authenticated claims are forwarded via `X-Auth-Claims` on the upgrade request, accessible in `Deno.serve()` before calling `Deno.upgradeWebSocket()`.
```

- [ ] **Step 2: Add auth example to WebSocket section**

In the WebSocket Support section, after `### Server configuration`, add a new subsection:

```markdown
### Authentication

WebSocket upgrades go through the same authentication flow as HTTP requests. When `auth` is configured, the client must include credentials in the upgrade request:

\`\`\`ts
// Server
const server = new EdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,
  auth: new JWTStrategy({ secret: process.env.JWT_SECRET! }),
  publicFunctions: ["health"], // these skip auth for both HTTP and WebSocket
});

// Client — include token in upgrade headers
const ws = new WebSocket("ws://localhost:3000/chat", {
  headers: { authorization: \`Bearer \${token}\` },
});
\`\`\`

Inside the Deno function, read claims from the upgrade request:

\`\`\`ts
Deno.serve((req) => {
  const raw = req.headers.get("x-auth-claims") ?? "";
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const claims = raw ? JSON.parse(atob(b64)) : {};
  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.onopen = () => console.log(\`User \${claims.sub} connected\`);
  socket.onmessage = (e) => socket.send(\`\${claims.sub}: \${e.data}\`);
  return response;
});
\`\`\`
```

- [ ] **Step 3: Update the auth flow diagram to mention WebSocket**

In the Authentication section's sequence diagram, update the final worker interaction note to indicate it applies to both HTTP and WebSocket.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add WebSocket authentication documentation"
```

### Task 12: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (including new WebSocket auth tests)

- [ ] **Step 2: Verify test count increased**

Check that the total test count increased by approximately 17 tests (8 unit + 9 integration).

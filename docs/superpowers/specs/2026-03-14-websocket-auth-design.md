# WebSocket Authentication Support

## Problem

WebSocket upgrade requests bypass the `AuthMiddleware` entirely. HTTP requests flow through the middleware chain (including auth), but WebSocket upgrades take a separate code path — they're intercepted at the adapter level (`'upgrade'` event for Node.js, fetch-level detection for Bun/Deno) and go directly to `WebSocketProxyHandler` without any credential validation.

This means:
- Authenticated servers have an unprotected WebSocket endpoint
- `publicFunctions` is not checked for WebSocket routes
- `function.json` `auth: false` is not respected for WebSocket
- No `X-Auth-Claims` forwarding to workers for WebSocket connections

## Approach

**Extract shared auth helper, call from both HTTP middleware and WebSocket upgrade paths.**

Factor out the core auth logic from `AuthMiddleware` into a standalone `authenticateRequest()` function. The middleware becomes a thin wrapper. The upgrade handlers in `EdgeFunctionServer` call the same function before proxying.

### Why this approach

- **Zero duplication** — single source of truth for auth logic
- **Small refactoring** — core auth logic is ~40 lines, extraction is straightforward
- **WebSocketProxyHandler stays untouched** (for Node.js path) — claims injection happens before calling the handler
- **Minimal API surface change** — only `RelayUpgradeHandler` type gains an optional `extraHeaders` parameter

### Alternatives considered

1. **Inline auth in upgrade handlers** — duplicates auth logic, maintenance risk
2. **Route WebSocket through middleware chain** — major adapter refactoring, breaks clean HTTP/WebSocket separation

## Design

### 1. Shared Auth Helper

New file: `src/server/core/authenticateRequest.ts`

```ts
type AuthenticateSuccess = { authenticated: true; claims?: Record<string, unknown> };
type AuthenticateFailure = { authenticated: false; response: Response };
type AuthenticateResult = AuthenticateSuccess | AuthenticateFailure;

interface AuthenticateOptions {
  request: Request;
  functionName: string;
  auth: AuthStrategy;
  registry: FunctionRegistry;
  publicFunctions: string[];
  onAuthFailure?: (request: Request, error: AuthResult) => Response | Promise<Response>;
}

async function authenticateRequest(options: AuthenticateOptions): Promise<AuthenticateResult>
```

Logic extracted from `AuthMiddleware.middleware()`:
1. Check `publicFunctions` array or `registry.getFunctionConfig(functionName)?.auth === false`
2. If public → return `{ authenticated: true }`
3. Extract credentials via `auth.extractCredentials(request)`
4. If extraction fails → return `{ authenticated: false, response: 401 }`
5. Verify via `auth.verify(credentials)`
6. If invalid → return `{ authenticated: false, response: 401 }`
7. Return `{ authenticated: true, claims }`

The `onAuthFailure` callback is used for custom 401 responses (returns `Response | Promise<Response>`), same as HTTP.

### 2. AuthMiddleware Refactoring

`AuthMiddleware.middleware()` becomes a thin wrapper:

```ts
middleware() {
  return async (ctx, next) => {
    const result = await authenticateRequest({
      request: ctx.request,
      functionName: ctx.functionName,
      auth: this.#auth,
      registry: this.#registry,
      publicFunctions: this.#publicFunctions,
      onAuthFailure: this.#onAuthFailure,
    });
    if (!result.authenticated) return result.response;
    ctx.authClaims = result.claims;
    return next();
  };
}
```

All existing HTTP auth behavior is preserved identically.

### 3. WebSocket Auth in EdgeFunctionServer

Auth checks added in `EdgeFunctionServer.start()` where upgrade handlers are registered. **Auth is only checked when `this.#options.auth` is configured** — when no auth strategy is set, upgrade handlers behave exactly as before (no auth gating).

**Node.js path (raw socket upgrade):**
1. If `this.#options.auth` is not set, skip auth and proceed directly to proxy
2. Construct a `Request` object from the incoming `http.IncomingMessage`
3. Call `authenticateRequest()` with the function name
4. If not authenticated: serialize a fixed `HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ...\r\n\r\n{"error":"..."}` to socket, destroy it, return. Note: `onAuthFailure` is **not** used for Node.js raw socket 401 because converting a `Response` to raw HTTP bytes adds complexity with minimal benefit — the fixed 401 is sufficient for WebSocket clients which typically only inspect the status code
5. If authenticated with claims: set `X-Auth-Claims` header on `req` before passing to `wsProxyHandler.handleNodeUpgrade()`

**Bun/Deno path (relay upgrade):**
1. If `this.#options.auth` is not set, skip auth and proceed directly to upgrade
2. Auth check happens in the adapter's fetch handler before accepting the upgrade
3. Call `authenticateRequest()` with the existing `Request` object — `onAuthFailure` applies here since we have a normal HTTP response path
4. If not authenticated: return the 401 Response directly (don't call `server.upgrade()` / `Deno.upgradeWebSocket()`)
5. If authenticated with claims: pass claims through `ws.data` (Bun) or directly (Deno) as `extraHeaders` to the relay handler

### 4. Claims Forwarding

**Node.js splice path:** Set `X-Auth-Claims` header on the `req` object before calling `handleNodeUpgrade()`. The handler already forwards request headers to the worker Unix socket — no `WebSocketProxyHandler` changes needed.

**Bun relay path:** The Bun adapter threads data through `ws.data`. Currently `ws.data` carries `{ functionName }`. Extend to `{ functionName, extraHeaders?: Record<string, string> }`. The `open` callback reads `ws.data.extraHeaders` and passes it to `relayHandler`. This is the key mechanism for Bun since auth runs in `fetch` but the relay handler fires in `open`.

**Deno relay path:** Simpler — everything runs in a single synchronous flow inside the fetch handler. Auth check and `Deno.upgradeWebSocket()` happen in sequence. Pass `extraHeaders` directly to the relay handler call.

Add optional `extraHeaders?: Record<string, string>` parameter to:
- `RelayUpgradeHandler` type in `WebSocketTypes.ts`
- `handleRelayUpgrade()` in `WebSocketProxyHandler.ts`

The extra headers are included when connecting to the worker's Unix socket. The Deno function reads claims from the upgrade request:

```ts
Deno.serve((req) => {
  const claims = JSON.parse(atob(req.headers.get("x-auth-claims") ?? ""));
  const { socket, response } = Deno.upgradeWebSocket(req);
  return response;
});
```

### 5. Auth Rejection Behavior

- **Before WebSocket handshake** — rejection returns HTTP 401, no WebSocket connection is established
- **Node.js raw socket:** Write fixed HTTP 401 JSON response bytes directly to the Duplex socket (with `Content-Type` and `Content-Length` headers), then destroy
- **Bun/Deno:** Return standard `Response` object with 401 status; `onAuthFailure` callback applies here

### 6. Function Existence vs Auth Ordering

Authentication runs **before** function existence checks for WebSocket upgrades. When a WebSocket upgrade targets a non-existent function and auth is enabled, the server returns 401 (not 404) if the request lacks valid credentials. This prevents function name enumeration — an unauthenticated caller cannot probe which functions exist by observing 404 vs 401 responses. Only after successful authentication does the server check whether the target function exists and return 404 if it does not.

## Files to Modify

| File | Change |
|------|--------|
| `src/server/core/authenticateRequest.ts` | **New** — shared auth helper function with `AuthenticateOptions` interface |
| `src/server/core/AuthMiddleware.ts` | Refactor to use `authenticateRequest()` |
| `src/server/core/EdgeFunctionServer.ts` | Add auth checks in upgrade handlers (gated on `this.#options.auth`) |
| `src/server/core/WebSocketTypes.ts` | Add `extraHeaders` to `RelayUpgradeHandler` |
| `src/server/core/WebSocketProxyHandler.ts` | Accept `extraHeaders` in `handleRelayUpgrade()` |
| `src/server/adapters/bun.ts` | Extend `ws.data` to carry `extraHeaders`, pass through to relay handler |
| `src/server/adapters/deno.ts` | Pass `extraHeaders` directly to relay handler call |
| `src/index.ts` | Export `authenticateRequest` if needed |

## Testing

### Unit tests
- `authenticateRequest()` — public bypass, valid credentials, invalid credentials, missing credentials, registry `auth: false` config, `onAuthFailure` callback invoked
- Existing `AuthMiddleware` tests pass unchanged after refactoring

### Integration tests (WebSocket + auth)
- Valid JWT → WebSocket connection established, claims accessible in Deno handler
- Invalid/missing JWT → 401 returned, no WebSocket connection
- `publicFunctions` entry → connection established without credentials
- `function.json` `auth: false` → connection established without credentials
- `onAuthFailure` callback fires for rejected WebSocket upgrades (Bun/Deno path)
- WebSocket upgrade to non-existent function with auth (unauthenticated) → 401 (auth runs before existence check)
- No auth configured + WebSocket upgrade → connection established (no regression)

### No regressions
- All existing HTTP auth tests pass unchanged
- All existing WebSocket tests pass unchanged (they don't configure `auth`)

## Out of Scope

- Per-message auth (re-validating credentials on each WebSocket frame)
- Token refresh/expiry during an active WebSocket connection
- WebSocket-specific auth strategies (these can be added later via the existing `AuthStrategy` interface)
- `onAuthFailure` for Node.js raw socket path (fixed 401 JSON response used instead)

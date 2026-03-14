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

async function authenticateRequest(
  request: Request,
  functionName: string,
  auth: AuthStrategy,
  registry: FunctionRegistry,
  publicFunctions: string[],
  onAuthFailure?: (request: Request, result: AuthResult) => Response,
): Promise<AuthenticateResult>
```

Logic extracted from `AuthMiddleware` lines 51-88:
1. Check `publicFunctions` array or `registry.getConfig(functionName).auth === false`
2. If public → return `{ authenticated: true }`
3. Extract credentials via `auth.extractCredentials(request)`
4. If extraction fails → return `{ authenticated: false, response: 401 }`
5. Verify via `auth.verify(credentials)`
6. If invalid → return `{ authenticated: false, response: 401 }`
7. Return `{ authenticated: true, claims }`

The `onAuthFailure` callback is used for custom 401 responses, same as HTTP.

### 2. AuthMiddleware Refactoring

`AuthMiddleware.middleware()` becomes a thin wrapper:

```ts
middleware() {
  return async (ctx, next) => {
    const result = await authenticateRequest(
      ctx.request, ctx.functionName, this.#auth,
      this.#registry, this.#publicFunctions, this.#onAuthFailure
    );
    if (!result.authenticated) return result.response;
    ctx.authClaims = result.claims;
    return next();
  };
}
```

All existing HTTP auth behavior is preserved identically.

### 3. WebSocket Auth in EdgeFunctionServer

Auth checks added in `EdgeFunctionServer.start()` where upgrade handlers are registered.

**Node.js path (raw socket upgrade):**
1. Construct a `Request` object from the incoming `http.IncomingMessage`
2. Call `authenticateRequest()` with the function name
3. If not authenticated: write raw `HTTP/1.1 401 Unauthorized\r\n\r\n` to socket, destroy it, return
4. If authenticated with claims: set `X-Auth-Claims` header on `req` before passing to `wsProxyHandler.handleNodeUpgrade()`

**Bun/Deno path (relay upgrade):**
1. Auth check happens in the adapter's fetch handler before accepting the upgrade
2. Call `authenticateRequest()` with the existing `Request` object
3. If not authenticated: return the 401 Response directly (don't call `server.upgrade()` / `Deno.upgradeWebSocket()`)
4. If authenticated with claims: pass claims as `extraHeaders` to the relay handler

### 4. Claims Forwarding

**Node.js splice path:** Set `X-Auth-Claims` header on the `req` object before calling `handleNodeUpgrade()`. The handler already forwards request headers to the worker Unix socket — no `WebSocketProxyHandler` changes needed.

**Bun/Deno relay path:** Add optional `extraHeaders?: Record<string, string>` parameter to:
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
- **Same `onAuthFailure` callback** — reused for both HTTP and WebSocket rejections
- **Node.js raw socket:** Write HTTP 401 response bytes directly to the Duplex socket, then destroy
- **Bun/Deno:** Return standard `Response` object with 401 status

## Files to Modify

| File | Change |
|------|--------|
| `src/server/core/authenticateRequest.ts` | **New** — shared auth helper function |
| `src/server/core/AuthMiddleware.ts` | Refactor to use `authenticateRequest()` |
| `src/server/core/EdgeFunctionServer.ts` | Add auth checks in upgrade handlers |
| `src/server/core/WebSocketTypes.ts` | Add `extraHeaders` to `RelayUpgradeHandler` |
| `src/server/core/WebSocketProxyHandler.ts` | Accept `extraHeaders` in `handleRelayUpgrade()` |
| `src/server/adapters/bun.ts` | Pass auth check result and headers through upgrade flow |
| `src/server/adapters/deno.ts` | Pass auth check result and headers through upgrade flow |
| `src/index.ts` | Export `authenticateRequest` if needed |

## Testing

### Unit tests
- `authenticateRequest()` — public bypass, valid credentials, invalid credentials, missing credentials, registry `auth: false`
- Existing `AuthMiddleware` tests pass unchanged after refactoring

### Integration tests (WebSocket + auth)
- Valid JWT → WebSocket connection established, claims accessible in Deno handler
- Invalid/missing JWT → 401 returned, no WebSocket connection
- `publicFunctions` entry → connection established without credentials
- `function.json` `auth: false` → connection established without credentials
- `onAuthFailure` callback fires for rejected WebSocket upgrades

### No regressions
- All existing HTTP auth tests pass unchanged
- All existing WebSocket tests pass unchanged (they don't configure `auth`)

## Out of Scope

- Per-message auth (re-validating credentials on each WebSocket frame)
- Token refresh/expiry during an active WebSocket connection
- WebSocket-specific auth strategies (these can be added later via the existing `AuthStrategy` interface)

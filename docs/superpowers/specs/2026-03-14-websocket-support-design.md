# WebSocket Support — Design Specification

**Date:** 2026-03-14
**Status:** Approved
**Phase:** 3 — Performance & Scaling

---

## Overview

Add WebSocket proxy support to `@cobeo2004/edge`, enabling Deno edge functions to serve WebSocket connections. The server transparently proxies WebSocket upgrades through to Deno workers over Unix sockets, with full support across all three server adapters (Node.js, Bun, Deno).

## Goals

- Full WebSocket parity with Supabase Edge Functions (client-facing and server-to-server)
- Standard WebSocket clients connect with no special libraries
- Deno functions use the standard `Deno.upgradeWebSocket()` API
- Zero-overhead byte-level proxying where possible (Node.js), message relay where required (Bun, Deno)
- Integrates with existing worker pool, lifecycle management, and load balancing

## Non-Goals

- WebSocket frame interception/modification middleware (future consideration)
- Message-level hooks (only lifecycle hooks: connect, close, error)
- WebSocket compression extension negotiation at the proxy layer

---

## Architecture

### Approach: HTTP Upgrade Passthrough

The server intercepts WebSocket upgrade requests at the adapter layer, forwards the upgrade handshake to the Deno worker's Unix socket, and then bridges the two connections bidirectionally. After the handshake completes, the server is a transparent pipe.

### Request Flow

```
Client --[WS upgrade]--> Server Adapter (intercepts upgrade)
  --> Middleware (auth, permissions — same as HTTP)
  --> WebSocketProxyHandler acquires worker from pool
  --> Raw HTTP/1.1 UPGRADE forwarded over Unix socket
  --> Deno bootstrap passes to user's fetch() handler
  --> User calls Deno.upgradeWebSocket(req)
  --> 101 response flows back
  --> Adapter bridges client <-> worker connection
  --> Frames flow bidirectionally
```

---

## Adapter Layer

The three runtimes have fundamentally different WebSocket APIs, requiring two proxying strategies.

### Node.js Adapter — Raw Socket Splicing

Node's `http.Server` emits an `'upgrade'` event with `(req: IncomingMessage, socket: stream.Duplex, head: Buffer)`, providing raw socket access.

- Listen for `'upgrade'` event on the `http.Server`
- Extract function name from URL (same routing as HTTP)
- Open a raw `net.connect({ path: socketPath })` to the worker's Unix socket
- Write the HTTP upgrade request verbatim to the worker socket
- When the worker responds with 101, write the 101 back to the client socket
- Splice: `clientSocket.pipe(workerSocket)` + `workerSocket.pipe(clientSocket)`
- After splice, zero-overhead byte pipe — no frame parsing needed
- Monitor both sockets for `'close'`/`'error'` events for cleanup and hooks

### Bun Adapter — Message Relay

`Bun.serve()` terminates WebSocket on the host side via `server.upgrade(req)`. No raw socket access — provides `ServerWebSocket` with `message`, `open`, `close`, `drain` callbacks.

- In `fetch`, detect upgrade and call `server.upgrade(req, { data: { functionName } })`
- In `websocket.open`, establish a raw connection to the worker's Unix socket and perform HTTP upgrade handshake
- Relay: `websocket.message` → write to worker socket; worker socket data → `ws.send()`
- `websocket.close` → close worker connection; worker close → `ws.close()`

### Deno Adapter — Message Relay

`Deno.serve()` uses `Deno.upgradeWebSocket(req)` which returns `{ socket, response }`. Like Bun, it terminates WebSocket on the host side.

- In fetch handler, detect upgrade and call `Deno.upgradeWebSocket(req)`
- On `socket.open`, establish connection to worker's Unix socket via `Deno.connect({ path: socketPath })` and perform HTTP upgrade handshake
- Relay messages bidirectionally
- Handle close/error symmetrically

**Note:** Deno docs state "WebSockets are only supported on HTTP/1.1 for now."

### Strategy Summary

| Adapter | Strategy       | Overhead              | Raw Socket Access |
|---------|----------------|-----------------------|-------------------|
| Node.js | Socket splice  | Zero (byte pipe)      | Yes               |
| Bun     | Message relay  | Minimal (native C++)  | No                |
| Deno    | Message relay  | Minimal               | No                |

### Adapter Interface Changes

The current `AdapterServer` interface only supports request/response via `RequestHandler`. WebSocket upgrades require extending the adapter contract:

```ts
// New optional method on AdapterServer
interface AdapterServer {
  listen(port: number, hostname?: string): Promise<void>;
  close(): Promise<void>;
  readonly port: number;

  /** Register a handler for WebSocket upgrade requests (optional capability) */
  onUpgrade?(handler: WebSocketUpgradeHandler): void;
}

// Node.js: receives raw socket for splice mode
type NodeUpgradeHandler = (
  req: http.IncomingMessage,
  clientSocket: stream.Duplex,
  head: Buffer,
  functionName: string
) => void;

// Bun/Deno: adapter terminates WebSocket, provides message-oriented interface
interface HostWebSocket {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: string | ArrayBuffer) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
}

type RelayUpgradeHandler = (
  functionName: string,
  hostSocket: HostWebSocket
) => void;

```

**Mode disambiguation:** `AdapterServer` exposes a readonly property to indicate its WebSocket capability:

```ts
interface AdapterServer {
  // ... existing methods ...

  /** Whether this adapter provides raw socket access for splice mode */
  readonly supportsRawUpgrade: boolean;
}
```

- Node.js adapter: `supportsRawUpgrade = true`, calls `onUpgrade` with `NodeUpgradeHandler`
- Bun/Deno adapters: `supportsRawUpgrade = false`, call `onUpgrade` with `RelayUpgradeHandler`

`WebSocketProxyHandler` checks `adapter.supportsRawUpgrade` at setup time to select splice vs. relay mode.

Each adapter implements `onUpgrade()`:
- **Node.js** — Registers `'upgrade'` event on the internal `http.Server` (accessible within the class), extracts function name from URL, calls the handler with `(req, socket, head, functionName)`
- **Bun** — WebSocket config must be provided at `Bun.serve()` creation time. The adapter's `createServer()` accepts an optional `WebSocketUpgradeHandler` and passes the `websocket` handlers object to `Bun.serve()` in the initial config. Wraps `ServerWebSocket` in `HostWebSocket`, calls the handler with `(functionName, hostWebSocket)`
- **Deno** — Detects upgrade in fetch handler, calls `Deno.upgradeWebSocket()`, wraps the `WebSocket` in `HostWebSocket`, calls the handler with `(functionName, hostWebSocket)`

### Node.js `head` Buffer Handling

The `'upgrade'` event passes a `head: Buffer` containing any data received after the upgrade request headers. This buffer must be written to the worker socket **before** piping begins, otherwise the first bytes of the WebSocket handshake may be lost:

```ts
workerSocket.write(head);
clientSocket.pipe(workerSocket);
workerSocket.pipe(clientSocket);
```

---

## WebSocket Proxy Handler

New class `WebSocketProxyHandler` in `src/server/core/` responsible for:

### Worker Resolution

Given a function name, acquire a worker from the pool via `WorkerLifecycleManager`. The WebSocket connection counts as an active request, pinning to that specific worker instance.

**Important:** WebSocket upgrades bypass the normal `WorkerRequestHandler` middleware to avoid double-counting active requests. The `WebSocketProxyHandler` calls `WorkerPool.acquire()` directly. Auth and permission middleware are applied before the upgrade reaches the proxy handler (at the adapter/server level), but the HTTP request/response flow in `WorkerRequestHandler` is not used.

The `WebSocketProxyHandler` also requires access to the worker's Unix socket path. Both the `DenoHTTPWorker` interface and `DenoHTTPWorkerImpl` class must expose a `readonly socketPath: string` accessor (`DenoHTTPWorkerImpl` adds a getter backed by the existing private `socketFile` field).

### Unix Socket Upgrade

Open a raw TCP connection to the worker's Unix socket and perform an HTTP/1.1 upgrade handshake:

```
GET / HTTP/1.1
Host: localhost
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <forwarded from client>
Sec-WebSocket-Version: 13
X-Deno-Worker-URL: <original URL>
X-Deno-Worker-Host: <original host>
<other forwarded headers>
```

Wait for the 101 response from the Deno worker.

### Two Operating Modes

- **Splice mode** (Node.js) — After 101, return both sockets to the adapter. The adapter pipes them together. The handler monitors for close/error.
- **Relay mode** (Bun/Deno) — After 101, the handler owns the worker-side raw socket. It parses WebSocket frames from the worker socket and emits them, and accepts messages to write as frames to the worker socket.

### Connection Tracking

Maintains a `Map<string, Set<WebSocketConnection>>` per function for:

- Enforcing `maxWebSocketConnections` per worker
- Keeping the worker alive when `websocketKeepsAlive: true`
- Releasing the active request count on close

### Lifecycle Hooks

Fires callbacks at connection boundaries:

- `onWebSocketConnect(functionName, connectionId)` — after successful 101
- `onWebSocketClose(functionName, connectionId, code, reason)` — on close from either side
- `onWebSocketError(functionName, connectionId, error)` — on error from either side

### Cleanup

When a connection closes (from either side):

1. Close the other side if still open
2. Remove from connection tracking
3. Release the active request on the worker
4. If worker has no active requests/connections and `websocketKeepsAlive: false`, idle timer starts

### Frame Codec for Relay Mode

A lightweight WebSocket frame codec (~300-500 lines including tests) for Bun/Deno relay mode:

- Read frame header (opcode, length, mask, 64-bit extended payload length)
- Handle text, binary, ping, pong, close frames
- Handle fragmented messages and continuation frames
- Proper close handshake (send/receive close frames with status codes)
- Masking/unmasking per RFC 6455
- Write frames back to the socket
- No extension negotiation (handled in the handshake, forwarded transparently)

Zero external dependencies.

### Proxy-Level Ping/Pong

For long-lived connections, the proxy layer optionally sends WebSocket ping frames at a configurable interval to detect silently dropped connections. This is separate from application-level ping/pong:

- `proxyPingInterval` option (default: disabled, e.g., `30000` ms to enable)
- Applies to relay mode only (splice mode passes ping/pong through transparently)
- If pong is not received within `proxyPingTimeout` (default: `10000` ms), the connection is considered dead and cleaned up
- Proxy-initiated pings use a unique payload prefix (`__edge_proxy_ping:<timestamp>`) to distinguish from application-originated pings. Pongs are matched by payload content per RFC 6455 (pong must echo the ping payload). Application pings/pongs are forwarded transparently.

---

## Bootstrap Layer

### Changes to `deno-bootstrap/serve.ts`

Minimal changes needed:

- **Request reconstruction for WebSocket upgrades** — The bootstrap currently does `new Request(url.toString(), req)` to rewrite the URL. `new Request()` will strip the internal WebSocket upgrade state that `Deno.upgradeWebSocket()` requires. For upgrade requests, the bootstrap must **skip Request reconstruction** and pass the original request directly to the user's `fetch()` handler. The URL rewriting should instead be communicated via headers (the existing `X-Deno-Worker-URL` header already carries the original URL). Concretely:
  ```ts
  // In bootstrap request handler:
  if (req.headers.get("upgrade") === "websocket") {
    // Pass original request directly — do NOT construct new Request()
    // The user's handler gets the original req with upgrade state intact
    return await handler(req);
  }
  // Non-upgrade: rewrite URL as before
  const rewritten = new Request(url.toString(), req);
  return await handler(rewritten);
  ```
- **Header preservation** — Existing header rewriting (`X-Deno-Worker-URL`, `X-Deno-Worker-Host`) must preserve WebSocket headers: `Upgrade`, `Connection`, `Sec-WebSocket-Key`, `Sec-WebSocket-Version`, `Sec-WebSocket-Protocol`, `Sec-WebSocket-Extensions`.
- **101 status code** — Verify the bootstrap doesn't interfere with non-200 range responses. The response from `Deno.upgradeWebSocket()` must be returned unmodified.

### User Function Code

Standard Deno WebSocket — no special API:

```ts
Deno.serve((req) => {
  if (req.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => console.log("connected");
    socket.onmessage = (e) => socket.send(`echo: ${e.data}`);
    socket.onclose = () => console.log("closed");
    return response;
  }
  return new Response("Hello");
});
```

Clients use any standard WebSocket library:

```js
const ws = new WebSocket("ws://localhost:3000/my-function");
```

---

## Worker Pool & Lifecycle Integration

### WorkerLifecycleManager Changes

**Active request counting:**
- `acquire()` increments active request count — WebSocket upgrades use this same path
- `release()` decrements on WebSocket connection close, not upgrade completion
- A worker with 3 HTTP requests and 5 WebSocket connections shows 8 active requests for load balancing

**New `websocketKeepsAlive` option (default: `true`):**
- When `true`: idle timeout and `workerMaxDuration` timers pause while any WebSocket connection is active
- When `false`: timers run normally. Worker termination closes all WebSocket connections (clients receive 1001 Going Away)
- Configurable per-function via `function.json` and globally via `EdgeFunctionServerOptions`

**New `maxWebSocketConnections` option (default: `100`):**
- Per worker instance limit
- Excess upgrades routed to another instance or trigger scale-up (up to `maxWorkers`)
- If all at capacity, upgrade rejected with 503

**Scale-down:**
- Workers above `minWorkers` only eligible for idle scale-down with zero active requests AND zero WebSocket connections
- Natural behavior — WebSocket connections count as active requests

### WorkerPool Changes

**Worker selection for upgrades:**
- Existing least-loaded routing via `acquire()`
- Additionally checks `maxWebSocketConnections` — skip instances at limit
- Spawns new instance if needed (up to `maxWorkers`) or rejects

**Worker termination with active WebSockets:**
1. `WebSocketProxyHandler` notified to close all connections on that instance
2. Close frames sent to clients with code 1001 (Going Away)
3. Connection tracking cleaned up
4. Worker process terminated after connections drain (5s grace period)

---

## Configuration & Public API

### EdgeFunctionServerOptions Additions

```ts
interface EdgeFunctionServerOptions {
  // ... existing options ...

  /** Max WebSocket connections per worker instance (default: 100) */
  maxWebSocketConnections?: number;

  /** Whether active WebSocket connections prevent idle timeout
      and workerMaxDuration from killing the worker (default: true) */
  websocketKeepsAlive?: boolean;

  /** Called when a WebSocket connection is established */
  onWebSocketConnect?: (functionName: string, connectionId: string) => void;

  /** Called when a WebSocket connection is closed */
  onWebSocketClose?: (functionName: string, connectionId: string, code: number, reason: string) => void;

  /** Called when a WebSocket connection errors */
  onWebSocketError?: (functionName: string, connectionId: string, error: Error) => void;
}
```

### Per-Function `function.json`

```json
{
  "maxWebSocketConnections": 50,
  "websocketKeepsAlive": false
}
```

Resolution order: `function.json` > server-level option > default.

### Stats Integration

```ts
interface WorkerStats {
  // ... existing fields ...

  /** Number of currently active WebSocket connections */
  activeWebSocketConnections: number;
  /** Total WebSocket connections since worker started */
  totalWebSocketConnections: number;
}
```

### New Exports

- `WebSocketProxyHandler` (class)
- `WebSocketConnection` (type)
- Config additions to existing option types

---

## Error Handling

| Scenario                             | Behavior                                                                 |
|--------------------------------------|--------------------------------------------------------------------------|
| Worker crashes mid-connection        | Client receives close 1006 (Abnormal) → `onWebSocketError` fires        |
| Client disconnects unexpectedly      | Worker socket closed → release active request → `onWebSocketClose` fires |
| Upgrade to non-existent function     | 404 response (same as HTTP)                                              |
| Function doesn't handle upgrade      | Non-101 response forwarded to client (e.g., 426 Upgrade Required)        |
| `maxWebSocketConnections` exceeded   | 503 Service Unavailable                                                  |
| Worker killed by `workerMaxDuration` | Close frame 1001 (Going Away) → connections cleaned up                   |
| Unix socket connect failure          | 502 Bad Gateway → `onWebSocketError` fires                               |
| Malformed upgrade request            | 400 Bad Request (adapter level)                                          |

## Graceful Shutdown

When `EdgeFunctionServer.shutdown()` is called:

1. Stop accepting new WebSocket upgrades (503 for new attempts)
2. Send close frame 1001 (Going Away) to all active WebSocket connections
3. Wait for close handshake completion (5s timeout)
4. Proceed with existing HTTP request draining
5. Terminate workers after all connections closed

---

## Testing Strategy

### Unit Tests

**WebSocket frame codec** (`src/test/websocket/codec.test.ts`):
- Parse/write text, binary, ping, pong, close frames
- Fragmented messages
- Masking/unmasking
- Edge cases: zero-length payloads, max payload sizes

**WebSocketProxyHandler** (`src/test/websocket/proxy.test.ts`):
- Connection tracking (add/remove, per-worker counts)
- `maxWebSocketConnections` enforcement
- Lifecycle hook invocation
- Cleanup on close from either side

**WorkerLifecycleManager** (`src/test/websocket/lifecycle.test.ts`):
- WebSocket connections count as active requests
- `websocketKeepsAlive: true` pauses idle timeout
- `websocketKeepsAlive: false` allows worker termination
- Scale-up triggered at WebSocket capacity
- Scale-down blocked with active connections

### Integration Tests

**End-to-end per adapter** (`src/test/websocket/e2e-{node,bun,deno}.test.ts`):
- Client connects → message echo → close
- Multiple concurrent WebSocket connections
- Mixed HTTP + WebSocket traffic
- WebSocket with path forwarding (`ws://host/func/sub/path`)
- Binary message support
- Subprotocol negotiation passthrough

**Error scenarios** (`src/test/websocket/errors.test.ts`):
- Non-existent function → 404
- Function doesn't upgrade → non-101 forwarded
- Worker crash → client close 1006
- Connection limit exceeded → 503
- Graceful shutdown → close 1001

### Test Fixture

```ts
// src/test/functions/websocket-echo/index.ts
Deno.serve((req) => {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Not a websocket request", { status: 426 });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.onmessage = (e) => socket.send(e.data);
  return response;
});
```

### Test Client

Uses `ws` npm package as WebSocket client (dev dependency only).

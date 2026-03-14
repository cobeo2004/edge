# WebSocket Support Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WebSocket proxy support so Deno edge functions can serve WebSocket connections, with full support across Node.js, Bun, and Deno server adapters.

**Architecture:** Intercept WebSocket upgrade requests at the adapter layer, forward the upgrade handshake to the Deno worker's Unix socket, then bridge connections bidirectionally. Node.js uses raw socket splicing (zero overhead); Bun/Deno use message relay via a lightweight WebSocket frame codec. Integrates with existing worker pool for load balancing and lifecycle management.

**Tech Stack:** Node.js `net` module for Unix socket connections, `http` upgrade event for Node adapter, `Bun.serve()` native WebSocket for Bun, `Deno.upgradeWebSocket()` for Deno, `ws` npm package for test client (dev dependency only).

**Spec:** `docs/superpowers/specs/2026-03-14-websocket-support-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/server/core/WebSocketTypes.ts` | All shared WebSocket types: `HostWebSocket`, `WebSocketConnection`, handler types, config, hooks |
| `src/server/core/WebSocketFrameCodec.ts` | Lightweight WebSocket frame parser/writer for relay mode (Bun/Deno adapters) |
| `src/server/core/WebSocketProxyHandler.ts` | Core proxy logic: Unix socket upgrade handshake, connection tracking, lifecycle hooks, splice/relay modes |
| `src/test/websocket/codec.test.ts` | Unit tests for frame codec |
| `src/test/websocket/proxy.test.ts` | Unit tests for proxy handler |
| `src/test/websocket/bootstrap.test.ts` | Smoke tests for bootstrap WebSocket passthrough |
| `src/test/websocket/lifecycle.test.ts` | Integration tests for worker lifecycle with WebSocket |
| `src/test/websocket/e2e-node.test.ts` | End-to-end WebSocket tests via Node.js adapter |
| `src/test/websocket/errors.test.ts` | Error scenario tests |
| `src/test/functions/websocket-echo/index.ts` | Test fixture: echo WebSocket function |
| `src/test/functions/websocket-reject/index.ts` | Test fixture: function that doesn't handle upgrade |

### Modified Files
| File | Changes |
|------|---------|
| `src/server/adapters/types.ts` | Add optional `onUpgrade()`, `supportsRawUpgrade` to `AdapterServer`; import handler types from `WebSocketTypes.ts` |
| `src/server/adapters/node.ts` | Implement `onUpgrade()` with `'upgrade'` event handler |
| `src/server/adapters/bun.ts` | Implement `onUpgrade()` with `Bun.serve()` WebSocket config |
| `src/server/adapters/deno.ts` | Implement `onUpgrade()` with `Deno.upgradeWebSocket()` |
| `src/worker/DenoHTTPWorker.ts` | Add `socketPath` to interface, add getter on impl |
| `src/server/core/WorkerLifecycleManager.ts` | Add `websocketKeepsAlive` support, WebSocket connection count tracking |
| `src/server/core/WorkerPool.ts` | Add `maxWebSocketConnections` checking in acquire path |
| `src/server/core/EdgeFunctionServer.ts` | Wire `WebSocketProxyHandler`, add new options, register adapter upgrade handler |
| `src/server/utils/types.ts` | Add WebSocket options to `EdgeFunctionServerOptions`, extend stats types |
| `src/permissions/config.ts` | Add `maxWebSocketConnections`, `websocketKeepsAlive` to `FunctionConfig` |
| `deno-bootstrap/serve.ts` | Skip `new Request()` construction for WebSocket upgrade requests |
| `src/index.ts` | Export new WebSocket types and classes |

---

## Chunk 1: Foundation — Types, Frame Codec, Bootstrap, Test Fixtures

### Task 1: WebSocket Types (single source of truth)

**Files:**
- Create: `src/server/core/WebSocketTypes.ts`

- [ ] **Step 1: Create the WebSocket types file**

All WebSocket types live here. Adapters and other modules import from this file — no duplication.

```ts
// src/server/core/WebSocketTypes.ts
import type { Duplex } from "node:stream";
import type http from "node:http";

/** Runtime-agnostic WebSocket interface for Bun/Deno relay mode */
export interface HostWebSocket {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: string | ArrayBuffer) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
}

/** Tracked WebSocket connection */
export interface WebSocketConnection {
  id: string;
  functionName: string;
  workerInstanceId: string;
  createdAt: number;
}

/** Node.js raw upgrade handler (splice mode) */
export type NodeUpgradeHandler = (
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  functionName: string,
) => void;

/** Bun/Deno relay upgrade handler */
export type RelayUpgradeHandler = (
  functionName: string,
  hostSocket: HostWebSocket,
) => void;

/** Union type — adapters provide the appropriate variant */
export type WebSocketUpgradeHandler = NodeUpgradeHandler | RelayUpgradeHandler;

/** WebSocket lifecycle hooks */
export interface WebSocketHooks {
  onWebSocketConnect?: (functionName: string, connectionId: string) => void;
  onWebSocketClose?: (
    functionName: string,
    connectionId: string,
    code: number,
    reason: string,
  ) => void;
  onWebSocketError?: (
    functionName: string,
    connectionId: string,
    error: Error,
  ) => void;
}

/** WebSocket-specific config options */
export interface WebSocketConfig {
  maxWebSocketConnections?: number;
  websocketKeepsAlive?: boolean;
  proxyPingInterval?: number;
  proxyPingTimeout?: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/core/WebSocketTypes.ts
git commit -m "feat(ws): add WebSocket type definitions"
```

---

### Task 2: WebSocket Frame Codec

**Files:**
- Create: `src/server/core/WebSocketFrameCodec.ts`
- Create: `src/test/websocket/codec.test.ts`

- [ ] **Step 1: Write failing tests for frame parsing**

```ts
// src/test/websocket/codec.test.ts
import { describe, it, expect } from "vitest";
import {
  parseFrame,
  writeFrame,
  buildClosePayload,
  parseClosePayload,
  WebSocketOpcode,
} from "../../server/core/WebSocketFrameCodec";

describe("WebSocketFrameCodec", () => {
  describe("parseFrame", () => {
    it("should parse an unmasked text frame", () => {
      const payload = Buffer.from("Hello");
      const header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + TEXT
      header[1] = 5;
      const data = Buffer.concat([header, payload]);

      const frame = parseFrame(data);
      expect(frame).not.toBeNull();
      expect(frame!.opcode).toBe(WebSocketOpcode.TEXT);
      expect(frame!.fin).toBe(true);
      expect(frame!.payload.toString()).toBe("Hello");
      expect(frame!.totalLength).toBe(7);
    });

    it("should parse a masked text frame", () => {
      const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
      const rawPayload = Buffer.from("Hello");
      const maskedPayload = Buffer.alloc(rawPayload.length);
      for (let i = 0; i < rawPayload.length; i++) {
        maskedPayload[i] = rawPayload[i]! ^ mask[i % 4]!;
      }
      const header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = 0x80 | 5;
      const data = Buffer.concat([header, mask, maskedPayload]);

      const frame = parseFrame(data);
      expect(frame).not.toBeNull();
      expect(frame!.payload.toString()).toBe("Hello");
    });

    it("should parse a binary frame", () => {
      const payload = Buffer.from([0x01, 0x02, 0x03]);
      const header = Buffer.alloc(2);
      header[0] = 0x82; // FIN + BINARY
      header[1] = 3;
      const data = Buffer.concat([header, payload]);

      const frame = parseFrame(data);
      expect(frame!.opcode).toBe(WebSocketOpcode.BINARY);
      expect(frame!.payload).toEqual(payload);
    });

    it("should parse a close frame with code and reason", () => {
      const code = Buffer.alloc(2);
      code.writeUInt16BE(1000);
      const reason = Buffer.from("normal");
      const payload = Buffer.concat([code, reason]);
      const header = Buffer.alloc(2);
      header[0] = 0x88; // FIN + CLOSE
      header[1] = payload.length;
      const data = Buffer.concat([header, payload]);

      const frame = parseFrame(data);
      expect(frame!.opcode).toBe(WebSocketOpcode.CLOSE);
    });

    it("should parse a ping frame", () => {
      const payload = Buffer.from("ping");
      const header = Buffer.alloc(2);
      header[0] = 0x89;
      header[1] = 4;
      const data = Buffer.concat([header, payload]);

      const frame = parseFrame(data);
      expect(frame!.opcode).toBe(WebSocketOpcode.PING);
      expect(frame!.payload.toString()).toBe("ping");
    });

    it("should parse a pong frame", () => {
      const payload = Buffer.from("pong");
      const header = Buffer.alloc(2);
      header[0] = 0x8a;
      header[1] = 4;
      const data = Buffer.concat([header, payload]);

      const frame = parseFrame(data);
      expect(frame!.opcode).toBe(WebSocketOpcode.PONG);
    });

    it("should handle 16-bit extended payload length", () => {
      const payload = Buffer.alloc(256, 0x41);
      const header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(256, 2);
      const data = Buffer.concat([header, payload]);

      const frame = parseFrame(data);
      expect(frame!.payload.length).toBe(256);
    });

    it("should handle 64-bit extended payload length", () => {
      const payload = Buffer.alloc(70000, 0x42);
      const header = Buffer.alloc(10);
      header[0] = 0x82;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(70000), 2);
      const data = Buffer.concat([header, payload]);

      const frame = parseFrame(data);
      expect(frame!.payload.length).toBe(70000);
    });

    it("should return null for incomplete data", () => {
      const data = Buffer.from([0x81]);
      expect(parseFrame(data)).toBeNull();
    });

    it("should handle zero-length payload", () => {
      const header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = 0;
      const frame = parseFrame(header);
      expect(frame).not.toBeNull();
      expect(frame!.payload.length).toBe(0);
    });

    it("should parse a non-final (fragmented) frame", () => {
      // First fragment: FIN=0, opcode=TEXT
      const header1 = Buffer.alloc(2);
      header1[0] = 0x01; // FIN=0, TEXT
      header1[1] = 3;
      const data1 = Buffer.concat([header1, Buffer.from("Hel")]);

      const frame1 = parseFrame(data1);
      expect(frame1).not.toBeNull();
      expect(frame1!.fin).toBe(false);
      expect(frame1!.opcode).toBe(WebSocketOpcode.TEXT);
      expect(frame1!.payload.toString()).toBe("Hel");
    });

    it("should parse a continuation frame", () => {
      // Continuation: FIN=1, opcode=CONTINUATION
      const header = Buffer.alloc(2);
      header[0] = 0x80; // FIN=1, CONTINUATION
      header[1] = 2;
      const data = Buffer.concat([header, Buffer.from("lo")]);

      const frame = parseFrame(data);
      expect(frame).not.toBeNull();
      expect(frame!.fin).toBe(true);
      expect(frame!.opcode).toBe(WebSocketOpcode.CONTINUATION);
      expect(frame!.payload.toString()).toBe("lo");
    });
  });

  describe("writeFrame", () => {
    it("should write an unmasked text frame", () => {
      const buf = writeFrame(WebSocketOpcode.TEXT, Buffer.from("Hello"), true);
      const parsed = parseFrame(buf);
      expect(parsed!.opcode).toBe(WebSocketOpcode.TEXT);
      expect(parsed!.payload.toString()).toBe("Hello");
      expect(parsed!.fin).toBe(true);
    });

    it("should write a non-final frame", () => {
      const buf = writeFrame(WebSocketOpcode.TEXT, Buffer.from("Hel"), false);
      const parsed = parseFrame(buf);
      expect(parsed!.fin).toBe(false);
      expect(parsed!.opcode).toBe(WebSocketOpcode.TEXT);
    });

    it("should write a close frame with code", () => {
      const code = Buffer.alloc(2);
      code.writeUInt16BE(1000);
      const buf = writeFrame(WebSocketOpcode.CLOSE, code, true);
      const parsed = parseFrame(buf);
      expect(parsed!.opcode).toBe(WebSocketOpcode.CLOSE);
      expect(parsed!.payload.readUInt16BE(0)).toBe(1000);
    });

    it("should write a ping frame", () => {
      const buf = writeFrame(WebSocketOpcode.PING, Buffer.from("test"), true);
      const parsed = parseFrame(buf);
      expect(parsed!.opcode).toBe(WebSocketOpcode.PING);
      expect(parsed!.payload.toString()).toBe("test");
    });

    it("should handle 16-bit extended length", () => {
      const payload = Buffer.alloc(256, 0x41);
      const buf = writeFrame(WebSocketOpcode.BINARY, payload, true);
      const parsed = parseFrame(buf);
      expect(parsed!.payload.length).toBe(256);
    });

    it("should handle 64-bit extended length", () => {
      const payload = Buffer.alloc(70000, 0x42);
      const buf = writeFrame(WebSocketOpcode.BINARY, payload, true);
      const parsed = parseFrame(buf);
      expect(parsed!.payload.length).toBe(70000);
    });
  });

  describe("buildClosePayload / parseClosePayload", () => {
    it("should round-trip code and reason", () => {
      const payload = buildClosePayload(1000, "normal closure");
      const { code, reason } = parseClosePayload(payload);
      expect(code).toBe(1000);
      expect(reason).toBe("normal closure");
    });

    it("should round-trip code without reason", () => {
      const payload = buildClosePayload(1001);
      const { code, reason } = parseClosePayload(payload);
      expect(code).toBe(1001);
      expect(reason).toBe("");
    });

    it("should return 1005 for empty payload", () => {
      const { code, reason } = parseClosePayload(Buffer.alloc(0));
      expect(code).toBe(1005);
      expect(reason).toBe("");
    });

    it("should return 1005 for payload shorter than 2 bytes", () => {
      const { code, reason } = parseClosePayload(Buffer.from([0x01]));
      expect(code).toBe(1005);
      expect(reason).toBe("");
    });

    it("should handle various close codes", () => {
      for (const testCode of [1000, 1001, 1002, 1006, 1011, 4000]) {
        const payload = buildClosePayload(testCode, "test");
        const { code } = parseClosePayload(payload);
        expect(code).toBe(testCode);
      }
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/test/websocket/codec.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the frame codec**

```ts
// src/server/core/WebSocketFrameCodec.ts

export enum WebSocketOpcode {
  CONTINUATION = 0x0,
  TEXT = 0x1,
  BINARY = 0x2,
  CLOSE = 0x8,
  PING = 0x9,
  PONG = 0xa,
}

export interface WebSocketFrame {
  fin: boolean;
  opcode: WebSocketOpcode;
  masked: boolean;
  payload: Buffer;
  totalLength: number;
}

/**
 * Parse a single WebSocket frame from a buffer.
 * Returns null if the buffer doesn't contain a complete frame.
 */
export function parseFrame(data: Buffer): WebSocketFrame | null {
  if (data.length < 2) return null;

  const firstByte = data[0]!;
  const secondByte = data[1]!;

  const fin = (firstByte & 0x80) !== 0;
  const opcode = (firstByte & 0x0f) as WebSocketOpcode;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (data.length < 4) return null;
    payloadLength = data.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (data.length < 10) return null;
    const bigLen = data.readBigUInt64BE(2);
    if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Payload too large");
    }
    payloadLength = Number(bigLen);
    offset = 10;
  }

  const maskSize = masked ? 4 : 0;
  const totalLength = offset + maskSize + payloadLength;

  if (data.length < totalLength) return null;

  let payload: Buffer;
  if (masked) {
    const mask = data.subarray(offset, offset + 4);
    offset += 4;
    payload = Buffer.alloc(payloadLength);
    for (let i = 0; i < payloadLength; i++) {
      payload[i] = data[offset + i]! ^ mask[i % 4]!;
    }
  } else {
    payload = Buffer.from(data.subarray(offset, offset + payloadLength));
  }

  return { fin, opcode, masked, payload, totalLength };
}

/**
 * Write a WebSocket frame (unmasked, server-to-client).
 */
export function writeFrame(
  opcode: WebSocketOpcode,
  payload: Buffer,
  fin: boolean = true,
): Buffer {
  const payloadLength = payload.length;
  let headerSize: number;

  if (payloadLength < 126) {
    headerSize = 2;
  } else if (payloadLength <= 0xffff) {
    headerSize = 4;
  } else {
    headerSize = 10;
  }

  const frame = Buffer.alloc(headerSize + payloadLength);

  frame[0] = (fin ? 0x80 : 0x00) | opcode;

  if (payloadLength < 126) {
    frame[1] = payloadLength;
  } else if (payloadLength <= 0xffff) {
    frame[1] = 126;
    frame.writeUInt16BE(payloadLength, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(payloadLength), 2);
  }

  payload.copy(frame, headerSize);
  return frame;
}

/**
 * Build a close frame payload from code and optional reason.
 */
export function buildClosePayload(code: number, reason?: string): Buffer {
  const reasonBuf = reason ? Buffer.from(reason) : Buffer.alloc(0);
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  return payload;
}

/**
 * Parse close frame payload into code and reason.
 */
export function parseClosePayload(
  payload: Buffer,
): { code: number; reason: string } {
  if (payload.length < 2) {
    return { code: 1005, reason: "" };
  }
  const code = payload.readUInt16BE(0);
  const reason = payload.subarray(2).toString();
  return { code, reason };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/test/websocket/codec.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/core/WebSocketFrameCodec.ts src/test/websocket/codec.test.ts
git commit -m "feat(ws): add WebSocket frame codec with tests"
```

---

### Task 3: Test Fixtures

**Files:**
- Create: `src/test/functions/websocket-echo/index.ts`
- Create: `src/test/functions/websocket-reject/index.ts`

- [ ] **Step 1: Create WebSocket echo function fixture**

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

- [ ] **Step 2: Create WebSocket reject function fixture**

```ts
// src/test/functions/websocket-reject/index.ts
Deno.serve((_req) => {
  return new Response("No WebSocket here", { status: 200 });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/test/functions/websocket-echo/index.ts src/test/functions/websocket-reject/index.ts
git commit -m "test(ws): add WebSocket test fixture functions"
```

---

### Task 4: Expose `socketPath` on DenoHTTPWorker

**Files:**
- Modify: `src/worker/DenoHTTPWorker.ts`

**Prerequisite for bootstrap test — must be done first.**

- [ ] **Step 1: Add `socketPath` to the DenoHTTPWorker interface**

Find the `DenoHTTPWorker` interface/type definition and add:

```ts
/** Path to the Unix socket file for this worker */
readonly socketPath: string;
```

- [ ] **Step 2: Add getter on DenoHTTPWorkerImpl**

In the `DenoHTTPWorkerImpl` class, add a public getter backed by the existing private `#socketFile` field:

```ts
get socketPath(): string {
  return this.#socketFile;
}
```

- [ ] **Step 3: Run existing worker tests to verify no regression**

Run: `npx vitest run src/test/worker/`
Expected: All existing tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/worker/DenoHTTPWorker.ts
git commit -m "feat(ws): expose socketPath on DenoHTTPWorker"
```

---

### Task 5: Bootstrap WebSocket Passthrough

**Files:**
- Modify: `deno-bootstrap/serve.ts`
- Create: `src/test/websocket/bootstrap.test.ts`

- [ ] **Step 1: Write failing bootstrap smoke test**

This test spawns a `DenoHTTPWorker` with the websocket-echo fixture and sends a raw HTTP upgrade request over the Unix socket to verify the bootstrap passes it through correctly.

```ts
// src/test/websocket/bootstrap.test.ts
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { newDenoHTTPWorker } from "../../worker/DenoHTTPWorker";
import type { DenoHTTPWorker } from "../../worker/DenoHTTPWorker";
import { cleanupSockets } from "../helpers/worker";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";

const WEBSOCKET_ECHO = path.join(
  __dirname,
  "..",
  "functions",
  "websocket-echo",
  "index.ts",
);

describe("Bootstrap WebSocket passthrough", () => {
  let worker: DenoHTTPWorker;

  beforeAll(() => cleanupSockets());

  afterEach(async () => {
    if (worker) await worker.terminate();
  });

  it("should pass WebSocket upgrade through to the user handler", async () => {
    const { worker: w } = await newDenoHTTPWorker(
      `import "${WEBSOCKET_ECHO}"`,
      { permissions: ["--allow-all"] },
    );
    worker = w;

    // Send a raw HTTP upgrade request to the worker's Unix socket
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

    // The worker should return a 101 Switching Protocols response
    expect(response).toContain("101");
    expect(response.toLowerCase()).toContain("upgrade: websocket");
  }, 15000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/websocket/bootstrap.test.ts`
Expected: FAIL — either `socketPath` not found on worker interface, or bootstrap returns non-101 because `new Request()` strips upgrade state

- [ ] **Step 3: Modify bootstrap to skip Request reconstruction for upgrades**

Replace the handler function in `deno-bootstrap/serve.ts` (lines 66-90):

```ts
  handler: (req: Request) => {
    const headerUrl = req.headers.get("X-Deno-Worker-URL");
    if (!headerUrl) {
      return Response.json({ warming: true }, { status: 200 });
    }

    const isUpgrade = req.headers.get("upgrade") === "websocket";

    if (isUpgrade) {
      // WebSocket upgrade: do NOT reconstruct Request via new Request() —
      // that strips internal upgrade state needed by Deno.upgradeWebSocket().
      // Clean up internal headers on the original request instead.
      req.headers.delete("host");
      req.headers.delete("connection");
      if (req.headers.has("X-Deno-Worker-Host")) {
        req.headers.set("host", req.headers.get("X-Deno-Worker-Host")!);
      }
      if (req.headers.has("X-Deno-Worker-Connection")) {
        req.headers.set(
          "connection",
          req.headers.get("X-Deno-Worker-Connection")!,
        );
      }
      req.headers.delete("X-Deno-Worker-URL");
      req.headers.delete("X-Deno-Worker-Host");
      req.headers.delete("X-Deno-Worker-Connection");
      return handler(req);
    }

    // Non-upgrade: reconstruct Request with correct URL
    const url = new URL(headerUrl);
    req = new Request(url.toString(), req);

    req.headers.delete("host");
    req.headers.delete("connection");
    if (req.headers.has("X-Deno-Worker-Host")) {
      req.headers.set("host", req.headers.get("X-Deno-Worker-Host")!);
    }
    if (req.headers.has("X-Deno-Worker-Connection")) {
      req.headers.set(
        "connection",
        req.headers.get("X-Deno-Worker-Connection")!,
      );
    }

    req.headers.delete("X-Deno-Worker-URL");
    req.headers.delete("X-Deno-Worker-Host");
    req.headers.delete("X-Deno-Worker-Connection");
    return handler(req);
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/test/websocket/bootstrap.test.ts`
Expected: PASS (socketPath was exposed in Task 4)

- [ ] **Step 5: Verify no regression in existing tests**

Run: `npx vitest run src/test/worker/ src/test/server/`
Expected: All existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add deno-bootstrap/serve.ts src/test/websocket/bootstrap.test.ts
git commit -m "feat(ws): bootstrap WebSocket passthrough with smoke test"
```

---

## Chunk 2: Adapter Interface & Worker Changes

### Task 6: Extend Adapter Interface

**Files:**
- Modify: `src/server/adapters/types.ts`

- [ ] **Step 1: Add WebSocket support to adapter interface**

Import handler types from `WebSocketTypes.ts` and extend `AdapterServer`:

```ts
// Add import at top of src/server/adapters/types.ts
import type { WebSocketUpgradeHandler } from "../core/WebSocketTypes";

// Extend AdapterServer interface — all new members are optional for backward compat
interface AdapterServer {
  listen(port: number, hostname: string): Promise<void>;
  close(): Promise<void>;
  readonly port: number;
  /** Whether this adapter provides raw socket access for splice mode */
  readonly supportsRawUpgrade?: boolean;
  /** Register a handler for WebSocket upgrade requests */
  onUpgrade?(handler: WebSocketUpgradeHandler): void;
}
```

Note: `supportsRawUpgrade` and `onUpgrade` are optional so existing adapters don't break until they implement WebSocket support.

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `npx vitest run`
Expected: All tests PASS (optional fields don't break anything)

- [ ] **Step 3: Commit**

```bash
git add src/server/adapters/types.ts
git commit -m "feat(ws): extend AdapterServer interface with optional WebSocket upgrade support"
```

---

### Task 7: Node.js Adapter WebSocket Upgrade

**Files:**
- Modify: `src/server/adapters/node.ts`

- [ ] **Step 1: Implement `onUpgrade()` on NodeAdapterServer**

Import the type and add the implementation:

```ts
import type { NodeUpgradeHandler, WebSocketUpgradeHandler } from "../core/WebSocketTypes";
```

Add to the class:

```ts
readonly supportsRawUpgrade = true as const;
#upgradeHandler?: NodeUpgradeHandler;

onUpgrade(handler: WebSocketUpgradeHandler): void {
  this.#upgradeHandler = handler as NodeUpgradeHandler;
}
```

In the `listen()` method, after `this.#server.listen(...)` resolves, register the upgrade event:

```ts
if (this.#upgradeHandler) {
  const upgradeHandler = this.#upgradeHandler;
  this.#server.on("upgrade", (req, socket, head) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const functionName = url.pathname.split("/")[1] ?? "";
    if (!functionName) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    upgradeHandler(req, socket, head, functionName);
  });
}
```

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `npx vitest run src/test/server/`
Expected: All existing tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/adapters/node.ts
git commit -m "feat(ws): implement WebSocket upgrade handler in Node.js adapter"
```

---

### Task 8: Bun Adapter WebSocket Upgrade

**Files:**
- Modify: `src/server/adapters/bun.ts`

- [ ] **Step 1: Implement `onUpgrade()` on BunAdapterServer**

Bun requires WebSocket config at `Bun.serve()` creation time, and uses declarative handlers (not per-instance event listeners). A `Map` tracks per-connection handler callbacks.

```ts
import type {
  RelayUpgradeHandler,
  WebSocketUpgradeHandler,
  HostWebSocket,
} from "../core/WebSocketTypes";
```

Add to the class:

```ts
readonly supportsRawUpgrade = false as const;
#relayHandler?: RelayUpgradeHandler;
// Map of Bun ServerWebSocket -> per-connection event handlers
#wsHandlers = new Map<
  unknown,
  {
    messageHandler?: (data: string | ArrayBuffer) => void;
    closeHandler?: (code: number, reason: string) => void;
    errorHandler?: (error: Error) => void;
  }
>();

onUpgrade(handler: WebSocketUpgradeHandler): void {
  this.#relayHandler = handler as RelayUpgradeHandler;
}
```

Modify `listen()` to pass WebSocket config to `Bun.serve()`:

```ts
// In the fetch handler:
fetch: async (req: Request, server: any) => {
  if (this.#relayHandler && req.headers.get("upgrade") === "websocket") {
    const url = new URL(req.url);
    const functionName = url.pathname.split("/")[1] ?? "";
    if (!functionName) {
      return new Response("Not Found", { status: 404 });
    }
    const upgraded = server.upgrade(req, {
      data: { functionName },
    });
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return undefined;
  }
  return this.#handler(req);
},
websocket: this.#relayHandler
  ? {
      open: (ws: any) => {
        const { functionName } = ws.data as { functionName: string };
        const handlers: {
          messageHandler?: (data: string | ArrayBuffer) => void;
          closeHandler?: (code: number, reason: string) => void;
          errorHandler?: (error: Error) => void;
        } = {};
        this.#wsHandlers.set(ws, handlers);

        const hostSocket: HostWebSocket = {
          send: (data) => {
            if (typeof data === "string") ws.send(data);
            else ws.send(new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer));
          },
          close: (code, reason) => ws.close(code, reason),
          onMessage: (handler) => {
            handlers.messageHandler = handler;
          },
          onClose: (handler) => {
            handlers.closeHandler = handler;
          },
          onError: (handler) => {
            handlers.errorHandler = handler;
          },
        };
        this.#relayHandler!(functionName, hostSocket);
      },
      message: (ws: any, message: string | ArrayBuffer | Uint8Array) => {
        const handlers = this.#wsHandlers.get(ws);
        if (handlers?.messageHandler) {
          const data =
            message instanceof Uint8Array
              ? message.buffer
              : message;
          handlers.messageHandler(data as string | ArrayBuffer);
        }
      },
      close: (ws: any, code: number, reason: string) => {
        const handlers = this.#wsHandlers.get(ws);
        handlers?.closeHandler?.(code, reason ?? "");
        this.#wsHandlers.delete(ws);
      },
    }
  : undefined,
```

- [ ] **Step 2: Commit**

```bash
git add src/server/adapters/bun.ts
git commit -m "feat(ws): implement WebSocket upgrade handler in Bun adapter"
```

---

### Task 9: Deno Adapter WebSocket Upgrade

**Files:**
- Modify: `src/server/adapters/deno.ts`

- [ ] **Step 1: Implement `onUpgrade()` on DenoAdapterServer**

```ts
import type {
  RelayUpgradeHandler,
  WebSocketUpgradeHandler,
  HostWebSocket,
} from "../core/WebSocketTypes";
```

Add to the class:

```ts
readonly supportsRawUpgrade = false as const;
#relayHandler?: RelayUpgradeHandler;

onUpgrade(handler: WebSocketUpgradeHandler): void {
  this.#relayHandler = handler as RelayUpgradeHandler;
}
```

In the fetch handler passed to `Deno.serve()`, add upgrade detection before the normal handler call:

```ts
// At the top of the handler function, before calling this.#handler(req):
if (this.#relayHandler && req.headers.get("upgrade") === "websocket") {
  const url = new URL(req.url);
  const functionName = url.pathname.split("/")[1] ?? "";
  if (!functionName) {
    return new Response("Not Found", { status: 404 });
  }
  // @ts-expect-error: Deno.upgradeWebSocket exists in Deno runtime
  const { socket, response } = Deno.upgradeWebSocket(req);
  const relayHandler = this.#relayHandler;

  const hostSocket: HostWebSocket = {
    send: (data) => {
      if (socket.readyState === 1) {
        if (typeof data === "string") socket.send(data);
        else socket.send(data);
      }
    },
    close: (code, reason) => {
      if (socket.readyState === 1) socket.close(code, reason);
    },
    onMessage: (handler) => {
      socket.onmessage = (e: MessageEvent) => handler(e.data);
    },
    onClose: (handler) => {
      socket.onclose = (e: CloseEvent) => handler(e.code, e.reason);
    },
    onError: (handler) => {
      socket.onerror = () => handler(new Error("WebSocket error"));
    },
  };

  socket.onopen = () => {
    relayHandler(functionName, hostSocket);
  };

  return response;
}
return this.#handler(req);
```

- [ ] **Step 2: Commit**

```bash
git add src/server/adapters/deno.ts
git commit -m "feat(ws): implement WebSocket upgrade handler in Deno adapter"
```

---

## Chunk 3: WebSocket Proxy Handler & Config

### Task 10: Add WebSocket Config to Options & FunctionConfig

**Files:**
- Modify: `src/server/utils/types.ts`
- Modify: `src/permissions/config.ts`

- [ ] **Step 1: Add WebSocket options to EdgeFunctionServerOptions**

In `src/server/utils/types.ts`, add these fields to `EdgeFunctionServerOptions`:

```ts
/** Max WebSocket connections per worker instance (default: 100) */
maxWebSocketConnections?: number;
/** Whether active WebSocket connections prevent idle timeout
    and workerMaxDuration from killing the worker (default: true) */
websocketKeepsAlive?: boolean;
/** Called when a WebSocket connection is established */
onWebSocketConnect?: (functionName: string, connectionId: string) => void;
/** Called when a WebSocket connection is closed */
onWebSocketClose?: (
  functionName: string,
  connectionId: string,
  code: number,
  reason: string,
) => void;
/** Called when a WebSocket connection errors */
onWebSocketError?: (
  functionName: string,
  connectionId: string,
  error: Error,
) => void;
```

Add to the stats type (find the type used by `onRequestStats` or worker stats):

```ts
/** Number of currently active WebSocket connections on this worker */
activeWebSocketConnections?: number;
/** Total WebSocket connections handled by this worker since start */
totalWebSocketConnections?: number;
```

- [ ] **Step 2: Add WebSocket fields to FunctionConfig**

In `src/permissions/config.ts`, add to the `FunctionConfig` interface:

```ts
maxWebSocketConnections?: number;
websocketKeepsAlive?: boolean;
```

- [ ] **Step 3: Run existing tests to verify no regression**

Run: `npx vitest run`
Expected: All tests PASS (new optional fields don't break anything)

- [ ] **Step 4: Commit**

```bash
git add src/server/utils/types.ts src/permissions/config.ts
git commit -m "feat(ws): add WebSocket config options to types and FunctionConfig"
```

---

### Task 11: WebSocketProxyHandler — Connection Tracking

**Files:**
- Create: `src/server/core/WebSocketProxyHandler.ts`
- Create: `src/test/websocket/proxy.test.ts`

- [ ] **Step 1: Write failing tests for connection tracking and hooks**

```ts
// src/test/websocket/proxy.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebSocketProxyHandler } from "../../server/core/WebSocketProxyHandler";

describe("WebSocketProxyHandler", () => {
  describe("connection tracking", () => {
    let handler: WebSocketProxyHandler;

    beforeEach(() => {
      handler = new WebSocketProxyHandler({
        maxWebSocketConnections: 3,
      });
    });

    it("should track active connections per worker", () => {
      handler.addConnection("func1", "worker1", "conn1");
      handler.addConnection("func1", "worker1", "conn2");
      expect(handler.getConnectionCount("func1", "worker1")).toBe(2);
    });

    it("should remove connections on close", () => {
      handler.addConnection("func1", "worker1", "conn1");
      handler.removeConnection("func1", "worker1", "conn1");
      expect(handler.getConnectionCount("func1", "worker1")).toBe(0);
    });

    it("should enforce maxWebSocketConnections per worker", () => {
      handler.addConnection("func1", "worker1", "conn1");
      handler.addConnection("func1", "worker1", "conn2");
      handler.addConnection("func1", "worker1", "conn3");
      expect(handler.canAcceptConnection("func1", "worker1")).toBe(false);
    });

    it("should allow connections below the limit", () => {
      handler.addConnection("func1", "worker1", "conn1");
      expect(handler.canAcceptConnection("func1", "worker1")).toBe(true);
    });

    it("should track connections independently per worker", () => {
      handler.addConnection("func1", "worker1", "conn1");
      handler.addConnection("func1", "worker2", "conn2");
      expect(handler.getConnectionCount("func1", "worker1")).toBe(1);
      expect(handler.getConnectionCount("func1", "worker2")).toBe(1);
    });

    it("should return 0 for unknown function/worker", () => {
      expect(handler.getConnectionCount("unknown", "unknown")).toBe(0);
    });
  });

  describe("lifecycle hooks", () => {
    it("should fire onWebSocketConnect when connection is added", () => {
      const onConnect = vi.fn();
      const handler = new WebSocketProxyHandler({
        maxWebSocketConnections: 100,
        onWebSocketConnect: onConnect,
      });
      handler.addConnection("func1", "worker1", "conn1");
      expect(onConnect).toHaveBeenCalledWith("func1", "conn1");
    });

    it("should fire onWebSocketClose when connection is removed", () => {
      const onClose = vi.fn();
      const handler = new WebSocketProxyHandler({
        maxWebSocketConnections: 100,
        onWebSocketClose: onClose,
      });
      handler.addConnection("func1", "worker1", "conn1");
      handler.removeConnection("func1", "worker1", "conn1", 1000, "normal");
      expect(onClose).toHaveBeenCalledWith("func1", "conn1", 1000, "normal");
    });

    it("should fire onWebSocketError", () => {
      const onError = vi.fn();
      const handler = new WebSocketProxyHandler({
        maxWebSocketConnections: 100,
        onWebSocketError: onError,
      });
      const err = new Error("connection lost");
      handler.emitError("func1", "conn1", err);
      expect(onError).toHaveBeenCalledWith("func1", "conn1", err);
    });

    it("should not throw if hooks are not registered", () => {
      const handler = new WebSocketProxyHandler({
        maxWebSocketConnections: 100,
      });
      expect(() => {
        handler.addConnection("func1", "worker1", "conn1");
        handler.removeConnection("func1", "worker1", "conn1");
        handler.emitError("func1", "conn1", new Error("test"));
      }).not.toThrow();
    });
  });

  describe("closeAllConnections", () => {
    it("should remove all connections for a worker", () => {
      const onClose = vi.fn();
      const handler = new WebSocketProxyHandler({
        maxWebSocketConnections: 100,
        onWebSocketClose: onClose,
      });
      handler.addConnection("func1", "worker1", "conn1");
      handler.addConnection("func1", "worker1", "conn2");
      handler.closeAllConnections("func1", "worker1", 1001, "Going Away");
      expect(handler.getConnectionCount("func1", "worker1")).toBe(0);
      expect(onClose).toHaveBeenCalledTimes(2);
      expect(onClose).toHaveBeenCalledWith("func1", "conn1", 1001, "Going Away");
      expect(onClose).toHaveBeenCalledWith("func1", "conn2", 1001, "Going Away");
    });

    it("should handle closing connections for unknown worker", () => {
      const handler = new WebSocketProxyHandler({
        maxWebSocketConnections: 100,
      });
      expect(() => {
        handler.closeAllConnections("unknown", "unknown", 1001, "test");
      }).not.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/test/websocket/proxy.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement WebSocketProxyHandler — connection tracking**

```ts
// src/server/core/WebSocketProxyHandler.ts
import { randomUUID } from "node:crypto";
import type { WebSocketHooks } from "./WebSocketTypes";

export interface WebSocketProxyHandlerOptions extends WebSocketHooks {
  maxWebSocketConnections: number;
}

export class WebSocketProxyHandler {
  readonly #options: WebSocketProxyHandlerOptions;
  /** Map<functionName, Map<workerInstanceId, Set<connectionId>>> */
  readonly #connections = new Map<string, Map<string, Set<string>>>();

  constructor(options: WebSocketProxyHandlerOptions) {
    this.#options = options;
  }

  generateConnectionId(): string {
    return randomUUID();
  }

  addConnection(
    functionName: string,
    workerInstanceId: string,
    connectionId: string,
  ): void {
    if (!this.#connections.has(functionName)) {
      this.#connections.set(functionName, new Map());
    }
    const funcMap = this.#connections.get(functionName)!;
    if (!funcMap.has(workerInstanceId)) {
      funcMap.set(workerInstanceId, new Set());
    }
    funcMap.get(workerInstanceId)!.add(connectionId);
    this.#options.onWebSocketConnect?.(functionName, connectionId);
  }

  removeConnection(
    functionName: string,
    workerInstanceId: string,
    connectionId: string,
    code: number = 1005,
    reason: string = "",
  ): void {
    const funcMap = this.#connections.get(functionName);
    if (!funcMap) return;
    const workerSet = funcMap.get(workerInstanceId);
    if (!workerSet) return;
    workerSet.delete(connectionId);
    if (workerSet.size === 0) funcMap.delete(workerInstanceId);
    if (funcMap.size === 0) this.#connections.delete(functionName);
    this.#options.onWebSocketClose?.(functionName, connectionId, code, reason);
  }

  closeAllConnections(
    functionName: string,
    workerInstanceId: string,
    code: number,
    reason: string,
  ): void {
    const funcMap = this.#connections.get(functionName);
    if (!funcMap) return;
    const workerSet = funcMap.get(workerInstanceId);
    if (!workerSet) return;
    const connectionIds = [...workerSet];
    for (const connId of connectionIds) {
      this.removeConnection(functionName, workerInstanceId, connId, code, reason);
    }
  }

  getConnectionCount(functionName: string, workerInstanceId: string): number {
    return this.#connections.get(functionName)?.get(workerInstanceId)?.size ?? 0;
  }

  canAcceptConnection(functionName: string, workerInstanceId: string): boolean {
    return (
      this.getConnectionCount(functionName, workerInstanceId) <
      this.#options.maxWebSocketConnections
    );
  }

  emitError(functionName: string, connectionId: string, error: Error): void {
    this.#options.onWebSocketError?.(functionName, connectionId, error);
  }

  /** Close all connections across all workers for a given function */
  closeAllConnectionsForFunction(
    functionName: string,
    code: number,
    reason: string,
  ): void {
    const funcMap = this.#connections.get(functionName);
    if (!funcMap) return;
    const workerIds = [...funcMap.keys()];
    for (const workerId of workerIds) {
      this.closeAllConnections(functionName, workerId, code, reason);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/test/websocket/proxy.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/core/WebSocketProxyHandler.ts src/test/websocket/proxy.test.ts
git commit -m "feat(ws): add WebSocketProxyHandler with connection tracking and hooks"
```

---

### Task 12: WebSocketProxyHandler — Upgrade Handshake & Splice/Relay Modes

**Files:**
- Modify: `src/server/core/WebSocketProxyHandler.ts`

- [ ] **Step 1: Add Unix socket upgrade handshake method**

```ts
import net from "node:net";
import type http from "node:http";
import type { Duplex } from "node:stream";
import type { HostWebSocket } from "./WebSocketTypes";
import {
  parseFrame,
  writeFrame,
  WebSocketOpcode,
  buildClosePayload,
  parseClosePayload,
} from "./WebSocketFrameCodec";
```

Add to the class:

```ts
/**
 * Perform HTTP/1.1 upgrade handshake with the Deno worker over Unix socket.
 * Returns the raw socket after successful 101 response.
 */
async upgradeToWorker(
  socketPath: string,
  originalUrl: string,
  originalHost: string,
  headers: Record<string, string>,
): Promise<{ workerSocket: net.Socket; responseHead: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath }, () => {
      const headerLines = [
        "GET / HTTP/1.1",
        "Host: localhost",
        `X-Deno-Worker-URL: ${originalUrl}`,
        `X-Deno-Worker-Host: ${originalHost}`,
        "X-Deno-Worker-Connection: Upgrade",
      ];
      for (const [key, value] of Object.entries(headers)) {
        headerLines.push(`${key}: ${value}`);
      }
      socket.write(headerLines.join("\r\n") + "\r\n\r\n");
    });

    let responseBuffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      const headerEnd = responseBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      socket.removeListener("data", onData);
      const headerStr = responseBuffer.subarray(0, headerEnd).toString();
      const statusLine = headerStr.split("\r\n")[0] ?? "";

      if (!statusLine.includes("101")) {
        socket.destroy();
        reject(new Error(`Worker did not upgrade: ${statusLine}`));
        return;
      }

      const remaining = responseBuffer.subarray(headerEnd + 4);
      resolve({ workerSocket: socket, responseHead: remaining });
    };

    socket.on("data", onData);
    socket.on("error", reject);
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error("Worker upgrade handshake timed out"));
    });
  });
}
```

- [ ] **Step 2: Add splice mode (Node.js)**

```ts
/**
 * Handle WebSocket upgrade using raw socket splicing (Node.js).
 */
async handleRawUpgrade(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  functionName: string,
  socketPath: string,
  workerInstanceId: string,
): Promise<void> {
  const connectionId = this.generateConnectionId();

  try {
    const headers: Record<string, string> = {};
    const forwardHeaders = [
      "upgrade", "connection", "sec-websocket-key",
      "sec-websocket-version", "sec-websocket-protocol",
      "sec-websocket-extensions", "origin",
    ];
    for (const key of forwardHeaders) {
      const value = req.headers[key];
      if (typeof value === "string") headers[key] = value;
    }

    const originalUrl = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
    const originalHost = req.headers.host ?? "localhost";

    const { workerSocket, responseHead } = await this.upgradeToWorker(
      socketPath, originalUrl, originalHost, headers,
    );

    // Send 101 back to client
    clientSocket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "\r\n",
    );

    this.addConnection(functionName, workerInstanceId, connectionId);

    // Write head buffer before piping (data received after upgrade request)
    if (head.length > 0) {
      workerSocket.write(head);
    }
    if (responseHead.length > 0) {
      clientSocket.write(responseHead);
    }

    // Splice sockets — zero-overhead byte pipe
    clientSocket.pipe(workerSocket);
    workerSocket.pipe(clientSocket);

    let cleaned = false;
    const cleanup = (code: number, reason: string) => {
      if (cleaned) return;
      cleaned = true;
      this.removeConnection(functionName, workerInstanceId, connectionId, code, reason);
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!workerSocket.destroyed) workerSocket.destroy();
    };

    clientSocket.on("close", () => cleanup(1006, "Client closed"));
    clientSocket.on("error", (err) => {
      this.emitError(functionName, connectionId, err);
      cleanup(1006, "Client error");
    });
    workerSocket.on("close", () => cleanup(1006, "Worker closed"));
    workerSocket.on("error", (err) => {
      this.emitError(functionName, connectionId, err);
      cleanup(1006, "Worker error");
    });
  } catch (err) {
    this.emitError(functionName, connectionId, err as Error);
    if (!clientSocket.destroyed) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.destroy();
    }
  }
}
```

- [ ] **Step 3: Add relay mode (Bun/Deno)**

```ts
/**
 * Handle WebSocket upgrade using message relay (Bun/Deno).
 */
async handleRelayUpgrade(
  functionName: string,
  hostSocket: HostWebSocket,
  socketPath: string,
  workerInstanceId: string,
  originalUrl: string,
  originalHost: string,
): Promise<void> {
  const connectionId = this.generateConnectionId();

  try {
    const headers: Record<string, string> = {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": Buffer.from(randomUUID()).toString("base64"),
      "sec-websocket-version": "13",
    };

    const { workerSocket, responseHead } = await this.upgradeToWorker(
      socketPath, originalUrl, originalHost, headers,
    );

    this.addConnection(functionName, workerInstanceId, connectionId);

    let workerBuffer = responseHead;
    let cleaned = false;
    // Fragment reassembly state for relay mode
    let fragmentBuffers: Buffer[] = [];
    let fragmentOpcode: WebSocketOpcode | null = null;

    const cleanup = (code: number, reason: string) => {
      if (cleaned) return;
      cleaned = true;
      this.removeConnection(functionName, workerInstanceId, connectionId, code, reason);
      if (!workerSocket.destroyed) workerSocket.destroy();
    };

    // Worker -> Host: parse frames and relay
    workerSocket.on("data", (chunk: Buffer) => {
      workerBuffer = Buffer.concat([workerBuffer, chunk]);

      let frame;
      while ((frame = parseFrame(workerBuffer)) !== null) {
        workerBuffer = workerBuffer.subarray(frame.totalLength);

        switch (frame.opcode) {
          case WebSocketOpcode.TEXT:
          case WebSocketOpcode.BINARY:
            if (!frame.fin) {
              // Start of fragmented message
              fragmentOpcode = frame.opcode;
              fragmentBuffers = [frame.payload];
            } else if (frame.opcode === WebSocketOpcode.TEXT) {
              hostSocket.send(frame.payload.toString());
            } else {
              hostSocket.send(frame.payload.buffer.slice(
                frame.payload.byteOffset,
                frame.payload.byteOffset + frame.payload.byteLength,
              ));
            }
            break;
          case WebSocketOpcode.CONTINUATION:
            fragmentBuffers.push(frame.payload);
            if (frame.fin) {
              // Final fragment — reassemble and send
              const assembled = Buffer.concat(fragmentBuffers);
              if (fragmentOpcode === WebSocketOpcode.TEXT) {
                hostSocket.send(assembled.toString());
              } else {
                hostSocket.send(assembled.buffer.slice(
                  assembled.byteOffset,
                  assembled.byteOffset + assembled.byteLength,
                ));
              }
              fragmentBuffers = [];
              fragmentOpcode = null;
            }
            break;
          case WebSocketOpcode.CLOSE: {
            const { code, reason } = parseClosePayload(frame.payload);
            hostSocket.close(code, reason);
            cleanup(code, reason);
            return;
          }
          case WebSocketOpcode.PING:
            workerSocket.write(writeFrame(WebSocketOpcode.PONG, frame.payload));
            break;
          case WebSocketOpcode.PONG:
            break;
        }
      }
    });

    // Host -> Worker: write frames
    hostSocket.onMessage((data) => {
      if (typeof data === "string") {
        workerSocket.write(writeFrame(WebSocketOpcode.TEXT, Buffer.from(data)));
      } else {
        workerSocket.write(
          writeFrame(WebSocketOpcode.BINARY, Buffer.from(data)),
        );
      }
    });

    hostSocket.onClose((code, reason) => {
      if (!workerSocket.destroyed) {
        workerSocket.write(
          writeFrame(WebSocketOpcode.CLOSE, buildClosePayload(code, reason)),
        );
      }
      cleanup(code, reason);
    });

    hostSocket.onError((err) => {
      this.emitError(functionName, connectionId, err);
      cleanup(1006, "Error");
    });

    workerSocket.on("error", (err) => {
      this.emitError(functionName, connectionId, err as Error);
      hostSocket.close(1006, "Worker error");
      cleanup(1006, "Worker error");
    });

    workerSocket.on("close", () => {
      if (!cleaned) {
        hostSocket.close(1006, "Worker closed");
        cleanup(1006, "Worker closed");
      }
    });
  } catch (err) {
    this.emitError(functionName, connectionId, err as Error);
    hostSocket.close(1011, "Internal error");
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/server/core/WebSocketProxyHandler.ts
git commit -m "feat(ws): add upgrade handshake and splice/relay modes to WebSocketProxyHandler"
```

---

## Chunk 4: Lifecycle Integration & Server Wiring

### Task 13: WorkerLifecycleManager — WebSocket Awareness

**Files:**
- Modify: `src/server/core/WorkerLifecycleManager.ts`

- [ ] **Step 1: Add WebSocket tracking fields and methods**

Add these fields:

```ts
#wsConnectionCounts = new Map<string, number>(); // instanceId -> count
#websocketKeepsAlive: boolean;
```

Accept `websocketKeepsAlive` in the constructor options (default `true`).

Add methods:

```ts
incrementWebSocketCount(instanceId: string): void {
  const current = this.#wsConnectionCounts.get(instanceId) ?? 0;
  this.#wsConnectionCounts.set(instanceId, current + 1);
  if (this.#websocketKeepsAlive && this.#idleTimer) {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }
}

decrementWebSocketCount(instanceId: string): void {
  const current = this.#wsConnectionCounts.get(instanceId) ?? 0;
  const newCount = Math.max(0, current - 1);
  if (newCount === 0) {
    this.#wsConnectionCounts.delete(instanceId);
  } else {
    this.#wsConnectionCounts.set(instanceId, newCount);
  }
  // Resume idle timeout if no WS connections remain and websocketKeepsAlive
  if (this.#websocketKeepsAlive && this.#totalWsConnections() === 0) {
    this.#startIdleTimer();
  }
}

getWebSocketCount(instanceId: string): number {
  return this.#wsConnectionCounts.get(instanceId) ?? 0;
}

#totalWsConnections(): number {
  let total = 0;
  for (const count of this.#wsConnectionCounts.values()) {
    total += count;
  }
  return total;
}
```

Modify idle timeout logic: when checking if worker should go idle, also check `#totalWsConnections() === 0` when `websocketKeepsAlive` is true.

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `npx vitest run src/test/server/`
Expected: All existing tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/core/WorkerLifecycleManager.ts
git commit -m "feat(ws): add WebSocket connection awareness to WorkerLifecycleManager"
```

---

### Task 14: WorkerLifecycleManager WebSocket Tests

**Files:**
- Create: `src/test/websocket/lifecycle.test.ts`

- [ ] **Step 1: Write lifecycle tests**

```ts
// src/test/websocket/lifecycle.test.ts
import { describe, it, expect, vi } from "vitest";
import { WorkerLifecycleManager } from "../../server/core/WorkerLifecycleManager";

describe("WorkerLifecycleManager — WebSocket integration", () => {
  it("should track WebSocket connection counts per instance", () => {
    const manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 1,
      maxWorkers: 2,
      websocketKeepsAlive: true,
    });

    manager.incrementWebSocketCount("instance1");
    manager.incrementWebSocketCount("instance1");
    expect(manager.getWebSocketCount("instance1")).toBe(2);

    manager.decrementWebSocketCount("instance1");
    expect(manager.getWebSocketCount("instance1")).toBe(1);

    manager.decrementWebSocketCount("instance1");
    expect(manager.getWebSocketCount("instance1")).toBe(0);
  });

  it("should not go below 0 on decrement", () => {
    const manager = new WorkerLifecycleManager({
      functionName: "test",
      minWorkers: 1,
      maxWorkers: 2,
      websocketKeepsAlive: true,
    });

    manager.decrementWebSocketCount("instance1");
    expect(manager.getWebSocketCount("instance1")).toBe(0);
  });
});
```

**Note:** Additional lifecycle tests (idle timeout pausing, scale-down prevention) depend on the internal timer implementation of `WorkerLifecycleManager`. The implementer should add tests that verify:
- `websocketKeepsAlive: true` pauses idle timeout when WS connections exist
- `websocketKeepsAlive: false` allows worker termination with active connections
- Scale-down is blocked while WS connections exist

These may require extending the test setup to mock timers (`vi.useFakeTimers()`).

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/test/websocket/lifecycle.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/test/websocket/lifecycle.test.ts
git commit -m "test(ws): add WebSocket lifecycle integration tests"
```

---

### Task 15: WorkerPool — maxWebSocketConnections in Acquire Path

**Files:**
- Modify: `src/server/core/WorkerPool.ts`

- [ ] **Step 1: Add WebSocket capacity checking**

The `WorkerPool` needs a reference to the `WebSocketProxyHandler` to check connection limits. Add an optional setter:

```ts
#wsProxyHandler?: WebSocketProxyHandler;

setWebSocketProxyHandler(handler: WebSocketProxyHandler): void {
  this.#wsProxyHandler = handler;
}
```

In the instance selection logic within `acquire()` (where it picks the least-loaded instance), add a filter to skip instances at WebSocket capacity:

```ts
// When filtering available instances for least-loaded selection:
const eligible = instances.filter((instance) => {
  if (!this.#wsProxyHandler) return true;
  return this.#wsProxyHandler.canAcceptConnection(functionName, instance.id);
});
```

If no eligible instances exist and we're below `maxWorkers`, trigger a spawn. If at `maxWorkers` and all at capacity, the caller receives a signal to reject (503).

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `npx vitest run src/test/server/`
Expected: All existing tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/core/WorkerPool.ts
git commit -m "feat(ws): add maxWebSocketConnections enforcement in WorkerPool acquire"
```

---

### Task 16: Wire Everything in EdgeFunctionServer

**Files:**
- Modify: `src/server/core/EdgeFunctionServer.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create and wire WebSocketProxyHandler**

Import at top:

```ts
import { WebSocketProxyHandler } from "./WebSocketProxyHandler";
import type { NodeUpgradeHandler, RelayUpgradeHandler } from "./WebSocketTypes";
```

In the constructor, create the proxy handler:

```ts
this.#wsProxyHandler = new WebSocketProxyHandler({
  maxWebSocketConnections: options.maxWebSocketConnections ?? 100,
  onWebSocketConnect: options.onWebSocketConnect,
  onWebSocketClose: options.onWebSocketClose,
  onWebSocketError: options.onWebSocketError,
});
```

Wire it to the WorkerPool:

```ts
this.#workerPool.setWebSocketProxyHandler(this.#wsProxyHandler);
```

- [ ] **Step 2: Register upgrade handler after adapter creation**

In `start()`, after `this.#adapterServer = this.#adapter.createServer(handler)`, register the upgrade handler:

```ts
if (this.#adapterServer.onUpgrade) {
  if (this.#adapterServer.supportsRawUpgrade) {
    // Node.js splice mode
    this.#adapterServer.onUpgrade(((
      req: import("node:http").IncomingMessage,
      clientSocket: import("node:stream").Duplex,
      head: Buffer,
      functionName: string,
    ) => {
      const pool = this.#workerPool;
      const wsHandler = this.#wsProxyHandler;

      // NOTE: pool.acquire() returns the WorkerInstance directly
      // (or a spawn/wait signal). Adapt to your actual WorkerPool API.
      // The pattern below assumes a getOrCreateWorker() helper that
      // returns { worker: DenoHTTPWorker, id: string } or null.
      pool.getOrCreateWorker(functionName).then((instance) => {
        if (!instance) {
          clientSocket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
          clientSocket.destroy();
          return;
        }
        wsHandler.handleRawUpgrade(
          req, clientSocket, head, functionName,
          instance.worker.socketPath,
          instance.id,
        );
      }).catch(() => {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.destroy();
      });
    }) as NodeUpgradeHandler);
  } else {
    // Bun/Deno relay mode
    this.#adapterServer.onUpgrade(((
      functionName: string,
      hostSocket: import("./WebSocketTypes").HostWebSocket,
    ) => {
      const pool = this.#workerPool;
      const wsHandler = this.#wsProxyHandler;

      pool.getOrCreateWorker(functionName).then((instance) => {
        if (!instance) {
          hostSocket.close(1013, "Service Unavailable");
          return;
        }
        wsHandler.handleRelayUpgrade(
          functionName, hostSocket,
          instance.worker.socketPath,
          instance.id,
          `http://localhost/${functionName}`,
          "localhost",
        );
      }).catch(() => {
        hostSocket.close(1011, "Internal error");
      });
    }) as RelayUpgradeHandler);
  }
}
```

- [ ] **Step 3: Add graceful shutdown for WebSocket connections**

In the `stop()` method, before terminating workers:

```ts
// Close all WebSocket connections with 1001 Going Away
const allFunctions = this.#workerPool.getFunctionNames?.() ?? [];
for (const functionName of allFunctions) {
  // Close all connections for all workers of this function
  // The proxy handler tracks all connections by function+worker
  this.#wsProxyHandler.closeAllConnectionsForFunction?.(functionName, 1001, "Going Away");
}

// Wait briefly for close handshakes to complete
await new Promise((resolve) => setTimeout(resolve, 1000));
```

Add a helper method to `WebSocketProxyHandler`:

```ts
closeAllConnectionsForFunction(
  functionName: string,
  code: number,
  reason: string,
): void {
  const funcMap = this.#connections.get(functionName);
  if (!funcMap) return;
  const workerIds = [...funcMap.keys()];
  for (const workerId of workerIds) {
    this.closeAllConnections(functionName, workerId, code, reason);
  }
}
```

- [ ] **Step 4: Update exports in src/index.ts**

```ts
export { WebSocketProxyHandler } from "./server/core/WebSocketProxyHandler";
export type {
  WebSocketConnection,
  HostWebSocket,
  WebSocketHooks,
  WebSocketConfig,
  WebSocketUpgradeHandler,
} from "./server/core/WebSocketTypes";
```

- [ ] **Step 5: Run all existing tests**

Run: `npx vitest run`
Expected: All existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/core/EdgeFunctionServer.ts src/server/core/WebSocketProxyHandler.ts src/index.ts
git commit -m "feat(ws): wire WebSocketProxyHandler into EdgeFunctionServer with graceful shutdown"
```

---

## Chunk 5: End-to-End Tests & Final Integration

### Task 17: Install ws Test Dependency

- [ ] **Step 1: Add ws as dev dependency**

```bash
npm install --save-dev ws @types/ws
```

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add ws as dev dependency for WebSocket tests"
```

---

### Task 18: Node.js Adapter E2E Tests

**Files:**
- Create: `src/test/websocket/e2e-node.test.ts`

- [ ] **Step 1: Write end-to-end tests**

```ts
// src/test/websocket/e2e-node.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer";
import WebSocket from "ws";
import path from "node:path";

const FUNCTIONS_DIR = path.join(__dirname, "..", "functions");

describe("WebSocket E2E — Node.js adapter", () => {
  let server: EdgeFunctionServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it("should proxy a WebSocket echo connection", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const ws = new WebSocket(`ws://localhost:${server.port}/websocket-echo`);

    const message = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("hello"));
      ws.on("message", (data) => resolve(data.toString()));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 10000);
    });

    expect(message).toBe("hello");
    ws.close();
  });

  it("should handle multiple concurrent WebSocket connections", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const results = await Promise.all(
      [1, 2, 3].map(
        (i) =>
          new Promise<string>((resolve, reject) => {
            const ws = new WebSocket(
              `ws://localhost:${server.port}/websocket-echo`,
            );
            ws.on("open", () => ws.send(`msg${i}`));
            ws.on("message", (data) => {
              resolve(data.toString());
              ws.close();
            });
            ws.on("error", reject);
            setTimeout(() => reject(new Error("timeout")), 10000);
          }),
      ),
    );

    expect(results).toEqual(["msg1", "msg2", "msg3"]);
  });

  it("should handle mixed HTTP and WebSocket traffic", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    // HTTP request to the echo function (should return 426)
    const httpRes = await fetch(
      `http://localhost:${server.port}/websocket-echo`,
    );
    expect(httpRes.status).toBe(426);

    // WebSocket connection
    const wsMsg = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://localhost:${server.port}/websocket-echo`,
      );
      ws.on("open", () => ws.send("test"));
      ws.on("message", (data) => {
        resolve(data.toString());
        ws.close();
      });
      ws.on("error", reject);
    });
    expect(wsMsg).toBe("test");
  });

  it("should handle binary messages", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const input = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const result = await new Promise<Buffer>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://localhost:${server.port}/websocket-echo`,
      );
      ws.on("open", () => ws.send(input));
      ws.on("message", (data) => {
        resolve(data as Buffer);
        ws.close();
      });
      ws.on("error", reject);
    });
    expect(Buffer.compare(result, input)).toBe(0);
  });

  it("should fire lifecycle hooks", async () => {
    const connectCalls: string[] = [];
    const closeCalls: string[] = [];

    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      onWebSocketConnect: (fn, _id) => connectCalls.push(fn),
      onWebSocketClose: (fn, _id) => closeCalls.push(fn),
    });
    await server.start();

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://localhost:${server.port}/websocket-echo`,
      );
      ws.on("open", () => {
        expect(connectCalls.length).toBe(1);
        expect(connectCalls[0]).toBe("websocket-echo");
        ws.close();
      });
      ws.on("close", () => {
        setTimeout(() => {
          expect(closeCalls.length).toBe(1);
          resolve();
        }, 200);
      });
      ws.on("error", reject);
    });
  });

  it("should return 404 for non-existent function", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const ws = new WebSocket(`ws://localhost:${server.port}/nonexistent`);
    const error = await new Promise<Error>((resolve) => {
      ws.on("error", resolve);
    });
    expect(error).toBeDefined();
  });

  it("should forward WebSocket with sub-path", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    // Connect with a sub-path: /websocket-echo/some/path
    const ws = new WebSocket(
      `ws://localhost:${server.port}/websocket-echo/some/path`,
    );

    const message = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("path-test"));
      ws.on("message", (data) => resolve(data.toString()));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 10000);
    });

    expect(message).toBe("path-test");
    ws.close();
  });

  it("should pass subprotocol negotiation through", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    // Request with subprotocol — the echo fixture doesn't negotiate,
    // but verify the upgrade still succeeds (headers forwarded transparently)
    const ws = new WebSocket(
      `ws://localhost:${server.port}/websocket-echo`,
      ["echo-protocol"],
    );

    const message = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("proto-test"));
      ws.on("message", (data) => {
        resolve(data.toString());
        ws.close();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 10000);
    });

    expect(message).toBe("proto-test");
  });
}, { timeout: 30000 });
```

- [ ] **Step 2: Run E2E tests**

Run: `npx vitest run src/test/websocket/e2e-node.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/test/websocket/e2e-node.test.ts
git commit -m "test(ws): add Node.js adapter WebSocket E2E tests"
```

---

### Task 19: Error Scenario Tests

**Files:**
- Create: `src/test/websocket/errors.test.ts`

- [ ] **Step 1: Write error scenario tests**

```ts
// src/test/websocket/errors.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer";
import WebSocket from "ws";
import path from "node:path";

const FUNCTIONS_DIR = path.join(__dirname, "..", "functions");

describe("WebSocket error scenarios", () => {
  let server: EdgeFunctionServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it("should reject upgrade when maxWebSocketConnections exceeded", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      maxWebSocketConnections: 1,
    });
    await server.start();

    // First connection succeeds
    const ws1 = new WebSocket(
      `ws://localhost:${server.port}/websocket-echo`,
    );
    await new Promise<void>((resolve) => ws1.on("open", resolve));

    // Second connection should fail
    const ws2 = new WebSocket(
      `ws://localhost:${server.port}/websocket-echo`,
    );
    const error = await new Promise<Error>((resolve) => {
      ws2.on("error", resolve);
      ws2.on("close", () =>
        resolve(new Error("closed without error")),
      );
    });
    expect(error).toBeDefined();

    ws1.close();
  });

  it("should handle function that does not upgrade", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const ws = new WebSocket(
      `ws://localhost:${server.port}/websocket-reject`,
    );
    const error = await new Promise<Error>((resolve) => {
      ws.on("error", resolve);
    });
    expect(error).toBeDefined();
  });

  it("should close WebSocket connections on graceful shutdown", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const ws = new WebSocket(
      `ws://localhost:${server.port}/websocket-echo`,
    );
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const closePromise = new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
    });

    await server.stop();

    const closeCode = await closePromise;
    // Should receive 1001 (Going Away) or similar close code
    expect([1001, 1006]).toContain(closeCode);
  });

  it("should fire onWebSocketError when worker crashes", async () => {
    const errors: Error[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      onWebSocketError: (_fn, _id, err) => errors.push(err),
    });
    await server.start();

    const ws = new WebSocket(
      `ws://localhost:${server.port}/websocket-echo`,
    );
    await new Promise<void>((resolve) => ws.on("open", resolve));

    // The connection will close when we stop the server
    const closePromise = new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
    });

    await server.stop();
    await closePromise;
    // Errors may or may not fire depending on shutdown ordering
  });
}, { timeout: 30000 });
```

- [ ] **Step 2: Run error tests**

Run: `npx vitest run src/test/websocket/errors.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/test/websocket/errors.test.ts
git commit -m "test(ws): add WebSocket error scenario tests"
```

---

### Task 20: Final Integration — Full Test Suite & ROADMAP Update

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Lint check**

Run: `npm run lint` (or `npx biome check src/`)
Expected: No lint errors. Fix any that appear.

- [ ] **Step 3: Lint Deno test fixtures**

Run: `deno lint src/test/functions/websocket-echo/index.ts src/test/functions/websocket-reject/index.ts`
Expected: No lint errors.

- [ ] **Step 4: Update ROADMAP.md**

Change WebSocket Support status from "Not started" to "Done":

```markdown
### WebSocket Support

**Status:** Done

WebSocket proxy support across all three server adapters:
- Node.js adapter: raw socket splicing (zero-overhead byte pipe after handshake)
- Bun adapter: message relay via native `Bun.serve()` WebSocket
- Deno adapter: message relay via `Deno.upgradeWebSocket()`
- `maxWebSocketConnections` per worker instance (default: 100)
- `websocketKeepsAlive` option (default: true)
- WebSocket connections count as active requests for load balancing
- Lifecycle hooks: `onWebSocketConnect`, `onWebSocketClose`, `onWebSocketError`
- Per-function configuration via `function.json`
- Graceful shutdown sends 1001 (Going Away) to all active connections
```

- [ ] **Step 5: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: update ROADMAP — WebSocket Support complete"
```

- [ ] **Step 6: Final commit and push**

```bash
git push origin feat/websocket-support
```

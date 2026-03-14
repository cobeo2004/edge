import { randomUUID } from "node:crypto";
import net from "node:net";
import type http from "node:http";
import type { Duplex } from "node:stream";
import type { HostWebSocket, WebSocketHooks } from "./WebSocketTypes.js";
import {
  parseFrame,
  writeFrame,
  WebSocketOpcode,
  buildClosePayload,
  parseClosePayload,
  type WebSocketFrame,
} from "./WebSocketFrameCodec.js";

export interface WebSocketProxyHandlerOptions extends WebSocketHooks {
  maxWebSocketConnections: number;
}

export class WebSocketProxyHandler {
  readonly #options: WebSocketProxyHandlerOptions;
  // functionName -> workerInstanceId -> Set<connectionId>
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
    connectionId: string
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
    code = 1005,
    reason = ""
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
    reason: string
  ): void {
    const funcMap = this.#connections.get(functionName);
    if (!funcMap) return;
    const workerSet = funcMap.get(workerInstanceId);
    if (!workerSet) return;
    for (const connId of [...workerSet]) {
      this.removeConnection(
        functionName,
        workerInstanceId,
        connId,
        code,
        reason
      );
    }
  }

  closeAllConnectionsForFunction(
    functionName: string,
    code: number,
    reason: string
  ): void {
    const funcMap = this.#connections.get(functionName);
    if (!funcMap) return;
    for (const workerId of [...funcMap.keys()]) {
      this.closeAllConnections(functionName, workerId, code, reason);
    }
  }

  getConnectionCount(functionName: string, workerInstanceId: string): number {
    return (
      this.#connections.get(functionName)?.get(workerInstanceId)?.size ?? 0
    );
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

  async upgradeToWorker(
    socketPath: string,
    originalUrl: string,
    originalHost: string,
    headers: Record<string, string>
  ): Promise<{
    workerSocket: net.Socket;
    responseHead: Buffer;
    responseHeaders: Record<string, string>;
  }> {
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
        socket.write(`${headerLines.join("\r\n")}\r\n\r\n`);
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
        // Parse response headers from the worker so they can be forwarded
        const responseHeaders: Record<string, string> = {};
        const lines = headerStr.split("\r\n");
        for (let i = 1; i < lines.length; i++) {
          const colonIdx = lines[i]?.indexOf(":") ?? -1;
          if (colonIdx > 0) {
            const key =
              lines[i]?.substring(0, colonIdx).trim().toLowerCase() ?? "";
            const value = lines[i]?.substring(colonIdx + 1).trim() ?? "";
            responseHeaders[key] = value;
          }
        }
        resolve({
          workerSocket: socket,
          responseHead: remaining,
          responseHeaders,
        });
      };

      socket.on("data", onData);
      socket.on("error", reject);
      socket.setTimeout(10000, () => {
        socket.destroy();
        reject(new Error("Worker upgrade handshake timed out"));
      });
    });
  }

  async handleRawUpgrade(
    req: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
    functionName: string,
    socketPath: string,
    workerInstanceId: string
  ): Promise<void> {
    const connectionId = this.generateConnectionId();

    try {
      const headers: Record<string, string> = {};
      for (const key of [
        "upgrade",
        "connection",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
        "sec-websocket-extensions",
        "origin",
        "x-auth-claims",
      ]) {
        const value = req.headers[key];
        if (typeof value === "string") headers[key] = value;
      }

      const originalUrl = `http://${req.headers.host ?? "localhost"}${
        req.url ?? "/"
      }`;
      const originalHost = req.headers.host ?? "localhost";

      const { workerSocket, responseHead, responseHeaders } =
        await this.upgradeToWorker(
          socketPath,
          originalUrl,
          originalHost,
          headers
        );

      // Forward the worker's actual 101 response headers (including Sec-WebSocket-Accept)
      const headerLines = ["HTTP/1.1 101 Switching Protocols"];
      for (const [key, value] of Object.entries(responseHeaders)) {
        headerLines.push(`${key}: ${value}`);
      }
      // Ensure minimum required headers are present
      if (!responseHeaders.upgrade) headerLines.push("Upgrade: websocket");
      if (!responseHeaders.connection) headerLines.push("Connection: Upgrade");
      clientSocket.write(`${headerLines.join("\r\n")}\r\n\r\n`);

      this.addConnection(functionName, workerInstanceId, connectionId);

      if (head.length > 0) workerSocket.write(head);
      if (responseHead.length > 0) clientSocket.write(responseHead);

      clientSocket.pipe(workerSocket);
      workerSocket.pipe(clientSocket);

      let cleaned = false;
      const cleanup = (code: number, reason: string) => {
        if (cleaned) return;
        cleaned = true;
        this.removeConnection(
          functionName,
          workerInstanceId,
          connectionId,
          code,
          reason
        );
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

  async handleRelayUpgrade(
    functionName: string,
    hostSocket: HostWebSocket,
    socketPath: string,
    workerInstanceId: string,
    originalUrl: string,
    originalHost: string,
    extraHeaders?: Record<string, string>
  ): Promise<void> {
    const connectionId = this.generateConnectionId();

    try {
      const headers: Record<string, string> = {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": Buffer.from(randomUUID()).toString("base64"),
        "sec-websocket-version": "13",
        ...extraHeaders,
      };

      const { workerSocket, responseHead: initialData } =
        await this.upgradeToWorker(
          socketPath,
          originalUrl,
          originalHost,
          headers
        );

      this.addConnection(functionName, workerInstanceId, connectionId);

      let workerBuffer = initialData;
      let cleaned = false;
      let fragmentBuffers: Buffer[] = [];
      let fragmentOpcode: WebSocketOpcode | null = null;

      const cleanup = (code: number, reason: string) => {
        if (cleaned) return;
        cleaned = true;
        this.removeConnection(
          functionName,
          workerInstanceId,
          connectionId,
          code,
          reason
        );
        if (!workerSocket.destroyed) workerSocket.destroy();
      };

      workerSocket.on("data", (chunk: Buffer) => {
        workerBuffer = Buffer.concat([workerBuffer, chunk]);

        let frame: WebSocketFrame | null = null;
        while ((frame = parseFrame(workerBuffer)) !== null) {
          workerBuffer = workerBuffer.subarray(frame.totalLength);

          switch (frame.opcode) {
            case WebSocketOpcode.TEXT:
            case WebSocketOpcode.BINARY:
              if (!frame.fin) {
                fragmentOpcode = frame.opcode;
                fragmentBuffers = [frame.payload];
              } else if (frame.opcode === WebSocketOpcode.TEXT) {
                hostSocket.send(frame.payload.toString());
              } else {
                hostSocket.send(
                  new Uint8Array(
                    frame.payload.buffer,
                    frame.payload.byteOffset,
                    frame.payload.byteLength
                  )
                );
              }
              break;

            case WebSocketOpcode.CONTINUATION:
              fragmentBuffers.push(frame.payload);
              if (frame.fin) {
                const assembled = Buffer.concat(fragmentBuffers);
                if (fragmentOpcode === WebSocketOpcode.TEXT)
                  hostSocket.send(assembled.toString());
                else
                  hostSocket.send(
                    assembled.buffer.slice(
                      assembled.byteOffset,
                      assembled.byteOffset + assembled.byteLength
                    )
                  );
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
              workerSocket.write(
                writeFrame(WebSocketOpcode.PONG, frame.payload)
              );
              break;

            case WebSocketOpcode.PONG:
              break;
          }
        }
      });

      hostSocket.onMessage((data) => {
        if (typeof data === "string")
          workerSocket.write(
            writeFrame(WebSocketOpcode.TEXT, Buffer.from(data))
          );
        else
          workerSocket.write(
            writeFrame(WebSocketOpcode.BINARY, Buffer.from(data))
          );
      });

      hostSocket.onClose((code, reason) => {
        if (!workerSocket.destroyed)
          workerSocket.write(
            writeFrame(WebSocketOpcode.CLOSE, buildClosePayload(code, reason))
          );
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
}

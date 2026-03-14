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

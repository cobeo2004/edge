import type { WebSocketUpgradeHandler } from "../core/WebSocketTypes.js";

export type RequestHandler = (request: Request) => Promise<Response>;

export interface AdapterServer {
  listen(port: number, hostname: string): Promise<void>;
  close(): Promise<void>;
  readonly port: number;
  /** Whether this adapter provides raw socket access for splice mode */
  readonly supportsRawUpgrade?: boolean;
  /** Register a handler for WebSocket upgrade requests */
  onUpgrade?(handler: WebSocketUpgradeHandler): void;
}

export interface ServerAdapter {
  createServer(handler: RequestHandler): AdapterServer;
}

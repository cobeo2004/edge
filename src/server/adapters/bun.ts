import type { ServerAdapter, AdapterServer, RequestHandler } from "./types.js";
import type {
  RelayUpgradeHandler,
  WebSocketUpgradeHandler,
  HostWebSocket,
} from "../core/WebSocketTypes.js";

interface BunServerWebSocket<T = unknown> {
  data: T;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    fetch: (req: Request, server: { upgrade(req: Request, options?: { data?: unknown }): boolean }) => Promise<Response> | Response;
    websocket?: {
      open?: (ws: BunServerWebSocket) => void;
      message?: (ws: BunServerWebSocket, message: string | ArrayBuffer) => void;
      close?: (ws: BunServerWebSocket, code: number, reason: string) => void;
    };
  }): { port: number; stop(closeActiveConnections?: boolean): void };
};

class BunAdapterServer implements AdapterServer {
  readonly supportsRawUpgrade = false as const;
  #handler: RequestHandler;
  #server:
    | { port: number; stop(closeActiveConnections?: boolean): void }
    | undefined;
  #relayHandler?: RelayUpgradeHandler;
  #wsHandlers = new Map<
    unknown,
    {
      messageHandler?: (data: string | ArrayBuffer) => void;
      closeHandler?: (code: number, reason: string) => void;
      errorHandler?: (error: Error) => void;
    }
  >();

  constructor(handler: RequestHandler) {
    this.#handler = handler;
  }

  onUpgrade(handler: WebSocketUpgradeHandler): void {
    this.#relayHandler = handler as RelayUpgradeHandler;
  }

  get port(): number {
    if (!this.#server) throw new Error("Server is not listening");
    return this.#server.port;
  }

  async listen(port: number, hostname: string): Promise<void> {
    this.#server = Bun.serve({
      port,
      hostname,
      fetch: (req, server) => {
        // Detect WebSocket upgrade requests
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
        return this.#handler(req);
      },
      websocket: {
        open: (ws: BunServerWebSocket<{ functionName: string }>) => {
          if (!this.#relayHandler) return;

          const handlers: {
            messageHandler?: (data: string | ArrayBuffer) => void;
            closeHandler?: (code: number, reason: string) => void;
            errorHandler?: (error: Error) => void;
          } = {};
          this.#wsHandlers.set(ws, handlers);

          const hostSocket: HostWebSocket = {
            send(data: string | ArrayBuffer | Uint8Array) {
              ws.send(data);
            },
            close(code?: number, reason?: string) {
              ws.close(code, reason);
            },
            onMessage(handler: (data: string | ArrayBuffer) => void) {
              handlers.messageHandler = handler;
            },
            onClose(handler: (code: number, reason: string) => void) {
              handlers.closeHandler = handler;
            },
            onError(handler: (error: Error) => void) {
              handlers.errorHandler = handler;
            },
          };

          this.#relayHandler(ws.data.functionName, hostSocket);
        },
        message: (ws: BunServerWebSocket, message: string | ArrayBuffer) => {
          const handlers = this.#wsHandlers.get(ws);
          handlers?.messageHandler?.(message);
        },
        close: (ws: BunServerWebSocket, code: number, reason: string) => {
          const handlers = this.#wsHandlers.get(ws);
          handlers?.closeHandler?.(code, reason);
          this.#wsHandlers.delete(ws);
        },
      },
    });
  }

  async close(): Promise<void> {
    this.#wsHandlers.clear();
    this.#server?.stop(true);
    this.#server = undefined;
  }
}

export const bunAdapter: ServerAdapter = {
  createServer(handler: RequestHandler): AdapterServer {
    return new BunAdapterServer(handler);
  },
};

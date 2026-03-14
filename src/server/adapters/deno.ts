import { Buffer } from "node:buffer";
import type { ServerAdapter, AdapterServer, RequestHandler } from "./types.js";
import type {
  RelayUpgradeHandler,
  WebSocketUpgradeHandler,
  HostWebSocket,
} from "../core/WebSocketTypes.js";

declare const Deno: {
  serve(options: {
    port: number;
    hostname: string;
    handler: (req: Request) => Promise<Response>;
    onListen?: (addr: { port: number; hostname: string }) => void;
  }): { addr: { port: number }; shutdown(): Promise<void> };

  serve(
    options: {
      port: number;
      hostname: string;
      onListen?: (addr: { port: number; hostname: string }) => void;
    },
    handler: (req: Request) => Promise<Response>
  ): { addr: { port: number }; shutdown(): Promise<void> };

  upgradeWebSocket(req: Request): {
    socket: {
      readyState: number;
      send(data: string | ArrayBuffer | Uint8Array): void;
      close(code?: number, reason?: string): void;
      onopen: ((ev: Event) => void) | null;
      onmessage: ((ev: MessageEvent) => void) | null;
      onclose: ((ev: CloseEvent) => void) | null;
      onerror: ((ev: Event) => void) | null;
    };
    response: Response;
  };
};

class DenoAdapterServer implements AdapterServer {
  #handler: RequestHandler;
  #server: { addr: { port: number }; shutdown(): Promise<void> } | undefined;
  readonly supportsRawUpgrade = false as const;
  #relayHandler?: RelayUpgradeHandler;
  #authCheck?: (
    request: Request,
    functionName: string
  ) => Promise<
    | { authenticated: true; claims?: Record<string, unknown> }
    | { authenticated: false; response: Response }
  >;

  constructor(handler: RequestHandler) {
    this.#handler = handler;
  }

  onUpgrade(handler: WebSocketUpgradeHandler): void {
    this.#relayHandler = handler as RelayUpgradeHandler;
  }

  setAuthCheck(
    check: (
      request: Request,
      functionName: string
    ) => Promise<
      | { authenticated: true; claims?: Record<string, unknown> }
      | { authenticated: false; response: Response }
    >
  ): void {
    this.#authCheck = check;
  }

  get port(): number {
    if (!this.#server) throw new Error("Server is not listening");
    return this.#server.addr.port;
  }

  async listen(port: number, hostname: string): Promise<void> {
    const buildHostSocket = (socket: any): HostWebSocket => ({
      send: (data) => {
        if (socket.readyState === 1) socket.send(data);
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
    });

    this.#server = Deno.serve(
      { port, hostname, onListen: () => {} },
      async (req) => {
        if (this.#relayHandler && req.headers.get("upgrade") === "websocket") {
          const url = new URL(req.url);
          const functionName = url.pathname.split("/")[1] ?? "";
          if (!functionName) {
            return new Response("Not Found", { status: 404 });
          }

          if (this.#authCheck) {
            const authResult = await this.#authCheck(req, functionName);
            if (!authResult.authenticated) {
              return authResult.response;
            }
            const extraHeaders = authResult.claims
              ? {
                  "x-auth-claims": Buffer.from(
                    JSON.stringify(authResult.claims)
                  ).toString("base64url"),
                }
              : undefined;

            const { socket, response } = Deno.upgradeWebSocket(req);
            const relayHandler = this.#relayHandler;
            const hostSocket = buildHostSocket(socket);
            socket.onopen = () => {
              relayHandler(functionName, hostSocket, extraHeaders);
            };
            return response;
          }

          const { socket, response } = Deno.upgradeWebSocket(req);
          const relayHandler = this.#relayHandler;
          const hostSocket = buildHostSocket(socket);
          socket.onopen = () => {
            relayHandler(functionName, hostSocket);
          };
          return response;
        }

        return this.#handler(req);
      }
    );
  }

  async close(): Promise<void> {
    await this.#server?.shutdown();
    this.#server = undefined;
  }
}

export const denoAdapter: ServerAdapter = {
  createServer(handler: RequestHandler): AdapterServer {
    return new DenoAdapterServer(handler);
  },
};

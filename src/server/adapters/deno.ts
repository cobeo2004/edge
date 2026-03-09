import type { ServerAdapter, AdapterServer, RequestHandler } from "./types.js";

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
};

class DenoAdapterServer implements AdapterServer {
  #handler: RequestHandler;
  #server: { addr: { port: number }; shutdown(): Promise<void> } | undefined;

  constructor(handler: RequestHandler) {
    this.#handler = handler;
  }

  get port(): number {
    if (!this.#server) throw new Error("Server is not listening");
    return this.#server.addr.port;
  }

  async listen(port: number, hostname: string): Promise<void> {
    this.#server = Deno.serve({ port, hostname, onListen: () => {} }, (req) =>
      this.#handler(req)
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

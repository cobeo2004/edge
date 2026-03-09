import type { ServerAdapter, AdapterServer, RequestHandler } from "./types.js";

declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    fetch: (req: Request) => Promise<Response>;
  }): { port: number; stop(closeActiveConnections?: boolean): void };
};

class BunAdapterServer implements AdapterServer {
  #handler: RequestHandler;
  #server:
    | { port: number; stop(closeActiveConnections?: boolean): void }
    | undefined;

  constructor(handler: RequestHandler) {
    this.#handler = handler;
  }

  get port(): number {
    if (!this.#server) throw new Error("Server is not listening");
    return this.#server.port;
  }

  async listen(port: number, hostname: string): Promise<void> {
    this.#server = Bun.serve({
      port,
      hostname,
      fetch: (req) => this.#handler(req),
    });
  }

  async close(): Promise<void> {
    this.#server?.stop(true);
    this.#server = undefined;
  }
}

export const bunAdapter: ServerAdapter = {
  createServer(handler: RequestHandler): AdapterServer {
    return new BunAdapterServer(handler);
  },
};

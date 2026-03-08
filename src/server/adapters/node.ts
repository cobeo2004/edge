import http from "node:http";
import { Readable } from "node:stream";
import type { ServerAdapter, AdapterServer, RequestHandler } from "./types.js";

function toWebRequest(req: http.IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody
    ? (Readable.toWeb(req) as ReadableStream<Uint8Array>)
    : null;

  return new Request(url, {
    method: req.method,
    headers,
    body,
    // @ts-expect-error -- Node 20+ supports duplex on Request init
    duplex: hasBody ? "half" : undefined,
  });
}

async function writeWebResponse(
  res: http.ServerResponse,
  response: Response
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (response.body) {
    const nodeStream = Readable.fromWeb(response.body as any);
    await new Promise<void>((resolve, reject) => {
      nodeStream.pipe(res);
      nodeStream.on("end", resolve);
      nodeStream.on("error", reject);
      res.on("error", reject);
    });
  } else {
    res.end();
  }
}

class NodeAdapterServer implements AdapterServer {
  #server: http.Server;
  #handler: RequestHandler;

  constructor(handler: RequestHandler) {
    this.#handler = handler;
    this.#server = http.createServer((req, res) => {
      const request = toWebRequest(req);
      this.#handler(request)
        .then((response) => writeWebResponse(res, response))
        .catch(() => {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
          }
          res.end(JSON.stringify({ error: "Internal Server Error" }));
        });
    });
  }

  get port(): number {
    const addr = this.#server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Server is not listening");
    }
    return addr.port;
  }

  async listen(port: number, hostname: string): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.listen(port, hostname, resolve);
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

export const nodeAdapter: ServerAdapter = {
  createServer(handler: RequestHandler): AdapterServer {
    return new NodeAdapterServer(handler);
  },
};

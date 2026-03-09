export type RequestHandler = (request: Request) => Promise<Response>;

export interface AdapterServer {
  listen(port: number, hostname: string): Promise<void>;
  close(): Promise<void>;
  readonly port: number;
}

export interface ServerAdapter {
  createServer(handler: RequestHandler): AdapterServer;
}

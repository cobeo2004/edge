import http from "node:http";
import fs from "node:fs/promises";
import type { Readable } from "node:stream";

import type { OnExitListener, MinimalChildProcess } from "./types.js";
import { forceKill } from "./process.js";

export interface DenoHTTPWorker {
  /**
   * Terminate the worker. This kills the process with SIGKILL if it is still
   * running, closes the http2 connection, and deletes the socket file.
   */
  terminate(): void;

  /**
   * Gracefully shuts down the worker process and waits for any unresolved
   * promises to exit.
   */
  shutdown(): void;

  /**
   * request calls http.request but patches the options to work with our
   * connection pool and safely handle rewriting various headers.
   */
  request(
    url: string | URL,
    options: http.RequestOptions,
    callback: (response: http.IncomingMessage) => void
  ): http.ClientRequest;

  get stdout(): Readable;

  get stderr(): Readable;

  /**
   * Adds the given listener for the "exit" event.
   */
  addEventListener(type: "exit", listener: OnExitListener): void;
}

export interface WorkerImplOptions {
  socketFile: string;
  process: MinimalChildProcess;
  stdout: Readable;
  stderr: Readable;
  requestTimeout?: number;
  workerMaxDuration?: number;
}

export class DenoHTTPWorkerImpl {
  #onexitListeners: OnExitListener[];
  #process: MinimalChildProcess;
  #socketFile: string;
  #stderr: Readable;
  #stdout: Readable;
  #terminated = false;
  #agent: http.Agent;
  #requestTimeout?: number;
  #maxDurationTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: WorkerImplOptions) {
    this.#onexitListeners = [];
    this.#process = opts.process;
    this.#socketFile = opts.socketFile;
    this.#stderr = opts.stderr;
    this.#stdout = opts.stdout;
    this.#requestTimeout = opts.requestTimeout;
    this.#agent = new http.Agent({ keepAlive: true });

    if (opts.workerMaxDuration) {
      this.#maxDurationTimer = setTimeout(() => {
        this._terminate();
      }, opts.workerMaxDuration);
    }
  }

  _terminate(code?: number, signal?: string) {
    if (this.#terminated) {
      return;
    }
    this.#terminated = true;
    if (this.#maxDurationTimer) {
      clearTimeout(this.#maxDurationTimer);
      this.#maxDurationTimer = undefined;
    }
    if (this.#process && this.#process.exitCode === null) {
      forceKill(this.#process.pid!);
    }
    this.#agent.destroy();
    fs.rm(this.#socketFile).catch(() => {});
    for (const onexit of this.#onexitListeners) {
      onexit(code ?? 1, signal ?? "");
    }
  }

  terminate() {
    this._terminate();
  }

  shutdown() {
    this.#process.kill("SIGINT");
  }

  request(
    url: string | URL,
    options: http.RequestOptions,
    callback: (response: http.IncomingMessage) => void
  ): http.ClientRequest {
    options.headers = (options.headers || {}) as http.OutgoingHttpHeaders;

    // TODO: ensure these are handled with the correct casing?
    delete options.headers["x-deno-worker-host"];
    delete options.headers["x-deno-worker-connection"];

    // NodeJS will send both the host and the connection headers
    // (https://nodejs.org/api/http.html#new-agentoptions). We don't want these
    // to make it to Deno unless they are explicitly set by the user. So store
    // them to reconstruct on the other size.
    if (options.headers.host) {
      options.headers["X-Deno-Worker-Host"] = options.headers.host;
    }
    if (options.headers.connection) {
      options.headers["X-Deno-Worker-Connection"] = options.headers.connection;
    }

    options.headers = {
      ...options.headers,
      "X-Deno-Worker-URL": typeof url === "string" ? url : url.toString(),
    };
    url = "http://deno";
    options.agent = this.#agent;
    options.socketPath = this.#socketFile;
    const req = http.request(url, options, callback);
    if (this.#requestTimeout) {
      const timeout = this.#requestTimeout;
      req.setTimeout(timeout, () => {
        req.destroy(new Error(`Request timed out after ${timeout}ms`));
      });
    }
    return req;
  }

  // We send this request to Deno so that we get a live connection in the
  // http.Agent and subsequent requests are do not have to wait for a new
  // connection.
  async warmRequest() {
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        "http://deno",
        { agent: this.#agent, socketPath: this.#socketFile },
        (resp) => {
          resp.on("error", reject);
          resp.on("data", () => {});
          resp.on("close", () => {
            resolve();
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  get stdout() {
    return this.#stdout;
  }

  get stderr() {
    return this.#stderr;
  }

  addEventListener(_type: "exit", listener: OnExitListener): void {
    this.#onexitListeners.push(listener as OnExitListener);
  }
}

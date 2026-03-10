import type { DenoHTTPWorker, RequestStats } from "../worker/index.js";
import type { WorkerPool } from "./WorkerPool.js";
import type { Middleware, RequestContext } from "./types.js";

export interface RequestHandlerOptions {
  onFunctionError?: (name: string, error: Error) => void;
  onRequestStats?: (stats: RequestStats) => void;
}

export class RequestHandler {
  #pool: WorkerPool;
  #options: RequestHandlerOptions;

  constructor(pool: WorkerPool, options: RequestHandlerOptions) {
    this.#pool = pool;
    this.#options = options;
  }

  middleware(): Middleware {
    return async (ctx: RequestContext) => {
      const { request, functionName, url } = ctx;

      // Acquire worker
      let worker: DenoHTTPWorker;
      try {
        worker = await this.#pool.getOrCreate(functionName);
      } catch (err) {
        this.#options.onFunctionError?.(functionName, err as Error);
        return new Response(
          JSON.stringify({ error: "Failed to start function worker" }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        );
      }

      // Rewrite URL: strip the function name prefix
      const segments = url.pathname.split("/").filter(Boolean);
      const remainingPath = `/${segments.slice(1).join("/")}`;
      const rewrittenUrl = `${url.protocol}//${url.host}${remainingPath}${url.search}`;

      // Build headers
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      // Always strip x-auth-claims to prevent spoofing from clients
      delete headers["x-auth-claims"];
      if (ctx.authClaims) {
        headers["x-auth-claims"] = Buffer.from(
          JSON.stringify(ctx.authClaims)
        ).toString("base64url");
      }

      // Track request
      const startTime = Date.now();
      this.#pool.incrementRequestCount(functionName);

      return new Promise<Response>((resolve, reject) => {
        const proxyReq = worker.request(
          rewrittenUrl,
          { method: request.method, headers },
          (proxyRes) => {
            const statusCode = proxyRes.statusCode ?? 200;
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(proxyRes.headers)) {
              if (value === undefined) continue;

              const headerName = key.toLowerCase();
              if (Array.isArray(value)) {
                if (headerName === "set-cookie") {
                  for (const v of value) {
                    responseHeaders.append(key, v);
                  }
                } else {
                  responseHeaders.set(key, value.join(", "));
                }
              } else {
                if (headerName === "set-cookie") {
                  responseHeaders.append(key, value);
                } else {
                  responseHeaders.set(key, value);
                }
              }
            }

            let statsEmitted = false;
            const emitStats = (status: number, timedOut: boolean) => {
              if (statsEmitted) return;
              statsEmitted = true;
              this.#emitStats(functionName, startTime, status, timedOut);
            };

            const body = new ReadableStream({
              start(controller) {
                proxyRes.on("data", (chunk: Buffer) =>
                  controller.enqueue(chunk)
                );
                proxyRes.on("end", () => {
                  controller.close();
                  emitStats(statusCode, false);
                });
                proxyRes.on("error", (err) => {
                  emitStats(statusCode, false);
                  controller.error(err);
                });
              },
            });

            resolve(
              new Response(body, {
                status: statusCode,
                headers: responseHeaders,
              })
            );
          }
        );

        proxyReq.on("error", (err) => {
          this.#options.onFunctionError?.(functionName, err);
          const timedOut = (err as any).code === "ERR_REQUEST_TIMEOUT";
          const status = timedOut ? 504 : 502;
          const errorMsg = timedOut
            ? "Request timed out"
            : "Worker request failed";
          this.#emitStats(functionName, startTime, status, timedOut);
          resolve(
            new Response(JSON.stringify({ error: errorMsg }), {
              status,
              headers: { "Content-Type": "application/json" },
            })
          );
        });

        if (request.body) {
          const reader = request.body.getReader();
          const pump = (): void => {
            reader
              .read()
              .then(({ done, value }) => {
                if (done) {
                  proxyReq.end();
                  return;
                }
                proxyReq.write(value);
                pump();
              })
              .catch((err) => {
                proxyReq.destroy(err);
                reject(err);
              });
          };
          pump();
        } else {
          proxyReq.end();
        }
      });
    };
  }

  #emitStats(
    functionName: string,
    startTime: number,
    statusCode: number,
    timedOut: boolean
  ): void {
    if (!this.#options.onRequestStats) return;
    const endTime = Date.now();
    this.#options.onRequestStats({
      functionName,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      statusCode,
      timedOut,
    });
  }
}

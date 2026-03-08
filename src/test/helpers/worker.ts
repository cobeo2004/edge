import fs from "node:fs";
import path from "node:path";
import type { DenoHTTPWorker } from "../../index.js";

export const DEFAULT_HTTP_VAL = `export default async function (req: Request): Promise<Response> {
  return Response.json({ ok: true })
} `;

export const jsonRequest = (
  worker: DenoHTTPWorker,
  url: string,
  opts?: { headers?: { [key: string]: string }; body?: string }
): Promise<any> => {
  return new Promise((resolve, reject) => {
    const req = worker.request(url, opts || {}, (resp) => {
      const body: any[] = [];
      resp.on("error", reject);
      resp.on("data", (chunk) => {
        body.push(chunk);
      });
      resp.on("end", () => {
        resolve(JSON.parse(Buffer.concat(body).toString()));
      });
    });
    req.on("error", reject);
    req.end();
  });
};

export function cleanupSockets(): void {
  fs.readdirSync(".").forEach((file) => {
    if (path.basename(file).endsWith("-deno-http.sock")) {
      fs.rmSync(file);
    }
  });
}

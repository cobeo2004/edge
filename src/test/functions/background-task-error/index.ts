declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

Deno.serve((_req: Request) => {
  EdgeRuntime.waitUntil(Promise.reject(new Error("background task failed")));
  return new Response("accepted");
});

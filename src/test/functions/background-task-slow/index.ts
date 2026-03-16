declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

Deno.serve((_req: Request) => {
  EdgeRuntime.waitUntil(
    new Promise<void>((resolve) => setTimeout(resolve, 60_000)).then(() => {
      console.log("SLOW_TASK_DONE");
    })
  );
  return new Response("accepted");
});

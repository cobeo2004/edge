declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

Deno.serve((req: Request) => {
  const url = new URL(req.url);

  if (url.pathname.endsWith("/background")) {
    EdgeRuntime.waitUntil(
      new Promise<void>((resolve) => setTimeout(resolve, 500)).then(() => {
        console.log("BACKGROUND_TASK_DONE");
      })
    );
    return new Response("accepted");
  }

  return new Response("ok");
});

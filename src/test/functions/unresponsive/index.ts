let blocked = false;

Deno.serve((req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("block") === "true") {
    blocked = true;
    return new Response("blocking");
  }
  if (blocked) {
    // Synchronously block the event loop for 60 seconds
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      // busy-wait
    }
  }
  return new Response("ok");
});

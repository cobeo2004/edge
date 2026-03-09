Deno.serve((req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("oom") === "true") {
    // Allocate memory until OOM
    const arrays: number[][] = [];
    while (true) {
      arrays.push(new Array(1_000_000).fill(0));
    }
  }
  return Response.json({ ok: true });
});

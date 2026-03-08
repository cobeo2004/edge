// Uses the global import map at functions/deno.json
// (no mapped imports needed here, but it still works)

Deno.serve(async (req) => {
  const url = new URL(req.url);
  return Response.json({
    path: url.pathname,
    search: url.search,
    method: req.method,
    headers: Object.fromEntries(req.headers),
    body: await req.text(),
  });
});

Deno.serve(async (req) => {
  const url = new URL(req.url);
  return Response.json({
    path: url.pathname,
    method: req.method,
    headers: Object.fromEntries(req.headers),
    body: await req.text(),
  });
});

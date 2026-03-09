Deno.serve(async (req) => {
  const url = new URL(req.url);
  const delay = parseInt(url.searchParams.get("delay") ?? "5000", 10);
  await new Promise((resolve) => setTimeout(resolve, delay));
  return Response.json({ ok: true, delayed: delay });
});

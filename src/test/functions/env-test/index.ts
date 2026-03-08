Deno.serve((req) => {
  const url = new URL(req.url);
  const varName = url.searchParams.get("var") ?? "";
  const value = Deno.env.get(varName) ?? "";
  return new Response(JSON.stringify({ [varName]: value }), {
    headers: { "Content-Type": "application/json" },
  });
});

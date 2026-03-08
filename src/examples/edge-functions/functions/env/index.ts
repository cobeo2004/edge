Deno.serve((req) => {
  const url = new URL(req.url);
  const varName = url.searchParams.get("var");
  if (!varName) {
    return Response.json(
      { error: "var parameter is required" },
      { status: 400 },
    );
  }
  const value = Deno.env.get(varName);
  if (!value) {
    return Response.json(
      { error: `var ${varName} not found` },
      { status: 404 },
    );
  }
  return Response.json({
    var: varName,
    value,
  });
});

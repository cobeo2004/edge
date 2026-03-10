Deno.serve((req) => {
  const claims = req.headers.get("x-auth-claims");
  const user = claims ? JSON.parse(claims) : null;
  return Response.json({
    message: "Admin area",
    user,
    env: {
      ADMIN_SECRET: Deno.env.get("ADMIN_SECRET") ?? "(not set)",
    },
  });
});

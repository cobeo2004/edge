Deno.serve((req) => {
  const claims = req.headers.get("x-auth-claims");
  const user = claims ? JSON.parse(claims) : null;
  return new Response(`Hello, ${user?.sub ?? "anonymous"}!`);
});

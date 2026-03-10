import { withCors } from "_shared/cors.ts";
import { getConnectionString } from "_shared/db/client.ts";

Deno.serve((req) => {
  const url = new URL(req.url);
  if (url.pathname === "/db") {
    return withCors(getConnectionString());
  }
  return withCors("shared works");
});

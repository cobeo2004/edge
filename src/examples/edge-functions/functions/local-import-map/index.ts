// Uses "my-utils/" mapped in the global functions/deno.json
import { greet } from "./utils/greet.ts";
// OR
// import { greet } from "my-utils/greet.ts";

Deno.serve((req) => {
  const url = new URL(req.url);
  const name = url.searchParams.get("name") ?? "world";
  return new Response(greet(name));
});

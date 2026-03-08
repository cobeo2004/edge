import { greet } from "my-utils";
Deno.serve((_req) => new Response(greet("edge")));

import { greet } from "my-utils";
Deno.serve(async (_req) => new Response(greet("edge")));

import { bold } from "jsr:@std/fmt/colors";
Deno.serve(async (_req) => new Response(bold("works")));

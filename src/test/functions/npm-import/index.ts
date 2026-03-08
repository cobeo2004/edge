import { bold } from "jsr:@std/fmt/colors";
Deno.serve((_req) => new Response(bold("works")));

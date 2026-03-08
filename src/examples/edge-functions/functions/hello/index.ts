// Uses the global import map at functions/deno.json
import { bold } from "std/fmt/colors.ts";

Deno.serve((_req) => new Response(bold("Hello from edge function!")));

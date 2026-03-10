Deno.serve((_req) => Response.json({ status: "ok", timestamp: Date.now() }));

Deno.serve((_req) => {
  return new Response("No WebSocket here", { status: 200 });
});

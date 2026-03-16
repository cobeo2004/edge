Deno.serve((req) => {
  if (req.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onmessage = (e) => socket.send(e.data);
    return response;
  }
  return new Response("Not a WebSocket request", { status: 400 });
});

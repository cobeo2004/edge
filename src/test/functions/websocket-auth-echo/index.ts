// base64url decode helper (atob only handles standard base64, not base64url)
function decodeBase64Url(str: string): string {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  return atob(pad ? base64 + "=".repeat(4 - pad) : base64);
}

Deno.serve((req) => {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Not a websocket request", { status: 426 });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  const claims = req.headers.get("x-auth-claims") ?? "";
  socket.onmessage = (e) => {
    socket.send(JSON.stringify({
      message: e.data,
      claims: claims ? JSON.parse(decodeBase64Url(claims)) : null,
    }));
  };
  return response;
});

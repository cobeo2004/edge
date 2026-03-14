const socketFile = Deno.args[0];
const scriptType = Deno.args[1];
const script = Deno.args[2];

// Capture the user's handler from Deno.serve()
let resolveHandler: (
  handler: (req: Request) => Response | Promise<Response>
) => void;
const handlerPromise = new Promise<
  (req: Request) => Response | Promise<Response>
>((resolve) => {
  resolveHandler = resolve;
});

const originalServe = Deno.serve;

// @ts-expect-error: Overriding Deno.serve
Deno.serve = (...args: unknown[]) => {
  let handler: ((req: Request) => Response | Promise<Response>) | undefined;

  if (typeof args[0] === "function") {
    // Deno.serve(handler) or Deno.serve(handler, options)
    handler = args[0] as (req: Request) => Response | Promise<Response>;
  } else if (typeof args[1] === "function") {
    // Deno.serve(options, handler)
    handler = args[1] as (req: Request) => Response | Promise<Response>;
  } else if (args[0] && typeof args[0] === "object" && "handler" in args[0]) {
    // Deno.serve({ handler, ...options })
    handler = (
      args[0] as { handler: (req: Request) => Response | Promise<Response> }
    ).handler;
  }

  if (handler) {
    resolveHandler!(handler);
  }

  // Return a fake server object so user code doesn't crash
  return {
    finished: Promise.resolve(),
    shutdown() {
      return Promise.resolve();
    },
    ref() {},
    unref() {},
    addr: { hostname: "0.0.0.0", port: 0, transport: "tcp" as const },
  };
};

const importURL =
  scriptType === "import"
    ? script
    : `data:text/tsx,${encodeURIComponent(script)}`;

await import(importURL);

const handler = await handlerPromise;

const server = originalServe.call(Deno, {
  path: socketFile,
  onListen: (_localAddr: Deno.NetAddr) => {},
  onError: (error: unknown) => {
    console.error(error);
    return new Response("Internal Server Error", { status: 500 });
  },
  handler: (req: Request) => {
    const headerUrl = req.headers.get("X-Deno-Worker-URL");
    if (!headerUrl) {
      return Response.json({ warming: true }, { status: 200 });
    }

    const isUpgrade = req.headers.get("upgrade") === "websocket";

    if (isUpgrade) {
      // WebSocket upgrade: pass original request directly to preserve
      // internal upgrade state needed by Deno.upgradeWebSocket().
      // We cannot use new Request() (strips upgrade state) or modify
      // headers (immutable on Deno.serve requests). The X-Deno-Worker-*
      // headers will be present but harmless — the user's handler
      // typically only checks the "upgrade" header.
      return handler(req);
    }

    // Non-upgrade: reconstruct Request with correct URL
    const url = new URL(headerUrl);
    req = new Request(url.toString(), req);

    req.headers.delete("host");
    req.headers.delete("connection");
    if (req.headers.has("X-Deno-Worker-Host")) {
      req.headers.set("host", req.headers.get("X-Deno-Worker-Host")!);
    }
    if (req.headers.has("X-Deno-Worker-Connection")) {
      req.headers.set(
        "connection",
        req.headers.get("X-Deno-Worker-Connection")!,
      );
    }

    req.headers.delete("X-Deno-Worker-URL");
    req.headers.delete("X-Deno-Worker-Host");
    req.headers.delete("X-Deno-Worker-Connection");
    return handler(req);
  },
});

addEventListener("error", (e) => {
  console.error(e.error);
  e.preventDefault();
});

addEventListener("unhandledrejection", (e) => {
  console.error(e.reason);
  e.preventDefault();
});

Deno.addSignalListener("SIGINT", async () => {
  await server.shutdown();
});

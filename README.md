# @cobeo2004/edge

[![NPM version](https://img.shields.io/npm/v/@cobeo2004/edge.svg?style=flat)](https://npmjs.org/package/@cobeo2004/edge)

Securely spawn Deno HTTP workers from Node.js, Bun, or Deno over Unix sockets.

> **Forked from [@valtown/deno-http-worker](https://github.com/val-town/deno-http-worker).**
> Full credit to [Val Town](https://val.town) for the original design and implementation.

## Table of Contents

- [Architecture](#architecture)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [EdgeFunctionServer](#edgefunctionserver)
- [Multi-Runtime Server Adapters](#multi-runtime-server-adapters)
- [Environment Variables & Secrets](#environment-variables--secrets)
- [Authentication](#authentication)
- [Permission Profiles](#permission-profiles)
- [Execution Limits](#execution-limits)
- [Configuration](#configuration)
- [Logging](#logging)
- [Shared Folders](#shared-folders)
- [Import Maps](#import-maps)
- [API Reference](#api-reference)
- [License](#license)

## Architecture

```mermaid
flowchart LR
    subgraph Node.js Process
        A[newDenoHTTPWorker] -->|spawns| B[Deno child process]
        A -->|polls for socket| C[Unix Socket]
        A -->|warm request| D[Worker ready]
        D --> E["worker.request()"]
        E -->|"HTTP/1 over Unix socket"| C
    end

    subgraph Deno Process
        C --> F["deno-bootstrap/serve.ts"]
        F -->|intercepts Deno.serve| G[Import user module]
        G --> H["User fetch() handler"]
    end

    style C fill:#f9f,stroke:#333
```

### How communication works

All traffic between Node.js and Deno flows over a **Unix domain socket** using HTTP/1.1 with keep-alive. The bootstrap script rewrites requests using custom headers:

| Header                     | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `X-Deno-Worker-URL`        | Carries the original request URL (since the socket has no hostname) |
| `X-Deno-Worker-Host`       | Preserves the original `Host` header                                |
| `X-Deno-Worker-Connection` | Preserves the original `Connection` header                          |

The Deno-side bootstrap (`deno-bootstrap/serve.ts`) intercepts `Deno.serve()` calls from user code, extracts the handler, and re-serves it on the Unix socket with header rewriting applied.

### EdgeFunctionServer flow

```mermaid
flowchart TD
    A[HTTP Request] --> B[EdgeFunctionServer]
    B -->|"parse /:functionName/*"| C{Function exists?}
    C -->|No| D[404 Not Found]
    C -->|Yes| E[Get or spawn worker]
    E -->|lazy spawn| F[newDenoHTTPWorker]
    F --> G[Proxy request to worker]
    G -->|strip function prefix| H[Deno worker handles request]
    H --> I[Response piped back]
```

## Installation

**Prerequisites:** [Deno](https://deno.com) must be installed and available on `PATH`.

```bash
npm install @cobeo2004/edge
```

## Quick Start

```ts
import { newDenoHTTPWorker } from "@cobeo2004/edge";

const worker = await newDenoHTTPWorker(
  `export default {
    async fetch(req: Request): Promise<Response> {
      return Response.json({ ok: req.url });
    },
  }`,
  { printOutput: true, runFlags: ["--allow-net"] },
);

const body = await new Promise((resolve, reject) => {
  const req = worker.request("https://hello/world?query=param", {}, (resp) => {
    const body: Buffer[] = [];
    resp.on("error", reject);
    resp.on("data", (chunk) => body.push(chunk));
    resp.on("end", () => resolve(Buffer.concat(body).toString()));
  });
  req.end();
});

console.log(body); // => {"ok":"https://hello/world?query=param"}

worker.terminate();
```

You can also pass a `file://` or `https://` URL to load a module instead of inline code:

```ts
const worker = await newDenoHTTPWorker(new URL("file:///path/to/handler.ts"), {
  runFlags: ["--allow-net"],
});
```

## EdgeFunctionServer

`EdgeFunctionServer` is an HTTP server that routes requests to per-function Deno workers. Each subdirectory under `functionsDir` is a separate function, identified by its folder name. Directories starting with `_` are treated as [shared folders](#shared-folders) instead.

```
functions/
├── _shared/          ← shared code, not a function
│   └── utils.ts
├── hello/
│   └── index.ts
└── greet/
    └── index.ts
```

Each function must have an entrypoint file (`index.ts`, `index.tsx`, `index.js`, or `index.mjs`) that calls `Deno.serve()`.

```ts
import { newEdgeFunctionServer } from "@cobeo2004/edge";

const server = newEdgeFunctionServer({
  functionsDir: "/absolute/path/to/functions",
  port: 3000,
  eagerSpawn: true, // spawn all workers at startup
  hotReload: true, // watch for file changes & restart workers
  workerOptions: {
    runFlags: ["--allow-net", "--allow-env"],
  },
  onFunctionReady: (name) => console.log(`${name} is ready`),
  onFunctionError: (name, err) => console.error(`${name} error:`, err),
});

await server.start();

// Requests are routed by the first path segment:
// GET http://localhost:3000/hello/world  → hello function, path: /world
// GET http://localhost:3000/greet        → greet function, path: /

// Graceful shutdown
await server.stop();
```

## Multi-Runtime Server Adapters

`EdgeFunctionServer` uses a pluggable adapter system for the host-facing HTTP server. By default, it auto-detects the runtime and selects the appropriate adapter:

- **Node.js** — `node:http` with web standard `Request`/`Response` conversion
- **Bun** — native `Bun.serve()`
- **Deno** — native `Deno.serve()`

You can explicitly set the adapter:

```ts
const server = newEdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,
  adapter: "bun", // or "node", "deno"
});
```

Or provide a custom adapter implementing the `ServerAdapter` interface:

```ts
import type {
  ServerAdapter,
  AdapterServer,
  WorkerRequestHandler,
} from "@cobeo2004/edge";

const myAdapter: ServerAdapter = {
  createServer(handler: WorkerRequestHandler): AdapterServer {
    // Return an object with listen(), close(), and port
  },
};

const server = newEdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,
  adapter: myAdapter,
});
```

> **Note:** Only the host-facing HTTP server is adapted. Worker communication (`worker.request()`) always uses `node:http` over Unix sockets — all three runtimes support this via Node.js compatibility layers.

## Environment Variables & Secrets

`EdgeFunctionServer` automatically loads `.env` files and supports programmatic env var injection with secret masking in logs.

### `.env` file loading

Place `.env` files in your functions directory for automatic loading:

```
functions/
├── .env              ← global, applied to all workers
├── hello/
│   └── index.ts
└── greet/
    ├── .env          ← per-function, applied only to greet
    └── index.ts
```

### Precedence (lowest → highest)

1. `process.env` (host environment)
2. Global `.env` at `functionsDir/.env`
3. Additional `envFiles` (array order)
4. `EdgeFunctionServerOptions.env` (programmatic)
5. Per-function `.env` at `functionsDir/<name>/.env`
6. `workerOptions.env` (programmatic per-worker)

### Server-level env options

```ts
const server = newEdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,
  env: { API_KEY: "my-key" }, // applied to all workers
  envFiles: ["/path/to/extra.env"], // additional .env files
  maskSecrets: true, // mask env values in logs (default: true)
});
```

### Worker-level env option

```ts
const worker = await newDenoHTTPWorker(script, {
  runFlags: ["--allow-net", "--allow-env"],
  env: { MY_VAR: "value" }, // merged on top of process.env
});
```

### Secret masking

When `maskSecrets` is enabled (the default), environment variables whose keys contain `SECRET`, `KEY`, `TOKEN`, `PASSWORD`, `CREDENTIAL`, `AUTH`, or `PRIVATE` are automatically masked in log output by replacing their values with `***`. Values shorter than 3 characters are not masked. Disable with `maskSecrets: false`.

### Standalone utilities

The `.env` parser and secret masker are exported for direct use:

```ts
import { parseEnvFile, loadEnvFile, createSecretMasker } from "@cobeo2004/edge";

const vars = parseEnvFile('KEY="value"\n# comment\nFOO=bar');
// { KEY: "value", FOO: "bar" }

const vars2 = await loadEnvFile("/path/to/.env"); // {} on ENOENT

const mask = createSecretMasker(["my-secret-key"]);
mask("token is my-secret-key"); // "token is ***"
```

## Authentication

`EdgeFunctionServer` supports pluggable authentication via the `AuthStrategy` interface. Authentication is opt-in — when no `auth` option is set, all requests pass through as before.

### Built-in JWT Strategy

The library ships a `JWTStrategy` powered by [`jose`](https://github.com/panva/jose) with full algorithm support (HMAC, RSA, EC) and JWKS endpoint verification.

```ts
import { EdgeFunctionServer, JWTStrategy } from "@cobeo2004/edge";

const server = new EdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,
  auth: new JWTStrategy({
    secret: process.env.JWT_SECRET!, // HMAC shared secret
    issuer: "my-app", // validate iss claim (optional)
    audience: "api", // validate aud claim (optional)
  }),
});
```

`JWTStrategy` options:

| Option           | Type                              | Description                                                 |
| ---------------- | --------------------------------- | ----------------------------------------------------------- |
| `secret`         | `string`                          | HMAC shared secret                                          |
| `key`            | `CryptoKey \| Uint8Array`         | RSA/EC public key for direct verification                   |
| `jwksEndpoint`   | `string`                          | JWKS URL for remote key fetching                            |
| `algorithms`     | `string[]`                        | Accepted algorithms (default: inferred)                     |
| `issuer`         | `string`                          | Expected `iss` claim                                        |
| `audience`       | `string \| string[]`              | Expected `aud` claim                                        |
| `clockTolerance` | `number`                          | Clock tolerance in seconds (default: `0`)                   |
| `tokenLocation`  | `"header" \| "cookie" \| "query"` | Where to extract the token (default: `"header"`)            |
| `tokenKey`       | `string`                          | Header/cookie/query param name (default: `"authorization"`) |

JWKS example (for Auth0, Supabase, Firebase, etc.):

```ts
auth: new JWTStrategy({
  jwksEndpoint: "https://your-tenant.auth0.com/.well-known/jwks.json",
  audience: "https://api.example.com",
}),
```

### Custom auth strategy

Implement the `AuthStrategy` interface for any auth mechanism (API keys, OAuth introspection, etc.):

```ts
import type { AuthStrategy, AuthResult } from "@cobeo2004/edge";

const apiKeyAuth: AuthStrategy = {
  extractCredentials(request: Request) {
    return Promise.resolve(request.headers.get("x-api-key"));
  },
  verify(credentials: string) {
    if (credentials === process.env.API_KEY) {
      return Promise.resolve({ valid: true, claims: { role: "service" } });
    }
    return Promise.resolve({ valid: false, error: "Invalid API key" });
  },
};

const server = new EdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,
  auth: apiKeyAuth,
});
```

### Auth claims forwarding

When authentication succeeds, decoded claims are forwarded to the worker via the `X-Auth-Claims` header as a **base64url-encoded** JSON string. Inside your Deno function:

```ts
Deno.serve((req) => {
  const raw = req.headers.get("x-auth-claims") ?? "";
  const claims = raw ? JSON.parse(atob(raw)) : {};
  return Response.json({ user: claims.sub, role: claims.role });
});
```

> **Note:** The header is always stripped from incoming requests to prevent spoofing. It is only set by the server when authentication succeeds with claims.

### Public functions (auth opt-out)

Functions can skip authentication in two ways:

1. **Server-level:** list function names in `publicFunctions`:

```ts
const server = new EdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,
  auth: new JWTStrategy({ secret: "..." }),
  publicFunctions: ["health", "docs"],
});
```

2. **Per-function:** add a `function.json` in the function's directory:

```json
{ "auth": false }
```

### Custom auth failure response

Override the default 401 response with `onAuthFailure`:

```ts
const server = new EdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,
  auth: new JWTStrategy({ secret: "..." }),
  onAuthFailure: (request, result) =>
    new Response(JSON.stringify({ error: result.error }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }),
});
```

## Permission Profiles

Control Deno permission flags per function using named profiles instead of manually specifying `runFlags`.

### Built-in profiles

| Profile      | Flags                     |
| ------------ | ------------------------- |
| `none`       | _(socket access only)_    |
| `strict`     | `--allow-net`             |
| `standard`   | `--allow-net --allow-env` |
| `permissive` | `--allow-all`             |

The default profile is `"standard"`. The factory automatically adds scoped `--allow-read` for socket, script, and import map paths, so `standard` does not include a blanket `--allow-read`.

### Server-level configuration

```ts
const server = new EdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,

  // Default profile for all functions
  defaultPermissionProfile: "strict",

  // Per-function overrides (takes priority over function.json)
  functionPermissions: {
    admin: "standard", // profile name
    compute: ["--allow-net"], // raw flags
  },

  // Custom named profiles
  permissionProfiles: {
    "read-only": ["--allow-net", "--allow-read"],
  },
});
```

### Per-function configuration (`function.json`)

Each function directory can contain a `function.json` that declares its permission profile and auth settings:

```
functions/
├── hello/
│   └── index.ts
├── admin/
│   ├── index.ts
│   └── function.json    ← { "permissions": "standard", "auth": true }
└── public-health/
    ├── index.ts
    └── function.json    ← { "permissions": "strict", "auth": false }
```

### Resolution order (highest priority wins)

1. `functionPermissions[name]` in server options
2. `permissions` in `function.json`
3. `defaultPermissionProfile` in server options
4. Falls back to `"standard"`

If `workerOptions.runFlags` is set explicitly, it takes absolute priority over all profiles.

> **Note:** The factory's automatic `--allow-read` / `--allow-write` augmentation for socket files, import maps, and config files still applies on top of whatever the profile resolves to.

## Execution Limits

Prevent runaway functions from consuming unbounded resources with memory caps, request timeouts, and worker lifetime limits.

### Memory limit

Cap V8 heap memory per worker. When exceeded, the process is OOM-killed and respawns on the next request.

```ts
const worker = await newDenoHTTPWorker(script, {
  memoryLimitMb: 128, // 128 MB heap limit
  runFlags: ["--allow-net"],
});
```

### Per-request timeout

Abort individual requests that take too long without killing the worker. At the server level, timed-out requests return 504.

```ts
const server = newEdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,
  requestTimeout: 30_000, // 30 seconds
});
```

### Worker max duration

Limit the total wall-clock lifetime of a worker. After the duration expires, the worker is terminated and respawns on the next request.

```ts
const server = newEdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,
  workerMaxDuration: 600_000, // 10 minutes
});
```

### Request stats and worker stats

Track per-request timing and per-worker lifecycle metrics:

```ts
import type { RequestStats } from "@cobeo2004/edge";

const server = newEdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,
  requestTimeout: 5000,
  onRequestStats: (stats: RequestStats) => {
    console.log(
      `${stats.functionName}: ${stats.durationMs}ms (${stats.statusCode})`,
    );
    if (stats.timedOut) console.warn("Request timed out!");
  },
});

await server.start();

// After handling some requests:
const stats = server.getWorkerStats("hello");
// { totalRequests: 42, uptimeMs: 120000, restartCount: 1 }
```

### Health checks

Periodically ping workers to detect frozen or deadlocked processes. Unhealthy workers are terminated and immediately respawned.

```ts
const server = newEdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,
  healthCheckInterval: 10_000, // ping every 10 seconds
  healthCheckTimeout: 5_000, // 5 second timeout per ping
  healthCheckMaxFailures: 3, // restart after 3 consecutive failures
  onWorkerUnhealthy: (name, failures) => {
    console.warn(
      `Worker ${name} restarted after ${failures} failed health checks`,
    );
  },
});
```

Health checks are opt-in — they only run when `healthCheckInterval` is set. Options can be set at both the server level and per-worker level (via `workerOptions`), with per-worker values taking precedence.

## Configuration

All options for `newDenoHTTPWorker` are partial (have defaults). Key options:

| Option                     | Type                               | Description                                                                              |
| -------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `runFlags`                 | `string[]`                         | Deno permission flags (e.g. `["--allow-net"]`)                                           |
| `importMapPath`            | `string`                           | Path to an import map JSON file                                                          |
| `configPath`               | `string`                           | Path to a `deno.json` config file                                                        |
| `env`                      | `Record<string, string>`           | Environment variables merged on top of `process.env`                                     |
| `memoryLimitMb`            | `number`                           | V8 heap memory limit in MB (process crashes and respawns on OOM)                         |
| `requestTimeout`           | `number`                           | Per-request timeout in ms (aborts request, worker stays alive)                           |
| `workerMaxDuration`        | `number`                           | Max wall-clock lifetime in ms (worker terminates, respawns on next request)              |
| `denoExecutable`           | `string \| string[]`               | Path to the Deno binary (default: `"deno"`)                                              |
| `logLevel`                 | `LogLevel`                         | Logging verbosity: `"debug"`, `"info"`, `"warn"`, `"error"`, `"silent"` (default)        |
| `onLog`                    | `(level, source, message) => void` | Custom log handler (default: `console.log`/`console.error` with `[deno]` prefix)         |
| `printOutput`              | `boolean`                          | Print Deno stdout/stderr with `[deno]` prefix (legacy, equivalent to `logLevel: "info"`) |
| `printCommandAndArguments` | `boolean`                          | Log the spawned command for debugging (legacy, equivalent to `logLevel: "debug"`)        |
| `spawnOptions`             | `SpawnOptions`                     | Options passed to `child_process.spawn`                                                  |
| `denoBootstrapScriptPath`  | `string`                           | Custom bootstrap script (advanced)                                                       |
| `healthCheckInterval`      | `number`                           | Interval in ms between health-check pings (disabled when not set)                        |
| `healthCheckTimeout`       | `number`                           | Timeout in ms for each health-check ping (default: `5000`)                               |
| `healthCheckMaxFailures`   | `number`                           | Consecutive failures before auto-restart (default: `3`)                                  |

`EdgeFunctionServerOptions` additionally supports:

| Option                     | Type                                                  | Description                                                                                     |
| -------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `functionsDir`             | `string`                                              | Absolute path to the functions directory                                                        |
| `port`                     | `number`                                              | Port to listen on                                                                               |
| `hostname`                 | `string`                                              | Hostname to bind to (default: `"127.0.0.1"`)                                                    |
| `adapter`                  | `RuntimeName \| ServerAdapter`                        | Server adapter: `"node"`, `"bun"`, `"deno"`, or a custom `ServerAdapter` (default: auto-detect) |
| `eagerSpawn`               | `boolean`                                             | Spawn all workers at startup (default: `false`)                                                 |
| `hotReload`                | `boolean`                                             | Watch & restart on file changes (default: `false`)                                              |
| `watchSharedFolders`       | `boolean`                                             | Watch shared folders and restart all workers on change (default: `true`, requires `hotReload`)  |
| `workerOptions`            | `Partial<DenoWorkerOptions>`                          | Options forwarded to each worker                                                                |
| `memoryLimitMb`            | `number`                                              | V8 heap memory limit in MB for all workers                                                      |
| `requestTimeout`           | `number`                                              | Per-request timeout in ms; returns 504 on timeout                                               |
| `workerMaxDuration`        | `number`                                              | Max wall-clock lifetime in ms for each worker                                                   |
| `onRequestStats`           | `(stats: RequestStats) => void`                       | Callback fired after each request with timing and status info                                   |
| `logLevel`                 | `LogLevel`                                            | Log level for all function workers (default: `"silent"`)                                        |
| `onLog`                    | `(functionName, level, source, message) => void`      | Custom log handler with function name context (default: `[deno:${name}]` prefix)                |
| `env`                      | `Record<string, string>`                              | Environment variables applied to all workers                                                    |
| `envFiles`                 | `string[]`                                            | Additional `.env` file paths loaded at startup                                                  |
| `maskSecrets`              | `boolean`                                             | Mask env var values in log output (default: `true`)                                             |
| `healthCheckInterval`      | `number`                                              | Interval in ms between health-check pings (disabled when not set)                               |
| `healthCheckTimeout`       | `number`                                              | Timeout in ms for each health-check ping (default: `5000`)                                      |
| `healthCheckMaxFailures`   | `number`                                              | Consecutive failures before auto-restart (default: `3`)                                         |
| `onWorkerUnhealthy`        | `(name: string, consecutiveFailures: number) => void` | Called when a worker is restarted due to failed health checks                                   |
| `auth`                     | `AuthStrategy`                                        | Pluggable auth strategy (opt-in, disabled by default)                                           |
| `onAuthFailure`            | `(request, error) => Response`                        | Custom response on auth failure (default: 401 JSON)                                             |
| `publicFunctions`          | `string[]`                                            | Functions that skip auth entirely                                                               |
| `defaultPermissionProfile` | `string`                                              | Default permission profile for all functions (default: `"standard"`)                            |
| `functionPermissions`      | `Record<string, string \| string[]>`                  | Per-function permission overrides (priority over function.json)                                 |
| `permissionProfiles`       | `Record<string, string[]>`                            | Custom named permission profiles (merged with built-ins)                                        |

## Logging

Control worker output verbosity with `logLevel` and optionally route logs through a custom `onLog` handler.

### Log levels

| Level      | What is logged                  |
| ---------- | ------------------------------- |
| `"debug"`  | Spawn command + stdout + stderr |
| `"info"`   | stdout + stderr                 |
| `"warn"`   | stderr only                     |
| `"error"`  | Only early-exit/crash output    |
| `"silent"` | Nothing (default)               |

### Custom log handler

```ts
const worker = await newDenoHTTPWorker(script, {
  logLevel: "info",
  onLog: (level, source, message) => {
    // level: "debug" | "info" | "warn" | "error"
    // source: "stdout" | "stderr" | "command"
    myLogger[level](`[worker:${source}] ${message}`);
  },
});
```

### EdgeFunctionServer logging

The server-level `onLog` callback includes the function name so you can distinguish output from different workers:

```ts
const server = newEdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,
  logLevel: "info",
  onLog: (functionName, level, source, message) => {
    console.log(`[${functionName}:${source}] ${message}`);
  },
});
```

### Backward compatibility

The legacy `printOutput` and `printCommandAndArguments` booleans still work. When `logLevel` is not set:

- `printOutput: true` resolves to `logLevel: "info"`
- `printCommandAndArguments: true` resolves to `logLevel: "debug"`

An explicit `logLevel` takes precedence over both booleans.

## Shared Folders

Share code across edge functions using underscore-prefixed folders, following [Supabase's convention](https://supabase.com/docs/guides/functions/development-tips).

### Directory structure

Any folder starting with `_` is treated as a shared folder — it is excluded from function discovery and made available for imports.

```
functions/
├── _shared/
│   ├── cors.ts
│   └── db/
│       └── client.ts
├── _helpers/
│   └── utils.ts
├── hello/
│   └── index.ts
└── greet/
    └── index.ts
```

### Importing shared code

Functions can import shared modules two ways:

```ts
// Bare specifier (via auto-generated import map)
import { corsHeaders } from "_shared/cors.ts";
import { getClient } from "_shared/db/client.ts";

// Relative path (always works in Deno)
import { corsHeaders } from "../_shared/cors.ts";
```

The server automatically generates an import map with entries for all files in shared folders (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.json`), scanned recursively. If you also provide an `importMapPath`, the entries are merged — your import map takes precedence on conflicts.

### Read permissions

Shared folder paths are automatically added to `--allow-read` permissions for each worker, so Deno can access the shared files without granting read access to the entire functions directory.

### Hot-reload

When `hotReload` is enabled, changes to shared files trigger a restart of **all** running workers (since any function may depend on the changed file). This is controlled by the `watchSharedFolders` option:

```ts
const server = newEdgeFunctionServer({
  functionsDir: "/path/to/functions",
  port: 3000,
  hotReload: true,
  watchSharedFolders: true, // default: true (only effective when hotReload is true)
});
```

Set `watchSharedFolders: false` to disable shared folder watching while keeping function-level hot-reload active.

## Import Maps

You can pass an [import map](https://docs.deno.com/runtime/fundamentals/configuration/#an-import-map) to the worker with the `importMapPath` option. The import map file is automatically added to `--allow-read` permissions.

```json
{
  "imports": {
    "lodash/": "https://esm.sh/lodash-es/"
  }
}
```

```ts
const worker = await newDenoHTTPWorker(
  `import capitalize from "lodash/capitalize";
  export default {
    async fetch(req: Request): Promise<Response> {
      return Response.json({ message: capitalize("hello world") });
    },
  }`,
  {
    importMapPath: "./import_map.json",
    runFlags: ["--allow-net"],
  },
);
```

Alternatively, use `configPath` to point to a full `deno.json` which supports `imports`, `nodeModulesDir`, `compilerOptions`, and more.

## API Reference

### Exports

| Export                                | Kind     | Description                                                               |
| ------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `newDenoHTTPWorker(code, options?)`   | Function | Spawn a Deno worker from inline code or a URL                             |
| `newEdgeFunctionServer(options)`      | Function | Create an `EdgeFunctionServer` instance                                   |
| `DenoHTTPWorker`                      | Type     | Worker instance with `request()`, `terminate()`, `shutdown()`             |
| `EdgeFunctionServer`                  | Class    | HTTP server routing to per-function Deno workers                          |
| `DenoWorkerOptions`                   | Type     | Options for `newDenoHTTPWorker`                                           |
| `EdgeFunctionServerOptions`           | Type     | Options for `EdgeFunctionServer`                                          |
| `LogLevel`                            | Type     | `"debug" \| "info" \| "warn" \| "error" \| "silent"`                      |
| `EarlyExitDenoHTTPWorkerError`        | Class    | Error thrown when the Deno process exits unexpectedly                     |
| `MinimalChildProcess`                 | Type     | Interface for the spawned child process                                   |
| `RequestStats`                        | Type     | Per-request stats: timing, status code, timeout flag                      |
| `ServerAdapter`                       | Type     | Adapter interface for pluggable HTTP servers                              |
| `AdapterServer`                       | Type     | Server instance returned by an adapter                                    |
| `WorkerRequestHandler`                | Class    | Middleware for routing requests to per-function Deno workers              |
| `WorkerRequestHandlerOptions`         | Type     | Options for `WorkerRequestHandler`                                        |
| `RuntimeName`                         | Type     | `"node" \| "bun" \| "deno"`                                               |
| `detectRuntime()`                     | Function | Detect current runtime (`"node"`, `"bun"`, or `"deno"`)                   |
| `resolveAdapter(option?)`             | Function | Resolve a `ServerAdapter` from a runtime name or custom adapter           |
| `nodeAdapter`                         | Object   | Built-in Node.js server adapter                                           |
| `parseEnvFile(content)`               | Function | Parse `.env` file content into a key-value record                         |
| `loadEnvFile(path)`                   | Function | Load and parse a `.env` file (returns `{}` on ENOENT)                     |
| `createSecretMasker(secrets)`         | Function | Create a function that masks secret values in strings                     |
| `AuthStrategy`                        | Type     | Pluggable authentication strategy interface                               |
| `AuthResult`                          | Type     | Authentication verification result                                        |
| `JWTStrategy`                         | Class    | Built-in JWT auth strategy (HMAC, RSA, EC, JWKS)                          |
| `JWTStrategyOptions`                  | Type     | Options for `JWTStrategy`                                                 |
| `FunctionConfig`                      | Type     | Per-function configuration from `function.json`                           |
| `BUILT_IN_PROFILES`                   | Object   | Built-in permission profiles (`none`, `strict`, `standard`, `permissive`) |
| `resolvePermissionFlags(value, opts)` | Function | Resolve a profile name or flags array to Deno run flags                   |

## License

MIT

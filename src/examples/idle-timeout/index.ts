import path from "node:path";
import { fileURLToPath } from "node:url";
import { EdgeFunctionServer } from "../../server/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.resolve(__dirname, "functions");

// ---------------------------------------------------------------------------
// Idle Timeout Example — Cold/Warm Worker Lifecycle
//
// Workers boot on first request (cold start) and automatically terminate
// after being idle for the configured duration (warm → cold).
//
// - "hello" uses the server-level idleTimeout of 10 seconds
// - "keep-warm" overrides with a 60-second timeout via function.json
//
// Try it:
//   1. curl http://localhost:3000/hello       → spawns worker (cold start)
//   2. Wait 10+ seconds                       → worker goes cold
//   3. curl http://localhost:3000/hello       → respawns (cold start again)
//   4. curl http://localhost:3000/keep-warm   → stays warm for 60 seconds
// ---------------------------------------------------------------------------

const server = new EdgeFunctionServer({
  functionsDir: FUNCTIONS_DIR,
  port: 3000,
  logLevel: "info",
  workerOptions: {
    runFlags: ["--allow-net", "--allow-env"],
  },

  // Workers terminate after 10 seconds of inactivity (no in-flight requests)
  idleTimeout: 10_000,

  // Lifecycle callbacks
  onFunctionReady: (name) =>
    console.log(`  [warm] "${name}" is ready (cold → warm)`),
  onFunctionCold: (name) =>
    console.log(
      `  [cold] "${name}" terminated due to idle timeout (warm → cold)`
    ),
  onFunctionError: (name, err) =>
    console.error(`  [error] "${name}":`, err.message),
});

await server.start();
console.log("Idle Timeout Example listening on http://127.0.0.1:3000");
console.log("Available functions:", server.listFunctions().join(", "));
console.log(`Server-level idle timeout: ${10_000}ms`);
console.log(`"keep-warm" per-function override: 60000ms (via function.json)`);

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await server.stop();
  process.exit(0);
});

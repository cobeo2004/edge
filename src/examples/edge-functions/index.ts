import path from "node:path";
import { fileURLToPath } from "node:url";
import { EdgeFunctionServer } from "../../server/EdgeFunctionServer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.resolve(__dirname, "functions");

// ---------------------------------------------------------------------------
// EdgeFunctionServer with a global import map (functions/deno.json)
//
// All functions are served through one server. The import map maps:
//   "std/fmt/"   -> deno std library (used by hello)
//   "my-utils/"  -> local utils module (used by local-import-map)
// ---------------------------------------------------------------------------

const server = new EdgeFunctionServer({
  functionsDir: FUNCTIONS_DIR,
  port: 3000,
  configPath: path.join(FUNCTIONS_DIR, "deno.json"),
  logLevel: "debug",
  onLog: (functionName, level, source, message) => {
    console.log(`  [${functionName}] ${level} ${source} ${message}`);
  },
  workerOptions: {
    runFlags: ["--allow-net", "--allow-env", "--allow-read", "--allow-write"],
  },
  onFunctionReady: (name) => console.log(`  Function "${name}" is ready`),
  onFunctionError: (name, err) =>
    console.error(`  Function "${name}" error:`, err.message),
});

await server.start();
console.log("EdgeFunctionServer listening on http://127.0.0.1:3000");
console.log("Available functions:", server.listFunctions().join(", "));

// Keep the server running until interrupted
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await server.stop();
  process.exit(0);
});

import path from "node:path";
import { fileURLToPath } from "node:url";
import { EdgeFunctionServer } from "../../server/EdgeFunctionServer.js";
import { JWTStrategy } from "../../auth/jwt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.resolve(__dirname, "functions");

// ---------------------------------------------------------------------------
// EdgeFunctionServer with JWT auth and permission profiles
//
// Functions:
//   /hello          — requires JWT, reads claims from X-Auth-Claims header
//   /echo           — requires JWT, echoes request details
//   /public-health  — no auth required (function.json: auth: false)
//   /admin          — requires JWT, has "standard" permissions (can read env)
//
// Test with:
//   # Generate a token (requires Node.js with jose installed):
//   node -e "
//     const { SignJWT } = require('jose');
//     new SignJWT({ sub: 'user-1', role: 'admin' })
//       .setProtectedHeader({ alg: 'HS256' })
//       .setExpirationTime('1h')
//       .sign(new TextEncoder().encode('my-super-secret-key-for-testing!!'))
//       .then(t => console.log(t));
//   "
//
//   # Public endpoint (no token needed):
//   curl http://localhost:3001/public-health
//
//   # Authenticated endpoint:
//   curl -H "Authorization: Bearer <token>" http://localhost:3001/hello
//
//   # Without token (returns 401):
//   curl http://localhost:3001/hello
// ---------------------------------------------------------------------------

const JWT_SECRET = "my-super-secret-key-for-testing!!";

const server = new EdgeFunctionServer({
  functionsDir: FUNCTIONS_DIR,
  port: 3001,
  logLevel: "info",

  // --- Authentication ---
  auth: new JWTStrategy({ secret: JWT_SECRET }),

  // Functions that skip auth (server-level override)
  // Note: public-health also has auth: false in function.json
  publicFunctions: [],

  // Custom auth failure response (optional — default is 401 JSON)
  onAuthFailure: (_req, result) =>
    new Response(
      JSON.stringify({
        error: "Authentication required",
        message: result.error,
        hint: "Provide a valid JWT in the Authorization header",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    ),

  // --- Permission Profiles ---
  // Default profile for all functions (when not overridden)
  defaultPermissionProfile: "strict",

  // Per-function permission overrides (takes priority over function.json)
  functionPermissions: {
    echo: "standard", // echo needs more permissions than strict
  },

  // Custom named profiles
  permissionProfiles: {
    "read-only": ["--allow-net", "--allow-read"],
  },

  // --- Lifecycle callbacks ---
  onFunctionReady: (name) => console.log(`  Function "${name}" is ready`),
  onFunctionError: (name, err) =>
    console.error(`  Function "${name}" error:`, err.message),
  onRequestStats: (stats) => {
    console.log(
      `  [stats] ${stats.functionName}: ${stats.durationMs}ms (${stats.statusCode})`
    );
  },
});

await server.start();
console.log("Auth example server listening on http://127.0.0.1:3001");
console.log("Available functions:", server.listFunctions().join(", "));
console.log("\nEndpoints:");
console.log("  GET /public-health  — no auth required");
console.log("  GET /hello          — requires JWT");
console.log("  GET /echo           — requires JWT");
console.log("  GET /admin          — requires JWT");

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await server.stop();
  process.exit(0);
});

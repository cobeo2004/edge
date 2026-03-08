import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.resolve(__dirname, "..");

export const FUNCTIONS_DIR = path.resolve(TEST_DIR, "functions");
export const SERVE_BOOTSTRAP = path.resolve(
  TEST_DIR,
  "../../deno-bootstrap/serve.ts"
);
export const IMPORT_MAP = path.resolve(TEST_DIR, "import_map.json");
export const DENO_CONFIG = path.resolve(TEST_DIR, "deno_config.json");

export const echoFile = path.resolve(TEST_DIR, "echo-request.ts");
export const echoScript = fs.readFileSync(echoFile, { encoding: "utf-8" });

export const vtFile = path.resolve(TEST_DIR, "val-town.ts");
export const vtScript = fs.readFileSync(vtFile, { encoding: "utf-8" });

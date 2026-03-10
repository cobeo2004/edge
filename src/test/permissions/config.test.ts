import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadFunctionConfig } from "../../permissions/config.js";

describe("loadFunctionConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "fn-config-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty config when function.json does not exist", async () => {
    const config = await loadFunctionConfig(tmpDir);
    expect(config).toEqual({});
  });

  it("loads permissions from function.json", async () => {
    await fsp.writeFile(
      path.join(tmpDir, "function.json"),
      JSON.stringify({ permissions: "strict" })
    );
    const config = await loadFunctionConfig(tmpDir);
    expect(config.permissions).toBe("strict");
  });

  it("loads auth from function.json", async () => {
    await fsp.writeFile(
      path.join(tmpDir, "function.json"),
      JSON.stringify({ auth: false })
    );
    const config = await loadFunctionConfig(tmpDir);
    expect(config.auth).toBe(false);
  });

  it("loads both permissions and auth", async () => {
    await fsp.writeFile(
      path.join(tmpDir, "function.json"),
      JSON.stringify({ permissions: ["--allow-net"], auth: false })
    );
    const config = await loadFunctionConfig(tmpDir);
    expect(config.permissions).toEqual(["--allow-net"]);
    expect(config.auth).toBe(false);
  });

  it("returns empty config for invalid JSON", async () => {
    await fsp.writeFile(path.join(tmpDir, "function.json"), "not json");
    const config = await loadFunctionConfig(tmpDir);
    expect(config).toEqual({});
  });
});

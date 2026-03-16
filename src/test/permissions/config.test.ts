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

  it("parses maxWebSocketConnections", async () => {
    await fsp.writeFile(
      path.join(tmpDir, "function.json"),
      JSON.stringify({ maxWebSocketConnections: 50 })
    );
    const config = await loadFunctionConfig(tmpDir);
    expect(config.maxWebSocketConnections).toBe(50);
  });

  it("ignores non-integer maxWebSocketConnections", async () => {
    await fsp.writeFile(
      path.join(tmpDir, "function.json"),
      JSON.stringify({ maxWebSocketConnections: 0.5 })
    );
    const config = await loadFunctionConfig(tmpDir);
    expect(config.maxWebSocketConnections).toBeUndefined();
  });

  it("ignores maxWebSocketConnections < 1", async () => {
    await fsp.writeFile(
      path.join(tmpDir, "function.json"),
      JSON.stringify({ maxWebSocketConnections: 0 })
    );
    const config = await loadFunctionConfig(tmpDir);
    expect(config.maxWebSocketConnections).toBeUndefined();
  });

  it("ignores negative maxWebSocketConnections", async () => {
    await fsp.writeFile(
      path.join(tmpDir, "function.json"),
      JSON.stringify({ maxWebSocketConnections: -1 })
    );
    const config = await loadFunctionConfig(tmpDir);
    expect(config.maxWebSocketConnections).toBeUndefined();
  });

  it("ignores string maxWebSocketConnections", async () => {
    await fsp.writeFile(
      path.join(tmpDir, "function.json"),
      JSON.stringify({ maxWebSocketConnections: "50" })
    );
    const config = await loadFunctionConfig(tmpDir);
    expect(config.maxWebSocketConnections).toBeUndefined();
  });

  it("parses websocketKeepsAlive true", async () => {
    await fsp.writeFile(
      path.join(tmpDir, "function.json"),
      JSON.stringify({ websocketKeepsAlive: true })
    );
    const config = await loadFunctionConfig(tmpDir);
    expect(config.websocketKeepsAlive).toBe(true);
  });

  it("parses websocketKeepsAlive false", async () => {
    await fsp.writeFile(
      path.join(tmpDir, "function.json"),
      JSON.stringify({ websocketKeepsAlive: false })
    );
    const config = await loadFunctionConfig(tmpDir);
    expect(config.websocketKeepsAlive).toBe(false);
  });

  it("ignores non-boolean websocketKeepsAlive", async () => {
    await fsp.writeFile(
      path.join(tmpDir, "function.json"),
      JSON.stringify({ websocketKeepsAlive: "true" })
    );
    const config = await loadFunctionConfig(tmpDir);
    expect(config.websocketKeepsAlive).toBeUndefined();
  });

  it("parses both WebSocket fields together", async () => {
    await fsp.writeFile(
      path.join(tmpDir, "function.json"),
      JSON.stringify({
        maxWebSocketConnections: 25,
        websocketKeepsAlive: false,
      })
    );
    const config = await loadFunctionConfig(tmpDir);
    expect(config.maxWebSocketConnections).toBe(25);
    expect(config.websocketKeepsAlive).toBe(false);
  });

  it("returns empty config for invalid JSON", async () => {
    await fsp.writeFile(path.join(tmpDir, "function.json"), "not json");
    const config = await loadFunctionConfig(tmpDir);
    expect(config).toEqual({});
  });
});

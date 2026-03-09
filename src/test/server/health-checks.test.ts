import { afterEach, describe, expect, it } from "vitest";
import { EdgeFunctionServer } from "../../server/EdgeFunctionServer.js";
import { httpRequest } from "../helpers/http.js";
import { FUNCTIONS_DIR } from "../helpers/fixtures.js";

describe("EdgeFunctionServer – health checks", { timeout: 30_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("healthy worker: no restart, no callback", async () => {
    const unhealthyCalls: { name: string; failures: number }[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      healthCheckInterval: 100,
      healthCheckTimeout: 2000,
      healthCheckMaxFailures: 3,
      onWorkerUnhealthy: (name, failures) =>
        unhealthyCalls.push({ name, failures }),
    });
    await server.start();

    // Trigger worker spawn
    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(200);

    // Let a few health checks run
    await new Promise((r) => setTimeout(r, 500));

    expect(unhealthyCalls).toHaveLength(0);

    // Worker still responds
    const res2 = await httpRequest(server.port, "/hello");
    expect(res2.status).toBe(200);
  });

  it("unhealthy worker triggers onWorkerUnhealthy and respawns", async () => {
    const unhealthyCalls: { name: string; failures: number }[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      healthCheckInterval: 100,
      healthCheckTimeout: 200,
      healthCheckMaxFailures: 2,
      onWorkerUnhealthy: (name, failures) =>
        unhealthyCalls.push({ name, failures }),
    });
    await server.start();

    // Spawn the worker and make it block
    const res = await httpRequest(server.port, "/unresponsive");
    expect(res.status).toBe(200);

    // Trigger the block
    await httpRequest(server.port, "/unresponsive?block=true");

    // Wait for health checks to detect failure and restart
    // 2 failures × 100ms interval + 200ms timeout each = ~600ms, give extra margin
    await new Promise((r) => setTimeout(r, 3000));

    expect(unhealthyCalls.length).toBeGreaterThanOrEqual(1);
    expect(unhealthyCalls[0]!.name).toBe("unresponsive");
    expect(unhealthyCalls[0]!.failures).toBe(2);

    // Worker should have respawned — new requests should work
    const res2 = await httpRequest(server.port, "/unresponsive");
    expect(res2.status).toBe(200);
    expect(res2.body).toBe("ok");
  });

  it("no health checks when healthCheckInterval is not set", async () => {
    const unhealthyCalls: { name: string; failures: number }[] = [];
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      // healthCheckInterval intentionally omitted
      onWorkerUnhealthy: (name, failures) =>
        unhealthyCalls.push({ name, failures }),
    });
    await server.start();

    const res = await httpRequest(server.port, "/hello");
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 300));
    expect(unhealthyCalls).toHaveLength(0);
  });

  it("getWorkerStats shows restart after unhealthy restart", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      healthCheckInterval: 100,
      healthCheckTimeout: 200,
      healthCheckMaxFailures: 2,
    });
    await server.start();

    // Spawn and block
    await httpRequest(server.port, "/unresponsive");
    await httpRequest(server.port, "/unresponsive?block=true");

    // Wait for restart
    await new Promise((r) => setTimeout(r, 3000));

    // Verify it respawned by making a request
    await httpRequest(server.port, "/unresponsive");

    const stats = server.getWorkerStats("unresponsive");
    expect(stats.restartCount).toBeGreaterThanOrEqual(1);
  });
});

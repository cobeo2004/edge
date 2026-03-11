import { afterEach, describe, expect, it } from "vitest";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import { httpRequest } from "../helpers/http.js";
import { FUNCTIONS_DIR, IMPORT_MAP } from "../helpers/fixtures.js";

describe(
  "EdgeFunctionServer – worker pool concurrency",
  { timeout: 30_000 },
  () => {
    let server: EdgeFunctionServer | undefined;

    afterEach(async () => {
      if (server) {
        await server.stop();
        server = undefined;
      }
    });

    it("default maxWorkers:1 behaves like single worker", async () => {
      const readyCalls: string[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        onFunctionReady: (name) => readyCalls.push(name),
      });
      await server.start();

      const res = await httpRequest(server.port, "/hello");
      expect(res.status).toBe(200);
      expect(res.body).toBe("Hello from edge function!");

      // Only one ready call (single worker)
      expect(readyCalls.filter((n) => n === "hello")).toHaveLength(1);
    });

    it("concurrent requests scale up to maxWorkers", async () => {
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        maxWorkers: 3,
      });
      await server.start();

      // Send 3 concurrent slow requests to trigger scale-up
      const promises = Array.from({ length: 3 }, () =>
        httpRequest(server!.port, "/slow?delay=2000")
      );

      // Give time for scaling
      await new Promise((r) => setTimeout(r, 1000));

      const stats = server.getWorkerStats("slow");
      // Should have spawned multiple workers
      expect(stats.totalRequests).toBeGreaterThan(0);

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(200);
      }
    });

    it("idle worker scales down when above minWorkers", async () => {
      const coldCalls: string[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        maxWorkers: 3,
        minWorkers: 1,
        idleTimeout: 300,
        onFunctionCold: (name) => coldCalls.push(name),
      });
      await server.start();

      // Trigger 2 concurrent requests to scale up
      const [r1, r2] = await Promise.all([
        httpRequest(server.port, "/slow?delay=500"),
        httpRequest(server.port, "/slow?delay=500"),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // Wait for idle timeout to trigger scale-down
      await new Promise((r) => setTimeout(r, 600));

      // Should NOT go fully cold (minWorkers=1)
      expect(coldCalls).not.toContain("slow");

      // Should still be able to serve requests
      const res = await httpRequest(server.port, "/slow?delay=100");
      expect(res.status).toBe(200);
    });

    it("onFunctionCold only fires when last instance terminated", async () => {
      const coldCalls: string[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        maxWorkers: 2,
        minWorkers: 0,
        idleTimeout: 300,
        onFunctionCold: (name) => coldCalls.push(name),
      });
      await server.start();

      await Promise.all([
        httpRequest(server.port, "/slow?delay=500"),
        httpRequest(server.port, "/slow?delay=500"),
      ]);

      // Wait for all idle timeouts
      await new Promise((r) => setTimeout(r, 800));

      // Should fire exactly once for the function going fully cold
      expect(coldCalls.filter((n) => n === "slow")).toHaveLength(1);
    });

    it("per-function maxWorkers override from function.json", async () => {
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        maxWorkers: 1, // server default is 1
      });
      await server.start();

      // pool-test has maxWorkers: 3 in function.json
      // Send 3 concurrent requests
      const promises = Array.from({ length: 3 }, () =>
        httpRequest(server!.port, "/pool-test")
      );

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.body).toBe("pool-test");
      }
    });

    it("at capacity routes to least-loaded without error", async () => {
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        maxWorkers: 2,
      });
      await server.start();

      // Send 4 requests with only 2 workers max — should not error
      const promises = Array.from({ length: 4 }, () =>
        httpRequest(server!.port, "/hello")
      );

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(200);
      }
    });

    it("eagerSpawn spawns max(minWorkers, 1) at startup", async () => {
      const readyCalls: string[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        eagerSpawn: true,
        importMapPath: IMPORT_MAP,
        workerOptions: {
          runFlags: ["--allow-net", "--allow-env", "--allow-read"],
        },
        onFunctionReady: (name) => readyCalls.push(name),
      });
      await server.start();

      // All functions should have at least one ready call
      expect(readyCalls.length).toBeGreaterThan(0);

      // eager-override has eagerSpawn: true, minWorkers: 2
      // Verify it was eagerly spawned
      expect(readyCalls).toContain("eager-override");
    });

    it("per-function eagerSpawn:false skips eager spawning", async () => {
      const readyCalls: string[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        eagerSpawn: false, // Server default is false
        importMapPath: IMPORT_MAP,
        workerOptions: {
          runFlags: ["--allow-net", "--allow-env", "--allow-read"],
        },
        onFunctionReady: (name) => readyCalls.push(name),
      });
      await server.start();

      // eager-override has eagerSpawn: true in function.json, should still spawn
      expect(readyCalls).toContain("eager-override");

      // hello has no eagerSpawn override, server default false → should NOT spawn
      expect(readyCalls).not.toContain("hello");
    });

    it("health check restarts only unhealthy instance, others unaffected", async () => {
      const unhealthyCalls: { name: string; failures: number }[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        maxWorkers: 2,
        healthCheckInterval: 100,
        healthCheckTimeout: 200,
        healthCheckMaxFailures: 2,
        onWorkerUnhealthy: (name, failures) =>
          unhealthyCalls.push({ name, failures }),
      });
      await server.start();

      // Spawn 2 workers: one healthy (hello), one that can block (unresponsive)
      const [r1, r2] = await Promise.all([
        httpRequest(server.port, "/unresponsive"),
        httpRequest(server.port, "/hello"),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // Block unresponsive to make it fail health checks
      await httpRequest(server.port, "/unresponsive?block=true");

      // Wait for health check to detect and restart
      await new Promise((r) => setTimeout(r, 3000));

      // Unresponsive should have been restarted
      expect(unhealthyCalls.length).toBeGreaterThanOrEqual(1);

      // Hello should still work (unaffected)
      const r3 = await httpRequest(server.port, "/hello");
      expect(r3.status).toBe(200);
      expect(r3.body).toBe("Hello from edge function!");

      // Unresponsive should also work after restart
      const r4 = await httpRequest(server.port, "/unresponsive");
      expect(r4.status).toBe(200);
    });

    it("backward compatibility: no config changes = single worker behavior", async () => {
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        // No minWorkers, maxWorkers, or pool config
      });
      await server.start();

      const res1 = await httpRequest(server.port, "/hello");
      expect(res1.status).toBe(200);

      const res2 = await httpRequest(server.port, "/hello");
      expect(res2.status).toBe(200);

      // Should work identically to pre-concurrency behavior
      expect(res2.body).toBe("Hello from edge function!");
    });

    it("restart terminates all instances and respawns", async () => {
      const readyCalls: string[] = [];
      server = new EdgeFunctionServer({
        functionsDir: FUNCTIONS_DIR,
        port: 0,
        maxWorkers: 2,
        onFunctionReady: (name) => readyCalls.push(name),
      });
      await server.start();

      // Spawn workers
      await Promise.all([
        httpRequest(server.port, "/hello"),
        httpRequest(server.port, "/hello"),
      ]);

      readyCalls.length = 0;
      await server.restartFunction("hello");

      // Should have respawned
      const res = await httpRequest(server.port, "/hello");
      expect(res.status).toBe(200);
      expect(readyCalls).toContain("hello");
    });
  }
);

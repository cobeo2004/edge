import { describe, it, expect, afterEach, vi } from "vitest";
import { EdgeFunctionServer } from "../../server/core/EdgeFunctionServer.js";
import { httpRequest } from "../helpers/http.js";
import path from "node:path";

const FUNCTIONS_DIR = path.resolve(import.meta.dirname!, "../functions");

describe("Background Tasks - Server", () => {
  let server: EdgeFunctionServer;

  afterEach(async () => {
    await server?.stop();
  });

  it("response returns before background task completes", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const start = Date.now();
    const response = await httpRequest(
      server.port,
      "/background-task/background"
    );
    const elapsed = Date.now() - start;

    expect(response.status).toBe(200);
    expect(response.body).toBe("accepted");
    // Response should return well before the 500ms bg task
    expect(elapsed).toBeLessThan(400);
  }, 10_000);

  it("background task timeout terminates worker", async () => {
    const onCold = vi.fn();
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      backgroundTaskTimeout: 500,
      onFunctionCold: onCold,
    });
    await server.start();

    await httpRequest(server.port, "/background-task-slow/");

    // Wait for timeout to fire (500ms) + buffer
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    expect(onCold).toHaveBeenCalledWith("background-task-slow");
  }, 10_000);

  it("backgroundTaskKeepsAlive prevents idle timeout", async () => {
    const onCold = vi.fn();
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 200,
      backgroundTaskKeepsAlive: true,
      backgroundTaskTimeout: 5000,
      onFunctionCold: onCold,
    });
    await server.start();

    await httpRequest(server.port, "/background-task/background");

    // Idle timeout is 200ms, but bg task (500ms) keeps worker alive
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(onCold).not.toHaveBeenCalled();

    // After bg task completes (500ms), idle timer starts, then fires at +200ms
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    expect(onCold).toHaveBeenCalledWith("background-task");
  }, 10_000);

  it("backgroundTaskKeepsAlive=false allows idle timeout during bg task", async () => {
    const onCold = vi.fn();
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      idleTimeout: 200,
      backgroundTaskKeepsAlive: false,
      backgroundTaskTimeout: 5000,
      minWorkers: 0,
      onFunctionCold: onCold,
    });
    await server.start();

    await httpRequest(server.port, "/background-task/background");

    // With keepsAlive=false, idle timer fires despite pending bg task
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(onCold).toHaveBeenCalledWith("background-task");
  }, 10_000);

  it("rejected background task does not crash worker", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();

    const response = await httpRequest(server.port, "/background-task-error/");
    expect(response.status).toBe(200);

    // Worker should still be responsive after rejected bg task
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const response2 = await httpRequest(server.port, "/background-task-error/");
    expect(response2.status).toBe(200);
  }, 10_000);

  it("graceful shutdown waits for background tasks", async () => {
    let bgComplete = false;
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
      backgroundTaskTimeout: 5000,
      workerOptions: {
        onBackgroundTaskComplete: () => {
          bgComplete = true;
        },
      },
    });
    await server.start();

    await httpRequest(server.port, "/background-task/background");
    // Background task is 500ms — stop() should wait for it
    const stopPromise = server.stop();

    // Give a moment for drain to start
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(bgComplete).toBe(false);

    await stopPromise;
    // After stop() resolves, bg task should have completed
    expect(bgComplete).toBe(true);
  }, 10_000);
});

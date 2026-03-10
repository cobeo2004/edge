import { afterEach, describe, expect, it } from "vitest";
import { EdgeFunctionServer } from "../../server/EdgeFunctionServer.js";
import { FUNCTIONS_DIR } from "../helpers/fixtures.js";

describe("EdgeFunctionServer – shared folders", { timeout: 15_000 }, () => {
  let server: EdgeFunctionServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("excludes underscore-prefixed folders from function discovery", async () => {
    server = new EdgeFunctionServer({
      functionsDir: FUNCTIONS_DIR,
      port: 0,
    });
    await server.start();
    const fns = server.listFunctions();
    expect(fns).not.toContain("_shared");
    expect(fns).toContain("hello");
    expect(fns).toContain("echo");
  });
});

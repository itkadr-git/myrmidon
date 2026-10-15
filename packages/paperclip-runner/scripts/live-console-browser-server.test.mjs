import { describe, expect, it } from "vitest";
import { access } from "node:fs/promises";

import { createLiveConsoleBrowserMiddleware } from "./live-console-browser-server.mjs";

describe("Live console Vite transport bootstrap", () => {
  it("uses the runner's shared bind guard before constructing middleware", async () => {
    const calls = [];
    const middleware = createLiveConsoleBrowserMiddleware({
      workingDirectory: "/server-owned-workspace",
      loadRunner: async () => ({
        assertLiveConsoleLoopbackBindHost(host) {
          calls.push(host);
          throw new Error("shared guard rejected non-loopback bind");
        },
      }),
    });

    await expect(middleware.prepare("0.0.0.0")).rejects.toThrow(
      "shared guard rejected non-loopback bind",
    );
    expect(calls).toEqual(["0.0.0.0"]);
  });

  it("passes the validated Vite bind host into the shared demo server", async () => {
    let serverOptions;
    const middleware = createLiveConsoleBrowserMiddleware({
      workingDirectory: "/server-owned-workspace",
      loadRunner: async () => ({
        assertLiveConsoleLoopbackBindHost(host) {
          expect(host).toBe("127.0.0.1");
        },
        liveConsoleDemoManifestCatalogue: () => [],
        LiveConsoleScriptedDriver: class {},
        LiveConsoleDemoServer: class {
          constructor(options) {
            serverOptions = options;
          }

          middleware() {
            return () => undefined;
          }

          async close() {}
        },
      }),
    });

    await middleware.prepare("127.0.0.1");
    expect(serverOptions).toMatchObject({
      host: "127.0.0.1",
      workingDirectory: "/server-owned-workspace",
    });
  });

  it("removes the owned working directory when the middleware closes", async () => {
    let closed = false;
    const middleware = createLiveConsoleBrowserMiddleware({
      loadRunner: async () => ({
        assertLiveConsoleLoopbackBindHost() {},
        liveConsoleDemoManifestCatalogue: () => [],
        LiveConsoleScriptedDriver: class {},
        LiveConsoleDemoServer: class {
          constructor(options) {
            this.workingDirectory = options.workingDirectory;
          }

          middleware() {
            return () => undefined;
          }

          async close() {
            closed = true;
          }
        },
      }),
    });

    const { workingDirectory } = await middleware.prepare("127.0.0.1");
    await expect(access(workingDirectory)).resolves.toBeUndefined();
    await middleware.close();
    expect(closed).toBe(true);
    await expect(access(workingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

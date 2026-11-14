import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
/**
 * Prod-boot smoke for the compiled server bundle (OPE-12180, BOARD-START-BUNDLE Ч4).
 *
 * The production Dockerfile CMD is a bare `node server/dist/index.js` (Ч2):
 * no tsx loader, no `--import` hooks, nothing that resolves TypeScript or
 * workspace `src/` files. That makes "the compiled bundle boots" a runtime
 * contract of its own — package.json exports/main substitution, self-referencing
 * imports of `@myrmidon/server` inside dist, and vendored runner resolution can
 * all pass `tsc` and the src-mode test suite yet fail only when plain node
 * loads dist. This test spawns exactly the production command against the
 * workspace dist and requires /api/health to answer 200.
 *
 * The build must already exist (`pnpm --filter @myrmidon/server build`); the
 * suite never builds on its own so it stays hermetic, fast, and independent of
 * docker, databases-as-a-service, or the network. It boots with the embedded
 * PostgreSQL path (no DATABASE_URL) inside a throwaway data home.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const serverDistIndex = join(repoRoot, "server", "dist", "index.js");

/** Reserve an ephemeral port, then release it for the server to bind. */
async function reserveFreePort(): Promise<number> {
  const probe = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    if (address && typeof address === "object" && address.port > 0) {
      resolve(address.port);
    } else {
      reject(new Error("probe address is not a TCP endpoint"));
    }
  });
  probe.on("error", reject);
  return promise.finally(() => probe.close());
}

async function fetchHealth(port: number, signal: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/health`, { signal });
}

describe("compiled server boots under bare node (no tsx)", () => {
  it(
    "answers 200 on /api/health without any loader in execArgv",
    { timeout: 120_000 },
    async () => {
      expect(
        existsSync(serverDistIndex),
        "server/dist/index.js is missing; run `pnpm --filter @myrmidon/server build` before this suite",
      ).toBe(true);

      const port = await reserveFreePort();
      const dataHome = mkdtempSync(join(tmpdir(), "myrmidon-prod-boot-"));
      const child = spawn(process.execPath, [serverDistIndex], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // Production command surface: plain node, no loader flags anywhere;
          // an empty NODE_OPTIONS also neutralizes any host-side loader.
          NODE_OPTIONS: "",
          // Same knob the image healthcheck reads; config.port picks it up.
          PORT: String(port),
          HOME: dataHome,
          // Unique instance root keeps the embedded Postgres cluster inside
          // the throwaway dir (no DATABASE_URL => embedded mode, like the image;
          // the server picks a free PG port itself when 54329 is taken).
          INSTANCE_ID: "prod-boot-smoke",
          NO_COLOR: "1",
        },
      });

      let output = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        output += chunk;
      });

      let exitError: Error | undefined;
      child.once("exit", (code, signalName) => {
        exitError = new Error(`server exited early (code=${code}, signal=${signalName})\n${output.slice(-4000)}`);
      });
      child.once("error", (error) => {
        exitError = error instanceof Error ? error : new Error(String(error));
      });

      try {
        const deadline = Date.now() + 90_000;
        let healthy = false;
        let lastFailure = "no probe attempted";

        while (Date.now() < deadline) {
          if (exitError) throw exitError;
          const probeSignal = AbortSignal.timeout(2_000);
          try {
            const response = await fetchHealth(port, probeSignal);
            if (response.status === 200) {
              healthy = true;
              break;
            }
            lastFailure = `/api/health answered ${response.status}`;
          } catch (error) {
            // The port only accepts connections once the server listens, so
            // early failures here are the normal "not up yet" case; if the
            // process died the exited promise resolves and surfaces above.
            lastFailure = error instanceof Error ? error.message : String(error);
          }
          await sleep(500);
        }

        expect(healthy, `server did not become healthy within 90s; last probe result: ${lastFailure}`).toBe(true);
      } finally {
        if (!child.killed && child.exitCode === null) {
          child.kill("SIGTERM");
          const { promise: graceful, resolve: markGracefulExit } = Promise.withResolvers<void>();
          child.once("exit", () => markGracefulExit());
          const winner = await Promise.race([graceful, sleep(10_000).then(() => undefined)]);
          if (winner === undefined && child.exitCode === null) {
            child.kill("SIGKILL");
            await graceful;
          }
        }
        rmSync(dataHome, { recursive: true, force: true });
      }
    },
  );
});

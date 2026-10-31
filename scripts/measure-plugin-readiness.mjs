#!/usr/bin/env node
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const PORT = process.env.PORT || "3100";
const BASE_URL = process.env.PAPERCLIP_BASE_URL || `http://127.0.0.1:${PORT}`;
const THRESHOLD_SECONDS = Number(process.env.PLUGIN_READY_THRESHOLD_SEC || 10);
const OUTPUT_FILE = path.resolve(
  REPO_ROOT,
  process.env.TIMING_OUTPUT_FILE || "plugin-readiness-timing.json",
);
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgrespassword@127.0.0.1:5432/postgres";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureBundledPluginsBuilt() {
  const kubeManifest = path.join(
    REPO_ROOT,
    "packages/plugins/sandbox-providers/kubernetes/dist/manifest.js",
  );
  if (!fs.existsSync(kubeManifest)) {
    console.log("Building kubernetes plugin bundle...");
    try {
      execSync("pnpm --filter @myrmidon/plugin-kubernetes build", {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });
    } catch (err) {
      console.warn("Failed to build kubernetes bundle:", err.message);
    }
  }

  const modalManifest = path.join(
    REPO_ROOT,
    "packages/plugins/sandbox-providers/modal/dist/manifest.js",
  );
  if (!fs.existsSync(modalManifest)) {
    console.log("Building modal plugin bundle...");
    try {
      execSync("pnpm --filter @myrmidon/plugin-modal build", {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });
    } catch (err) {
      console.warn("Failed to build modal bundle:", err.message);
    }
  }
}

async function waitForHealth(baseUrl, timeoutMs = 60_000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        return Date.now();
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(250);
  }
  throw new Error(
    `Server failed to become healthy at ${baseUrl}/api/health within ${timeoutMs}ms (${lastErr?.message || lastErr})`,
  );
}

async function waitForReadiness(baseUrl, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/plugins/readiness`);
      if (res.ok) {
        const body = await res.json();
        if (body.plugins && body.plugins.length > 0) {
          const allHaveMs = body.plugins.every(
            (p) => typeof p.readyAfterBoardReadyMs === "number",
          );
          if (allHaveMs) {
            return body;
          }
        }
      }
    } catch {
      // retry until ready
    }
    await sleep(200);
  }
  const finalRes = await fetch(`${baseUrl}/api/plugins/readiness`);
  if (!finalRes.ok) {
    throw new Error(
      `Failed to query ${baseUrl}/api/plugins/readiness: ${finalRes.statusText}`,
    );
  }
  return await finalRes.json();
}

function startServer(managedPlugins = ["kubernetes", "modal"]) {
  const managedConfig = JSON.stringify({
    v: 1,
    mode: "cloud",
    catalogVersion: "1.6.6",
    features: {},
    plugins: {
      autoInstall: managedPlugins,
    },
  });

  const serverEnv = {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL,
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
    PAPERCLIP_MANAGED_CONFIG: managedConfig,
    PAPERCLIP_BUNDLED_PLUGIN_ROOT: path.join(REPO_ROOT, "packages", "plugins"),
    NODE_ENV: "test",
  };

  const proc = spawn(
    "pnpm",
    ["--filter", "@myrmidon/server", "exec", "tsx", "src/index.ts"],
    {
      cwd: REPO_ROOT,
      env: serverEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let serverOutput = "";
  proc.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    serverOutput += text;
    if (process.env.DEBUG_SERVER) {
      process.stdout.write(`[server stdout] ${text}`);
    }
  });
  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    serverOutput += text;
    if (process.env.DEBUG_SERVER) {
      process.stderr.write(`[server stderr] ${text}`);
    }
  });

  const exitPromise = new Promise((resolve, reject) => {
    proc.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
    proc.on("error", (err) => {
      reject(err);
    });
  });

  return { proc, exitPromise, getServerOutput: () => serverOutput };
}

async function stopServer(proc, exitPromise) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (proc.exitCode === null) {
      proc.kill("SIGKILL");
    }
  }, 10_000);
  try {
    await exitPromise;
  } finally {
    clearTimeout(killTimer);
  }
}

async function measurePluginReload(baseUrl, plugin) {
  const pluginId = plugin.pluginId;
  const pluginKey = plugin.pluginKey;

  const disableRes = await fetch(`${baseUrl}/api/plugins/${pluginId}/disable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!disableRes.ok) {
    throw new Error(
      `Failed to disable plugin ${pluginKey}: ${disableRes.statusText}`,
    );
  }

  const enableStart = Date.now();
  const enableRes = await fetch(`${baseUrl}/api/plugins/${pluginId}/enable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!enableRes.ok) {
    throw new Error(
      `Failed to enable plugin ${pluginKey}: ${enableRes.statusText}`,
    );
  }

  let ready = false;
  while (Date.now() - enableStart < 15_000) {
    const checkRes = await fetch(`${baseUrl}/api/plugins/${pluginId}`);
    if (checkRes.ok) {
      const p = await checkRes.json();
      if (p.status === "ready") {
        ready = true;
        break;
      }
    }
    await sleep(100);
  }

  if (!ready) {
    throw new Error(
      `Plugin ${pluginKey} did not become ready within 15s after reload`,
    );
  }

  const durationMs = Date.now() - enableStart;
  const durationSec = Number((durationMs / 1000).toFixed(3));
  return {
    pluginId,
    pluginKey,
    reloadDurationMs: durationMs,
    reloadDurationSec: durationSec,
    passed: durationSec <= THRESHOLD_SECONDS,
  };
}

async function run() {
  console.log("=== Plugin Readiness & Reload Timing Measurement ===");
  console.log(`Target base URL: ${BASE_URL}`);
  console.log(`Threshold: ${THRESHOLD_SECONDS}s`);
  console.log(`Output artifact: ${OUTPUT_FILE}`);

  ensureBundledPluginsBuilt();

  let activeServer = null;
  let alreadyRunning = false;
  try {
    const existingHealth = await fetch(`${BASE_URL}/api/health`).catch(() => null);
    if (existingHealth && existingHealth.ok) {
      console.log(`Found existing healthy server on ${BASE_URL}`);
      alreadyRunning = true;
    }
  } catch {
    alreadyRunning = false;
  }

  let coldStartResults = [];
  let reloadResults = [];
  let restartResults = [];
  let initialReadiness = null;
  let restartReadiness = null;

  try {
    if (!alreadyRunning) {
      console.log("Starting server process for cold-start timing...");
      activeServer = startServer(["kubernetes", "modal"]);
    }

    console.log("Waiting for server board-ready (/api/health)...");
    const boardReadyAtMs = await waitForHealth(BASE_URL, 60_000);
    console.log(`Server board-ready confirmed at ${new Date(boardReadyAtMs).toISOString()}`);

    console.log("Querying plugin readiness (/api/plugins/readiness)...");
    initialReadiness = await waitForReadiness(BASE_URL, 30_000);
    const plugins = initialReadiness.plugins || [];
    console.log(`Found ${plugins.length} plugin(s) in readiness report.`);

    if (plugins.length === 0) {
      throw new Error("No plugins were loaded by the server; expected at least 1 bundled plugin.");
    }

    coldStartResults = plugins.map((p) => {
      const durationMs =
        typeof p.readyAfterBoardReadyMs === "number" ? p.readyAfterBoardReadyMs : 0;
      const durationSec = Number((durationMs / 1000).toFixed(3));
      return {
        pluginId: p.pluginId,
        pluginKey: p.pluginKey,
        readyAt: p.readyAt,
        readyAfterBoardReadyMs: durationMs,
        readyAfterBoardReadySec: durationSec,
        passed: durationSec <= THRESHOLD_SECONDS,
      };
    });

    console.log("\nMeasuring per-plugin reload duration (disable -> enable)...");
    for (const p of plugins) {
      console.log(`Reloading plugin ${p.pluginKey}...`);
      const reload = await measurePluginReload(BASE_URL, p);
      reloadResults.push(reload);
      console.log(`  -> Reloaded in ${reload.reloadDurationSec}s (passed: ${reload.passed})`);
    }

    if (!alreadyRunning && activeServer) {
      console.log("\nStopping server for board reload / restart measurement...");
      await stopServer(activeServer.proc, activeServer.exitPromise);
      activeServer = null;

      console.log("Restarting server process...");
      activeServer = startServer(["kubernetes", "modal"]);
      await waitForHealth(BASE_URL, 60_000);
      console.log("Restarted server confirmed healthy. Querying readiness...");
      restartReadiness = await waitForReadiness(BASE_URL, 30_000);
      const rebootPlugins = restartReadiness.plugins || [];
      restartResults = rebootPlugins.map((p) => {
        const durationMs =
          typeof p.readyAfterBoardReadyMs === "number" ? p.readyAfterBoardReadyMs : 0;
        const durationSec = Number((durationMs / 1000).toFixed(3));
        return {
          pluginId: p.pluginId,
          pluginKey: p.pluginKey,
          readyAt: p.readyAt,
          readyAfterBoardReadyMs: durationMs,
          readyAfterBoardReadySec: durationSec,
          passed: durationSec <= THRESHOLD_SECONDS,
        };
      });
      await stopServer(activeServer.proc, activeServer.exitPromise);
      activeServer = null;
    }
  } catch (err) {
    console.error("Error during measurement execution:", err);
    if (activeServer) {
      console.error("Server output before failure:\n", activeServer.getServerOutput());
      await stopServer(activeServer.proc, activeServer.exitPromise);
    }
    const failedArtifact = {
      timestamp: new Date().toISOString(),
      thresholdSeconds: THRESHOLD_SECONDS,
      error: err.message || String(err),
      coldStart: { boardReadyAt: null, plugins: coldStartResults },
      pluginReload: { plugins: reloadResults },
      serverRestart: { boardReadyAt: null, plugins: restartResults },
      summary: {
        pluginsCount: coldStartResults.length,
        thresholdSeconds: THRESHOLD_SECONDS,
        overallPassed: false,
      },
    };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(failedArtifact, null, 2), "utf8");
    process.exit(1);
  } finally {
    if (activeServer) {
      await stopServer(activeServer.proc, activeServer.exitPromise);
    }
  }

  const allPassed =
    coldStartResults.length > 0 &&
    coldStartResults.every((r) => r.passed) &&
    reloadResults.every((r) => r.passed) &&
    (restartResults.length === 0 || restartResults.every((r) => r.passed));

  const maxColdSec = Math.max(...coldStartResults.map((r) => r.readyAfterBoardReadySec), 0);
  const maxReloadSec = Math.max(...reloadResults.map((r) => r.reloadDurationSec), 0);
  const maxRestartSec = restartResults.length
    ? Math.max(...restartResults.map((r) => r.readyAfterBoardReadySec), 0)
    : 0;

  const artifact = {
    timestamp: new Date().toISOString(),
    thresholdSeconds: THRESHOLD_SECONDS,
    coldStart: {
      boardReadyAt: initialReadiness?.boardReadyAt ?? null,
      plugins: coldStartResults,
    },
    pluginReload: {
      plugins: reloadResults,
    },
    serverRestart: {
      boardReadyAt: restartReadiness?.boardReadyAt ?? null,
      plugins: restartResults,
    },
    summary: {
      pluginsCount: coldStartResults.length,
      maxColdStartDurationSec: maxColdSec,
      maxReloadDurationSec: maxReloadSec,
      maxRestartDurationSec: maxRestartSec,
      thresholdSeconds: THRESHOLD_SECONDS,
      overallPassed: allPassed,
    },
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(artifact, null, 2), "utf8");

  console.log("\n========================================================================================");
  console.log("                     PLUGIN READINESS & RELOAD TIMING REPORT");
  console.log("========================================================================================");
  console.log(`Threshold: <= ${THRESHOLD_SECONDS.toFixed(3)}s`);
  console.log(`Plugins evaluated: ${coldStartResults.length}`);
  console.log("----------------------------------------------------------------------------------------");
  console.log("Plugin Key             | Cold Start (s) | Plugin Reload (s) | Server Restart (s) | Status");
  console.log("-----------------------+----------------+-------------------+--------------------+-------");
  for (const c of coldStartResults) {
    const rel = reloadResults.find((r) => r.pluginKey === c.pluginKey);
    const rst = restartResults.find((r) => r.pluginKey === c.pluginKey);
    const cSec = `${c.readyAfterBoardReadySec.toFixed(3)}s`;
    const relSec = rel ? `${rel.reloadDurationSec.toFixed(3)}s` : "n/a";
    const rstSec = rst ? `${rst.readyAfterBoardReadySec.toFixed(3)}s` : "n/a";
    const pass = c.passed && (rel ? rel.passed : true) && (rst ? rst.passed : true);
    console.log(
      `${c.pluginKey.padEnd(23)}| ${cSec.padEnd(15)}| ${relSec.padEnd(18)}| ${rstSec.padEnd(19)}| ${pass ? "PASS" : "FAIL"}`,
    );
  }
  console.log("========================================================================================");
  console.log(
    `Overall Status: ${allPassed ? "PASSED (all readiness timings <= 10.000s)" : "FAILED (exceeded threshold)"}`,
  );
  console.log(`Artifact saved to: ${OUTPUT_FILE}`);
  console.log("========================================================================================\n");

  if (!allPassed) {
    process.exit(1);
  }
}

run();

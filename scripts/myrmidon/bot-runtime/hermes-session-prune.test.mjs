import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const ENTRYPOINT = path.join(REPO_ROOT, "docker/bot-runtime/entrypoint.sh");

describe("1.6.6 BOT-DISK hermes session maintenance", () => {
  it("entrypoint declares run_session_maintenance with a bounded, kill-after timeout before gateway_launch", () => {
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    const maintenanceDef = source.indexOf("run_session_maintenance()");
    const maintenanceCall = source.indexOf(`timeout --signal=TERM --kill-after=10s "\${m_timeout}s" bash -c 'run_session_maintenance'`);
    const gatewayLaunch = source.indexOf('log "phase gateway_launch starting"');

    assert.ok(maintenanceDef >= 0, "run_session_maintenance must be defined");
    assert.ok(maintenanceCall >= 0, "must invoke run_session_maintenance with a bounded timeout and --kill-after");
    assert.ok(gatewayLaunch >= 0, "gateway launch must be present");
    assert.ok(maintenanceCall < gatewayLaunch, "session maintenance must run before gateway launch");
  });

  it("exports sessions older than N to jsonl.gz and prunes them, leaving pinned sessions untouched", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-maint-test-"));
    const hermesHome = path.join(tmpDir, "hermes");
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    // Create a dummy state.db
    fs.writeFileSync(path.join(hermesHome, "state.db"), "dummy sqlite db");

    // Create a mock hermes CLI that simulates export, prune and optimize
    const logFile = path.join(tmpDir, "hermes.log");
    const mockHermes = path.join(binDir, "hermes");
    fs.writeFileSync(
      mockHermes,
      `#!/bin/bash
echo "$@" >> "${logFile}"
if [ "$1" = "sessions" ] && [ "$2" = "export" ]; then
  # Simulate exporting 1 old unpinned session (pinned is excluded by default)
  echo '{"id":"old-session-1","pinned":false,"ended_at":"2026-09-01T00:00:00Z"}'
  exit 0
elif [ "$1" = "sessions" ] && [ "$2" = "prune" ]; then
  # Simulate pruning only old unpinned session
  echo "Pruned 1 session(s)."
  exit 0
elif [ "$1" = "sessions" ] && [ "$2" = "optimize" ]; then
  exit 0
fi
exit 0
`,
      { mode: 0o755 }
    );

    // Run session maintenance bash routine extracted from entrypoint
    const script = `
      set -euo pipefail
      export HERMES_HOME="${hermesHome}"
      export MYRMIDON_BOTD_SESSION_RETENTION_DAYS="30"
      export PATH="${binDir}:$PATH"
      now_monotonic_ms() { date +%s%3N; }
      log() { echo "$*"; }

      # Source the function definition from entrypoint.sh
      source <(sed -n '/run_session_maintenance() {/,/^}/p' "${ENTRYPOINT}")
      run_session_maintenance
    `;

    execFileSync("bash", ["-c", script], { encoding: "utf8" });

    // Verify hermes CLI calls
    const calls = fs.readFileSync(logFile, "utf8");
    assert.ok(calls.includes("sessions export --format jsonl --older-than 30 -"), "must export older-than 30");
    assert.ok(calls.includes("sessions prune --older-than 30 --yes"), "must prune older-than 30 --yes");
    assert.ok(!calls.includes("--include-pinned"), "must never include pinned sessions");
    assert.ok(calls.includes("sessions optimize"), "must optimize after prune");

    // Verify exported archive in archive directory
    const archiveDir = path.join(hermesHome, ".myrmidon/archive");
    assert.ok(fs.existsSync(archiveDir), "archive dir must exist");
    const archives = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl.gz"));
    assert.equal(archives.length, 1, "must create exactly 1 session export archive");

    // Verify manifest.json records the archive
    const manifestPath = path.join(archiveDir, "manifest.json");
    assert.ok(fs.existsSync(manifestPath), "manifest.json must exist");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.archives.length, 1);
    assert.equal(manifest.archives[0].key, "sessions");

    // Verify session-prune.json report artifact
    const reportPath = path.join(hermesHome, ".myrmidon/session-prune.json");
    assert.ok(fs.existsSync(reportPath), "session-prune.json must exist");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.deletedSessions, 1);
    assert.equal(typeof report.stateDbBytesBefore, "number");
    assert.equal(typeof report.stateDbBytesAfter, "number");

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips prune when database is held by another process", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-maint-held-"));
    const hermesHome = path.join(tmpDir, "hermes");
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const stateDb = path.join(hermesHome, "state.db");
    fs.writeFileSync(stateDb, "dummy sqlite db");

    const logFile = path.join(tmpDir, "hermes.log");
    const mockHermes = path.join(binDir, "hermes");
    fs.writeFileSync(
      mockHermes,
      `#!/bin/bash
echo "$@" >> "${logFile}"
exit 0
`,
      { mode: 0o755 }
    );

    // Mock python3 to report that state.db is held
    const mockPython = path.join(binDir, "python3");
    fs.writeFileSync(
      mockPython,
      `#!/bin/bash
# Exit with 1 to indicate foreign holders exist
exit 1
`,
      { mode: 0o755 }
    );

    const script = `
      set -euo pipefail
      export HERMES_HOME="${hermesHome}"
      export MYRMIDON_BOTD_SESSION_RETENTION_DAYS="30"
      export PATH="${binDir}:$PATH"
      now_monotonic_ms() { date +%s%3N; }
      log() { echo "$*"; }

      source <(sed -n '/run_session_maintenance() {/,/^}/p' "${ENTRYPOINT}")
      run_session_maintenance
    `;

    const output = execFileSync("bash", ["-c", script], { encoding: "utf8" });
    assert.ok(output.includes("state.db is held by a running process"), "must log that db is held");

    // hermes must NOT have been called
    assert.ok(!fs.existsSync(logFile), "hermes prune must not be called when db is held");

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

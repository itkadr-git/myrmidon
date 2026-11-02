import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const ENTRYPOINT = path.join(REPO_ROOT, "docker/bot-runtime/entrypoint.sh");
const DOCKERFILE = path.join(REPO_ROOT, "docker/bot-runtime/Dockerfile");

function maintenanceFunction() {
  const source = fs.readFileSync(ENTRYPOINT, "utf8");
  const start = source.indexOf("run_live_session_maintenance() {");
  const deadline = source.indexOf("local deadline=$(( $(date +%s) + ${MYRMIDON_BOTD_SESSION_HEALTH_WAIT_SEC:-180} ))", start);
  const end = source.indexOf("\n}\n\n# Maintenance is intentionally detached", start) + 2;
  assert.ok(start >= 0 && deadline >= 0 && end > deadline, "live maintenance function must be extractable");
  return source.slice(start, end);
}

describe("1.6.6 BOT-DISK hermes session maintenance", () => {
  it("starts the gateway before background session retention", () => {
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    const gatewayLaunch = source.indexOf('log "phase gateway_launch starting"');
    const liveDefinition = source.indexOf("run_live_session_maintenance() {");
    const liveCall = source.indexOf("run_live_session_maintenance >/dev/null 2>&1 &");

    assert.ok(gatewayLaunch >= 0, "gateway launch must be present");
    assert.ok(liveDefinition > gatewayLaunch, "live retention must be defined after gateway launch");
    assert.ok(liveCall > gatewayLaunch, "live retention must be launched after gateway launch");
    assert.equal(source.indexOf("run_session_maintenance", 0), -1, "obsolete startup maintenance must not be present");
  });

  it("runs the live API contract against a mock gateway", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-prune-"));
    const previousMockEvents = process.env.MOCK_EVENTS;
    try {
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".myrmidon"), { recursive: true });
    fs.mkdirSync(bin);
    const now = Math.floor(Date.now() / 1000);
      const events = path.join(root, "events");
      fs.writeFileSync(events, "");
      process.env.MOCK_EVENTS = events;
      const mockCurl = `#!/bin/sh
set -eu
url=""
method=GET
prev=""
for arg in "$@"; do
  if [ "$prev" = "-X" ]; then method="$arg"; fi
  case "$arg" in http://*) url="$arg";; esac
  prev="$arg"
done
echo "$method $url" >> "$MOCK_EVENTS"
case "$method $url" in
  "GET http://127.0.0.1:8642/health") printf '{"ok":true}';;
  "GET http://127.0.0.1:8642/api/sessions?limit=100&offset=0&archived=include&order=recent" ) printf '{"sessions":[{"id":"old","last_active":${now - 90 * 86400},"pinned":false,"is_active":false},{"id":"recent","last_active":${now - 2 * 86400},"pinned":false,"is_active":false},{"id":"pinned","last_active":${now - 90 * 86400},"pinned":true,"is_active":false},{"id":"active","last_active":${now - 90 * 86400},"pinned":false,"is_active":true},{"id":"bad-export","last_active":${now - 90 * 86400},"pinned":false,"is_active":false}],"total":5}';;
  "GET http://127.0.0.1:8642/api/sessions/old") printf '{"id":"old","messages":[1,2]}';;
  "GET http://127.0.0.1:8642/api/sessions/bad-export") exit 22;;
  "DELETE http://127.0.0.1:8642/api/sessions/old") printf '{"ok":true}';;
  *) printf '{"unexpected":true}' >&2; exit 23;;
esac
`;
    fs.writeFileSync(path.join(bin, "curl"), mockCurl, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "sleep"), '#!/bin/sh\necho "SLEEP $1" >> "$MOCK_EVENTS"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "date"), `#!/bin/sh\ncase "$1" in +%s) printf "%s\\n" "${now}";; -u) printf "2026-11-01T00:00:00Z\\n";; *) /bin/date "$@";; esac\n`, { mode: 0o755 });
    const script = `#!/bin/bash
set -euo pipefail
log() { :; }
export API_SERVER_PORT=8642 API_SERVER_KEY=test-key HERMES_HOME=${home} MYRMIDON_BOTD_SESSION_RETENTION_DAYS=30 MYRMIDON_BOTD_SESSION_DELETE_PAUSE_SEC=0.01 MYRMIDON_BOTD_SESSION_HEALTH_WAIT_SEC=0 PATH=${bin}:$PATH MOCK_EVENTS=${events}
${maintenanceFunction()}
run_live_session_maintenance
`;
    const runner = path.join(root, "run.sh");
    fs.writeFileSync(runner, script, { mode: 0o755 });
    process.env.MOCK_EVENTS = events;
    try {
      execFileSync("bash", [runner], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_EVENTS: events }, timeout: 5000 });
    } finally {
      if (previousMockEvents === undefined) delete process.env.MOCK_EVENTS;
      else process.env.MOCK_EVENTS = previousMockEvents;
    }
    const lines = fs.readFileSync(events, "utf8").trim().split("\n");
    assert.ok(lines.includes("GET http://127.0.0.1:8642/api/sessions/old"));
    assert.ok(lines.includes("DELETE http://127.0.0.1:8642/api/sessions/old"));
    assert.ok(lines.indexOf("GET http://127.0.0.1:8642/api/sessions/old") < lines.indexOf("DELETE http://127.0.0.1:8642/api/sessions/old"));
    assert.ok(lines.includes("GET http://127.0.0.1:8642/api/sessions/bad-export"));
    assert.equal(lines.some((line) => line.startsWith("DELETE") && !line.endsWith("/old")), false);
    assert.equal(lines.some((line) => line.includes("DELETE") && (line.endsWith("/recent") || line.endsWith("/pinned") || line.endsWith("/active") || line.endsWith("/bad-export"))), false);
    assert.ok(lines.some((line) => line === "SLEEP 0.01"), "must pause between session deletions");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not optimize the live database and keeps a short health window", () => {
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    const live = source.slice(source.indexOf("run_live_session_maintenance() {"));

    assert.equal(live.includes("sessions optimize"), false, "live retention must not optimize state.db");
    assert.match(source, /while ! curl -fsS --max-time 3 .*\/health/);
    assert.match(dockerfile, /HEALTHCHECK --interval=30s --timeout=5s --start-period=45s/);
  });
});

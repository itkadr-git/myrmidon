import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const ENTRYPOINT = path.join(REPO_ROOT, "docker/bot-runtime/entrypoint.sh");
const DOCKERFILE = path.join(REPO_ROOT, "docker/bot-runtime/Dockerfile");

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

  it("retains sessions through the gateway one at a time", () => {
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    const liveStart = source.indexOf("run_live_session_maintenance() {");
    const live = source.slice(liveStart);

    assert.match(live, /\/api\/sessions\?older_than=\$\{retention_days\}d/);
    assert.match(live, /\/api\/sessions\/\$\{id\}/);
    assert.match(live, /curl -fsS -X DELETE/);
    assert.match(live, /sleep "\$interval"/);
    assert.match(live, /--max-time 120/);
    assert.match(live, /downloaded/);
    assert.match(live, /deleted/);
  });

  it("does not optimize the live database and keeps a short health window", () => {
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    const liveStart = source.indexOf("run_live_session_maintenance() {");
    const live = source.slice(liveStart);

    assert.equal(live.includes("sessions optimize"), false, "live retention must not optimize state.db");
    assert.match(source, /while ! curl -fsS --max-time 3 .*\/health/);
    assert.match(dockerfile, /HEALTHCHECK --interval=30s --timeout=5s --start-period=45s/);
  });
});

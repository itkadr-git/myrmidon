import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  buildBasebackupArgs,
  buildStandbyStatusQuery,
  calculateLag,
  evaluateRpo,
  evaluateTargetStatus,
  formatLsn,
  generateComposeStandby,
  generateStandbyConfig,
  lsnDiff,
  parseLsn,
  parseReplicationStatus,
  planFailover,
  planRehearsal,
  planSwitchback,
  runCli,
} from "./standby-ctl.mjs";

test("LSN parsing and formatting", () => {
  assert.equal(parseLsn(null), null);
  assert.equal(parseLsn(""), null);
  assert.equal(parseLsn("invalid"), null);

  const parsed = parseLsn("0/1A00000");
  assert.ok(typeof parsed === "bigint");
  assert.equal(formatLsn(parsed), "0/1A00000");

  const highLsn = parseLsn("1/10000000");
  assert.equal(formatLsn(highLsn), "1/10000000");

  const diff = lsnDiff("0/2000000", "0/1000000");
  assert.equal(diff, 0x1000000);
});

test("Replication lag calculation and RPO evaluation", () => {
  const now = new Date("2026-10-30T12:00:00Z");

  // Case 1: Perfectly caught-up replica
  const lagCaughtUp = calculateLag({
    currentLsn: "0/3000000",
    receiveLsn: "0/3000000",
    replayLsn: "0/3000000",
    lastReplayTimestamp: "2026-10-30T11:59:55Z",
    now,
  });
  assert.equal(lagCaughtUp.isCaughtUp, true);
  assert.equal(lagCaughtUp.byteLag, 0);
  assert.equal(lagCaughtUp.replayDelaySeconds, 5);

  const rpoCaughtUp = evaluateRpo(lagCaughtUp.replayDelaySeconds, 900);
  assert.equal(rpoCaughtUp.ok, true);
  assert.equal(rpoCaughtUp.status, "ok");
  assert.equal(rpoCaughtUp.marginSeconds, 895);

  // Case 2: Lag exceeding RPO (1000 seconds delay > 900s)
  const lagDelayed = calculateLag({
    currentLsn: "0/5000000",
    receiveLsn: "0/5000000",
    replayLsn: "0/4000000",
    lastReplayTimestamp: "2026-10-30T11:43:20Z", // 1000 seconds ago
    now,
  });
  assert.equal(lagDelayed.isCaughtUp, false);
  assert.equal(lagDelayed.receiveReplayByteLag, 0x1000000);
  assert.equal(lagDelayed.replayDelaySeconds, 1000);

  const rpoDelayed = evaluateRpo(lagDelayed.replayDelaySeconds, 900);
  assert.equal(rpoDelayed.ok, false);
  assert.equal(rpoDelayed.status, "lag_exceeded");
  assert.equal(rpoDelayed.marginSeconds, -100);

  // Case 3: Unknown / null lag
  const rpoUnknown = evaluateRpo(null, 900);
  assert.equal(rpoUnknown.ok, false);
  assert.equal(rpoUnknown.status, "unknown");
});

test("Base backup arguments generation", () => {
  const args = buildBasebackupArgs(DEFAULT_CONFIG.board, {
    primaryHost: "primary-db.local",
  });
  assert.ok(args.includes("-h"));
  assert.ok(args.includes("primary-db.local"));
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("5432"));
  assert.ok(args.includes("-D"));
  assert.ok(args.includes(DEFAULT_CONFIG.board.dataDir));
  assert.ok(args.includes("-Fp"));
  assert.ok(args.includes("-Xs"));
  assert.ok(args.includes("-R"));
  assert.ok(args.includes(`--slot=${DEFAULT_CONFIG.board.slotName}`));
});

test("Standby configuration generation", () => {
  const configText = generateStandbyConfig(DEFAULT_CONFIG.board, {
    primaryHost: "primary-db.local",
  });
  assert.ok(configText.includes("primary_conninfo = 'host=primary-db.local"));
  assert.ok(configText.includes("primary_slot_name = 'standby_board_slot'"));
  assert.ok(configText.includes("hot_standby = on"));
  assert.ok(configText.includes("restore_command = 'test -f"));
});

test("Compose standby definition generation", () => {
  const yaml = generateComposeStandby(DEFAULT_CONFIG);
  assert.ok(yaml.includes("myrmidon-pg-standby:"));
  assert.ok(yaml.includes("hindsight-pg-standby:"));
  assert.ok(yaml.includes("STANDBY_BOARD_PORT:-5433"));
  assert.ok(yaml.includes("STANDBY_HINDSIGHT_PORT:-5434"));
  assert.ok(yaml.includes("hot_standby=on"));
});

test("SQL query parsing and target evaluation", () => {
  const query = buildStandbyStatusQuery();
  assert.ok(query.includes("pg_is_in_recovery()"));

  // Standby healthy row
  const rawHealthy = "t | 0/2B00000 | 0/2B00000 | 2026-10-30T12:00:00Z";
  const statusHealthy = evaluateTargetStatus(DEFAULT_CONFIG.board, rawHealthy, {
    now: new Date("2026-10-30T12:00:10Z"),
    rpoMaxSeconds: 900,
  });
  assert.equal(statusHealthy.inRecovery, true);
  assert.equal(statusHealthy.role, "warm_standby");
  assert.equal(statusHealthy.rpoOk, true);
  assert.equal(statusHealthy.byteLag, 0);
  assert.equal(statusHealthy.timeLagSeconds, 10);

  // Standby delayed row
  const rawDelayed = "t | 0/3B00000 | 0/2B00000 | 2026-10-30T11:40:00Z";
  const statusDelayed = evaluateTargetStatus(DEFAULT_CONFIG.board, rawDelayed, {
    now: new Date("2026-10-30T12:00:00Z"),
    rpoMaxSeconds: 900,
  });
  assert.equal(statusDelayed.inRecovery, true);
  assert.equal(statusDelayed.rpoOk, false);
  assert.equal(statusDelayed.rpoStatus, "lag_exceeded");
  assert.equal(statusDelayed.timeLagSeconds, 1200);

  // Not in recovery (promoted or primary)
  const rawPrimary = "f |  |  | ";
  const statusPrimary = evaluateTargetStatus(DEFAULT_CONFIG.board, rawPrimary);
  assert.equal(statusPrimary.inRecovery, false);
  assert.equal(statusPrimary.role, "primary_or_standalone");
  assert.equal(statusPrimary.rpoOk, false);
});

test("Failover, switchback, and rehearsal execution planning", () => {
  const failoverPlan = planFailover(DEFAULT_CONFIG.board, { standbyHost: "myr-vm1.internal" });
  assert.equal(failoverPlan.target, "board");
  assert.equal(failoverPlan.promoteSql, "SELECT pg_promote();");
  assert.ok(failoverPlan.newEndpoint.includes("myr-vm1.internal:5433/paperclip"));

  const switchbackPlan = planSwitchback(DEFAULT_CONFIG.board, { primaryHost: "vm-core.internal" });
  assert.equal(switchbackPlan.target, "board");
  assert.ok(switchbackPlan.primaryEndpoint.includes("vm-core.internal:5432/paperclip"));
  assert.ok(switchbackPlan.standbySignalPath.endsWith("standby.signal"));

  const rehearsalPlan = planRehearsal(DEFAULT_CONFIG.board, { scratchDir: "/tmp/drill-board" });
  assert.equal(rehearsalPlan.drillDir, "/tmp/drill-board");
  assert.equal(rehearsalPlan.drillPort, 5533);
  assert.ok(rehearsalPlan.steps.length > 0);
});

test("CLI dry-run executions", () => {
  // Help command
  assert.equal(runCli(["node", "standby-ctl.mjs", "--help"]), 0);

  // Setup dry-run with JSON
  assert.equal(runCli(["node", "standby-ctl.mjs", "setup", "--dry-run", "--json"]), 0);

  // Check lag dry-run with JSON
  assert.equal(runCli(["node", "standby-ctl.mjs", "check-lag", "--dry-run", "--json"]), 0);

  // Failover dry-run with JSON
  assert.equal(runCli(["node", "standby-ctl.mjs", "failover", "--dry-run", "--json"]), 0);

  // Switchback dry-run with JSON
  assert.equal(runCli(["node", "standby-ctl.mjs", "switchback", "--dry-run", "--json"]), 0);

  // Rehearsal dry-run with JSON
  assert.equal(runCli(["node", "standby-ctl.mjs", "rehearse", "--dry-run", "--json"]), 0);

  // Compose printout
  assert.equal(runCli(["node", "standby-ctl.mjs", "compose"]), 0);
});

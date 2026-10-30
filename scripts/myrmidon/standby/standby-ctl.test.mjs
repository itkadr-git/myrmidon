import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLsn,
  calculateLag,
  parseReplicationStatus,
  generateStandbyConfig,
  generateBasebackupCommand,
  planFailover,
  planSwitchback,
  planRehearsal,
  setupStandby,
  checkLag,
  executeFailover,
  executeSwitchback,
  executeRehearsal,
  runCli,
  DEFAULT_CONFIG,
} from "./standby-ctl.mjs";

test("parseLsn parses valid PostgreSQL LSN strings into BigInt", () => {
  assert.equal(parseLsn("0/0"), 0n);
  assert.equal(parseLsn("0/1"), 1n);
  assert.equal(parseLsn("0/17FCA00"), 0x17fca00n);
  assert.equal(parseLsn("1/0"), 0x100000000n);
  assert.equal(parseLsn("1/17FCA00"), 0x100000000n + 0x17fca00n);
});

test("parseLsn returns null for invalid inputs", () => {
  assert.equal(parseLsn(null), null);
  assert.equal(parseLsn(""), null);
  assert.equal(parseLsn("invalid"), null);
  assert.equal(parseLsn("123/XYZ"), null);
});

test("calculateLag computes byte lag against primary and receive LSN", () => {
  const result = calculateLag({
    primaryLsn: "1/2000000",
    receiveLsn: "1/1000000",
    replayLsn: "1/0",
  });
  assert.equal(result.measuredAgainst, "primary");
  assert.equal(result.byteLag, 0x2000000n);
  assert.equal(result.receiveByteLag, 0x1000000n);
});

test("calculateLag handles boundaries and rpoMaxSeconds=0 correctly", () => {
  const now = new Date("2026-10-30T12:00:00Z");

  // Exact boundary: lag === rpoMaxSeconds -> OK
  const exact = calculateLag({
    receiveLsn: "1/0",
    replayLsn: "1/0",
    lastXactReplayTimestamp: "2026-10-30T11:45:00Z", // 900s ago
    rpoMaxSeconds: 900,
    now,
  });
  assert.equal(exact.timeLagSeconds, 900);
  assert.equal(exact.rpoOk, true);
  assert.equal(exact.rpoStatus, "ok");

  // Over boundary by 1 second: lag > rpoMaxSeconds -> lag_exceeded
  const exceeded = calculateLag({
    receiveLsn: "1/0",
    replayLsn: "1/0",
    lastXactReplayTimestamp: "2026-10-30T11:44:59Z", // 901s ago
    rpoMaxSeconds: 900,
    now,
  });
  assert.equal(exceeded.timeLagSeconds, 901);
  assert.equal(exceeded.rpoOk, false);
  assert.equal(exceeded.rpoStatus, "lag_exceeded");

  // RPO max = 0 (zero tolerance)
  const zeroRpoOk = calculateLag({
    receiveLsn: "1/0",
    replayLsn: "1/0",
    lastXactReplayTimestamp: "2026-10-30T12:00:00Z", // 0s
    rpoMaxSeconds: 0,
    now,
  });
  assert.equal(zeroRpoOk.timeLagSeconds, 0);
  assert.equal(zeroRpoOk.rpoOk, true);

  const zeroRpoFailed = calculateLag({
    receiveLsn: "1/0",
    replayLsn: "1/0",
    lastXactReplayTimestamp: "2026-10-30T11:59:59Z", // 1s
    rpoMaxSeconds: 0,
    now,
  });
  assert.equal(zeroRpoFailed.timeLagSeconds, 1);
  assert.equal(zeroRpoFailed.rpoOk, false);
  assert.equal(zeroRpoFailed.rpoStatus, "lag_exceeded");
});

test("parseReplicationStatus parses standard and error psql outputs", () => {
  const normal = parseReplicationStatus("t | 0/17FCA00 | 0/17FCA00 | 2026-10-30 10:00:00+00");
  assert.equal(normal.inRecovery, true);
  assert.equal(normal.receiveLsn, "0/17FCA00");
  assert.equal(normal.replayLsn, "0/17FCA00");
  assert.equal(normal.role, "standby");

  const notStandby = parseReplicationStatus("f | | | ");
  assert.equal(notStandby.inRecovery, false);
  assert.equal(notStandby.role, "primary_or_standalone");

  const connRefused = parseReplicationStatus("psql: error: connection to server on socket failed: Connection refused");
  assert.equal(connRefused.inRecovery, false);
  assert.equal(connRefused.role, "unreachable");

  const empty = parseReplicationStatus("");
  assert.equal(empty.inRecovery, false);
  assert.equal(empty.role, "unknown");
});

test("generateStandbyConfig includes required streaming parameters", () => {
  const cfg = generateStandbyConfig("board");
  assert.match(cfg, /primary_conninfo = 'host=10\.10\.100\.1/);
  assert.match(cfg, /primary_slot_name = 'standby_board_slot'/);
  assert.match(cfg, /hot_standby = 'on'/);
  assert.match(cfg, /restore_command = /);
});

test("generateBasebackupCommand generates slot and stream flags", () => {
  const cmd = generateBasebackupCommand("board");
  assert.equal(cmd.executable, "pg_basebackup");
  assert.ok(cmd.args.includes("-R"));
  assert.ok(cmd.args.includes("-Xs"));
  assert.ok(cmd.args.includes("--slot=standby_board_slot"));
});

test("checkLag measures primary-to-standby lag and handles fail-closed errors", () => {
  // 1. Success case: primary and standby both queryable
  const mockCalls = [];
  const mockRunner = (cmd, args) => {
    mockCalls.push({ cmd, args });
    const sql = args[args.indexOf("-c") + 1];
    if (sql.includes("pg_is_in_recovery")) {
      return { exitCode: 0, stdout: "t|1/2000000|1/2000000|2026-10-30 11:59:00+00\n", stderr: "" };
    }
    if (sql.includes("pg_current_wal_lsn")) {
      return { exitCode: 0, stdout: "1/2000000\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const res = checkLag("board", { now: new Date("2026-10-30T12:00:00Z") }, { runner: mockRunner });
  assert.equal(res.success, true);
  assert.equal(res.role, "standby");
  assert.equal(res.inRecovery, true);
  assert.equal(res.rpoOk, true);
  assert.equal(res.byteLag, 0n);
  assert.equal(res.timeLagSeconds, 60);

  // 2. Fail-closed: standby connection failure
  const failRunner = () => ({ exitCode: 2, stdout: "", stderr: "psql: error: could not connect to server" });
  const failRes = checkLag("board", {}, { runner: failRunner });
  assert.equal(failRes.success, false);
  assert.equal(failRes.rpoOk, false);
  assert.equal(failRes.role, "unreachable");
  assert.equal(failRes.rpoStatus, "standby_query_failed");

  // 3. Standby not in recovery
  const primaryRunner = () => ({ exitCode: 0, stdout: "f|||\n", stderr: "" });
  const primaryRes = checkLag("board", {}, { runner: primaryRunner });
  assert.equal(primaryRes.success, true);
  assert.equal(primaryRes.inRecovery, false);
  assert.equal(primaryRes.rpoOk, false);
  assert.equal(primaryRes.role, "primary_or_standalone");
  assert.equal(primaryRes.rpoStatus, "not_in_standby");

  // 4. Primary unreachable -> fail-closed
  const pUnreachRunner = (cmd, args) => {
    const sql = args[args.indexOf("-c") + 1];
    if (sql.includes("pg_is_in_recovery")) {
      return { exitCode: 0, stdout: "t|1/1000|1/1000|2026-10-30 11:59:00+00\n", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "connection timeout to primary" };
  };
  const pUnreachRes = checkLag("board", {}, { runner: pUnreachRunner });
  assert.equal(pUnreachRes.success, false);
  assert.equal(pUnreachRes.rpoOk, false);
  assert.equal(pUnreachRes.rpoStatus, "primary_unreachable");
});

test("setupStandby executes directory setup, basebackup, and config writes", () => {
  const fsWrites = [];
  const dirs = [];
  const mockFs = {
    mkdirSync: (dir) => dirs.push(dir),
    writeFileSync: (file, content) => fsWrites.push({ file, content }),
    existsSync: () => true,
    readFileSync: () => "",
    rmSync: () => {},
  };

  const executedCmds = [];
  const mockRunner = (cmd, args) => {
    executedCmds.push({ cmd, args });
    if (cmd === "psql") {
      return { exitCode: 0, stdout: "t|1\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const res = setupStandby("board", {}, { runner: mockRunner, fsOps: mockFs });
  assert.equal(res.success, true);
  assert.equal(res.inRecovery, true);
  assert.equal(res.streamingActive, true);

  assert.ok(dirs.includes(DEFAULT_CONFIG.boardDataDir));
  assert.ok(executedCmds.some((c) => c.cmd === "pg_basebackup"));
  assert.ok(fsWrites.some((f) => f.file.endsWith("standby.signal")));
  assert.ok(fsWrites.some((f) => f.file.endsWith("postgresql.auto.conf")));
});

test("executeFailover promotes standby, polls recovery exit, and restarts app", () => {
  let recoveryPolls = 0;
  const executedCmds = [];
  const mockRunner = (cmd, args) => {
    executedCmds.push({ cmd, args });
    if (cmd === "psql") {
      const sql = args[args.indexOf("-c") + 1];
      if (sql.includes("pg_promote")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sql.includes("pg_is_in_recovery")) {
        recoveryPolls++;
        // returns 't' on first poll, 'f' on second
        return { exitCode: 0, stdout: recoveryPolls > 1 ? "f\n" : "t\n", stderr: "" };
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const res = executeFailover("board", { restartApp: true, checkHealth: true }, { runner: mockRunner });
  assert.equal(res.success, true);
  assert.equal(res.promoted, true);
  assert.equal(res.inRecovery, false);
  assert.equal(res.appSwitched, true);
  assert.equal(res.healthOk, true);
  assert.equal(res.rtoOk, true);

  assert.ok(executedCmds.some((c) => c.cmd === "docker"));
  assert.ok(executedCmds.some((c) => c.cmd === "curl"));
});

test("executeSwitchback resynchronizes standby from active primary", () => {
  const executedCmds = [];
  const mockRunner = (cmd, args) => {
    executedCmds.push({ cmd, args });
    if (cmd === "psql") {
      const sql = args[args.indexOf("-c") + 1];
      if (sql.includes("pg_is_in_recovery")) {
        // Primary check returns 'f' (primary is active)
        return { exitCode: 0, stdout: "f\n", stderr: "" };
      }
    }
    return { exitCode: 0, stdout: "t|1\n", stderr: "" };
  };

  const mockFs = {
    mkdirSync: () => {},
    writeFileSync: () => {},
    existsSync: () => true,
    readFileSync: () => "",
    rmSync: () => {},
  };

  const res = executeSwitchback("board", {}, { runner: mockRunner, fsOps: mockFs });
  assert.equal(res.success, true);
  assert.equal(res.resynchronized, true);
});

test("executeRehearsal conducts isolated drill and measures RTO", () => {
  const executedCmds = [];
  let drillCleaned = false;
  const mockFs = {
    mkdirSync: () => {},
    writeFileSync: () => {},
    existsSync: () => true,
    readFileSync: () => "",
    rmSync: () => { drillCleaned = true; },
  };

  const mockRunner = (cmd, args) => {
    executedCmds.push({ cmd, args });
    if (cmd === "psql") {
      const sql = args[args.indexOf("-c") + 1];
      if (sql.includes("pg_is_in_recovery")) return { exitCode: 0, stdout: "f\n", stderr: "" };
      if (sql.includes("SELECT 1;")) return { exitCode: 0, stdout: "1\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const res = executeRehearsal("board", {}, { runner: mockRunner, fsOps: mockFs });
  assert.equal(res.success, true);
  assert.equal(res.promoted, true);
  assert.equal(res.smokeTestPassed, true);
  assert.equal(res.rtoOk, true);
  assert.equal(drillCleaned, true);

  assert.ok(executedCmds.some((c) => c.cmd === "pg_basebackup"));
  assert.ok(executedCmds.some((c) => c.cmd === "pg_ctl" && c.args.includes("start")));
  assert.ok(executedCmds.some((c) => c.cmd === "pg_ctl" && c.args.includes("stop")));
});

test("runCli commands output structured JSON and return correct exit codes", () => {
  let failoverPromoted = false;
  const mockRunner = (cmd, args) => {
    const sql = args[args.indexOf("-c") + 1] || "";
    if (sql.includes("pg_promote")) {
      failoverPromoted = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (sql.includes("pg_is_in_recovery")) {
      if (failoverPromoted) {
        return { exitCode: 0, stdout: "f\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "t|1/1000|1/1000|2026-10-30 11:59:00+00\n", stderr: "" };
    }
    if (sql.includes("pg_current_wal_lsn")) {
      return { exitCode: 0, stdout: "1/1000\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "1\n", stderr: "" };
  };

  const mockFs = {
    mkdirSync: () => {},
    writeFileSync: () => {},
    existsSync: () => true,
    readFileSync: () => "",
    rmSync: () => {},
  };

  // check-lag within RPO -> exit 0
  const codeCheck = runCli(["check-lag", "board", "--offline"], {}, { runner: mockRunner, fsOps: mockFs });
  assert.equal(codeCheck, 0);

  // failover dry-run -> exit 0
  const codeFailoverDry = runCli(["failover", "board", "--dry-run"], {}, { runner: mockRunner, fsOps: mockFs });
  assert.equal(codeFailoverDry, 0);

  // failover real execution -> exit 0
  const codeFailover = runCli(["failover", "board"], {}, { runner: mockRunner, fsOps: mockFs });
  assert.equal(codeFailover, 0);

  // rehearse real execution -> exit 0
  const codeRehearse = runCli(["rehearse", "board"], {}, { runner: mockRunner, fsOps: mockFs });
  assert.equal(codeRehearse, 0);
});

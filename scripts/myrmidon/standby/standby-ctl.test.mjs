import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  dockerPgPrefix,
  wrapPgForDocker,
  createPgRunner,
  mapPgBinaryForDocker,
  remapHostPortForDocker,
  queryPrimaryLsn,
  resolvePrimaryEndpoint,
  DEFAULT_COMPOSE_FILE,
  SQL_IN_RECOVERY,
  parsePgBool,
  firstField,
  classifyPsqlFailure,
  compareTimelines,
  validateDrillDir,
  dockerOneShotArgs,
  runInStandbyContainer,
  pgpassLine,
  spawnResultToRunnerResult,
  validateStandbyDataDir,
} from "./standby-ctl.mjs";


// ── Test helpers: realistic PostgreSQL / psql output ─────────────────────────────────────────
//
// OPE-7656 review finding 1: the mocks used to answer "t"/"f" for `pg_is_in_recovery()::text`,
// which real PostgreSQL prints as "true"/"false" - so the tests passed while the tool would
// have refused on a real server. Every role query is now `::int` and every mock below answers
// exactly what psql -t -A prints for it ("1"/"0"). None of these helpers spawns a process:
// the tool is only ever driven through an injected runner / fsOps.

const CONN_REFUSED =
  'psql: error: connection to server at "192.0.2.1", port 15432 failed: Connection refused\n\tIs the server running on that host and accepting TCP/IP connections?';
const CONN_TIMEOUT =
  'psql: error: connection to server at "192.0.2.1", port 15432 failed: timeout expired';
const AUTH_FAILED =
  'psql: error: connection to server at "192.0.2.1", port 15432 failed: FATAL:  password authentication failed for user "myr_replicator"';
const NO_CONTAINER = "Error response from daemon: container myrmidon-pg-standby is not running";

const OK = { exitCode: 0, stdout: "", stderr: "" };
const sqlOf = (args) => args[args.indexOf("-c") + 1] || "";
const dbOf = (args) => (args.indexOf("-d") === -1 ? "" : args[args.indexOf("-d") + 1]);
const hostOf = (args) => (args.indexOf("-h") === -1 ? "" : args[args.indexOf("-h") + 1]);
const portOf = (args) => (args.indexOf("-p") === -1 ? "" : args[args.indexOf("-p") + 1]);
const userOf = (args) => (args.indexOf("-U") === -1 ? "" : args[args.indexOf("-U") + 1]);

/** Undo the docker-mode wrapping: `docker exec -u postgres -e PGPASSFILE=.. <container> <tool> ...args`. */
function unwrap(cmd, args) {
  if (cmd === "docker" && args[0] === "exec") {
    const i = args.indexOf("myrmidon-pg-standby");
    return { tool: args[i + 1], args: args.slice(i + 2), viaDocker: true };
  }
  return { tool: cmd, args, viaDocker: false };
}

/** Same, but also recognises a `docker compose run ... --entrypoint <tool> <service> ...args` one-shot. */
function unwrapOneShot(cmd, args) {
  if (cmd === "docker" && args[0] === "compose" && args.includes("run")) {
    const e = args.indexOf("--entrypoint");
    const svc = args.indexOf("myrmidon-pg-standby", e);
    return { tool: args[e + 1], args: args.slice(svc + 1), oneShot: true, raw: args };
  }
  return null;
}

const SQL = {
  inRecovery: "pg_is_in_recovery()::int",
};

/**
 * A tiny simulated world: a primary (reachable or not), a standby container and a drill
 * cluster. The runner answers like the real tools would and records every call in order.
 */
function makeWorld(over = {}) {
  const w = {
    events: over.events || [],
    calls: [],
    // primary: writable | in_recovery | unreachable | timeout | auth_error | garbage | tool_timeout
    primary: "writable",
    primaryTimeline: 1,
    primaryLsn: "1/2000000",
    primarySystemId: "729374172937",
    standbySystemId: "729374172937",
    slotRow: "streaming|1048576|6144",
    composeStopNoop: false,
    dockerStopFails: false,
    standbyInRecovery: true,
    standbyTimeline: 1,
    standbyLsn: "1/1500000",
    containerRunning: true,
    walPolicyOk: true,
    slotOk: true,
    streaming: 1,
    conninfo:
      "user=myr_replicator passfile=/var/lib/postgresql/data/.pgpass host=192.0.2.1 port=15432 application_name=myrmidon_board_standby connect_timeout=10",
    pgCtlPromoteOk: true,
    pgPromoteSqlOk: true,
    basebackupOk: true,
    composeOk: true,
    composeStopOk: true,
    composeFailPattern: null,
    curlOk: true,
    // drill state
    drillDir: "/var/lib/postgresql/drill-cluster",
    drillExists: false,
    drillPromoted: false,
    drillStartOk: true,
    drillPromoteOk: true,
    drillStuck: false,
    rmOk: true,
    hindsightSmokeOk: true,
    boardSmokeOk: true,
    ...over,
  };
  w.events = over.events || [];

  const primaryAnswer = (sql) => {
    switch (w.primary) {
      case "unreachable":
        return { exitCode: 2, stdout: "", stderr: CONN_REFUSED };
      case "timeout":
        return { exitCode: 2, stdout: "", stderr: CONN_TIMEOUT };
      case "auth_error":
        return { exitCode: 2, stdout: "", stderr: AUTH_FAILED };
      case "tool_timeout":
        return { exitCode: 1, stdout: "", stderr: "Error: spawnSync docker ETIMEDOUT" };
      case "garbage":
        return { exitCode: 0, stdout: "maybe\n", stderr: "" };
      default:
    }
    if (sql.includes("IDENTIFY_SYSTEM")) {
      return { exitCode: 0, stdout: `${w.primarySystemId}|${w.primaryTimeline}|${w.primaryLsn}|paperclip\n`, stderr: "" };
    }
    if (sql.includes(SQL.inRecovery)) {
      return { exitCode: 0, stdout: w.primary === "in_recovery" ? "1\n" : "0\n", stderr: "" };
    }
    if (sql.includes("wal_status")) {
      return { exitCode: 0, stdout: `${w.slotRow}\n`, stderr: "" };
    }
    if (sql.includes("max_slot_wal_keep_size', true)")) {
      return { exitCode: 0, stdout: w.walPolicyOk ? "1\n" : "0\n", stderr: "" };
    }
    if (sql.includes("pg_create_physical_replication_slot")) {
      return { exitCode: 0, stdout: w.slotOk ? "1\n" : "0\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const standbyAnswer = (sql, viaDocker, args) => {
    if (!w.containerRunning) {
      return viaDocker
        ? { exitCode: 1, stdout: "", stderr: NO_CONTAINER }
        : { exitCode: 2, stdout: "", stderr: CONN_REFUSED.replace("192.0.2.1", "127.0.0.1") };
    }
    if (sql.includes("SHOW primary_conninfo")) return { exitCode: 0, stdout: `${w.conninfo}\n`, stderr: "" };
    if (sql.includes("IDENTIFY_SYSTEM")) {
      return { exitCode: 0, stdout: `${w.standbySystemId}|${w.standbyTimeline}|${w.standbyLsn}|paperclip\n`, stderr: "" };
    }
    if (sql.includes("pg_stat_wal_receiver")) {
      return { exitCode: 0, stdout: `${w.standbyInRecovery ? 1 : 0}|${w.streaming}\n`, stderr: "" };
    }
    if (sql.includes("pg_last_wal_receive_lsn")) {
      return {
        exitCode: 0,
        stdout: `1|1/1500000|1/1500000|${new Date(Date.now() - 5000).toISOString()}\n`,
        stderr: "",
      };
    }
    if (sql.includes(SQL.inRecovery)) {
      return { exitCode: 0, stdout: w.standbyInRecovery ? "1\n" : "0\n", stderr: "" };
    }
    if (sql.includes("pg_promote")) {
      if (!w.pgPromoteSqlOk) return { exitCode: 1, stdout: "", stderr: "ERROR:  permission denied for function pg_promote" };
      w.standbyInRecovery = false;
      return { exitCode: 0, stdout: "t\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const drillAnswer = (sql, args) => {
    if (sql.includes(SQL.inRecovery)) return { exitCode: 0, stdout: w.drillPromoted ? "0\n" : "1\n", stderr: "" };
    if (sql.includes("SELECT 1;")) {
      const db = dbOf(args);
      const ok = db === "myrmidon_hindsight" ? w.hindsightSmokeOk : w.boardSmokeOk;
      return ok ? { exitCode: 0, stdout: "1\n", stderr: "" } : { exitCode: 2, stdout: "", stderr: "psql: error: connection failed" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  w.runner = (cmd, args = [], ro = {}) => {
    w.calls.push({ cmd, args, ro });
    w.events.push({ kind: "cmd", cmd, args });

    if (cmd === "docker" && args[0] === "exec" && !w.containerRunning) {
      return { exitCode: 1, stdout: "", stderr: NO_CONTAINER };
    }

    // A base backup of the standby directory re-creates the standby from the primary.
    const resync = () => {
      w.standbyInRecovery = true;
      w.standbyTimeline = w.primaryTimeline;
    };

    const one = unwrapOneShot(cmd, args);
    if (one) {
      if (one.tool === "pg_basebackup") {
        if (w.basebackupOk) resync();
        return w.basebackupOk ? OK : { exitCode: 1, stdout: "", stderr: "pg_basebackup: error: could not connect" };
      }
      if (one.tool === "psql") return primaryAnswer(sqlOf(one.args));
      return OK;
    }

    if (cmd === "curl") {
      return w.curlOk ? OK : { exitCode: 22, stdout: "", stderr: "curl: (22) The requested URL returned error: 503" };
    }

    const u = unwrap(cmd, args);
    if (u.tool === "psql") {
      const host = hostOf(u.args);
      const port = portOf(u.args);
      const sql = sqlOf(u.args);
      if (host === "127.0.0.1" && port === String(w.drillPort || 5533) && !String(u.args.join(" ")).includes("replication=")) {
        return drillAnswer(sql, u.args);
      }
      if (host === "127.0.0.1" && (port === "5432" || port === "5433")) return standbyAnswer(sql, u.viaDocker, u.args);
      return primaryAnswer(sql);
    }
    if (/pg_ctl$/.test(u.tool)) {
      const sub = u.args[0];
      const dir = u.args[u.args.indexOf("-D") + 1];
      if (sub === "promote") {
        if (dir === w.drillDir) {
          if (!w.drillPromoteOk) return { exitCode: 1, stdout: "", stderr: "pg_ctl: could not send promote signal" };
          if (!w.drillStuck) w.drillPromoted = true;
          return OK;
        }
        if (!w.pgCtlPromoteOk) return { exitCode: 1, stdout: "", stderr: "pg_ctl: could not send promote signal (PID: 1)" };
        w.standbyInRecovery = false;
        return OK;
      }
      if (sub === "start") return w.drillStartOk ? OK : { exitCode: 1, stdout: "", stderr: "pg_ctl: could not start server" };
      if (sub === "stop") return OK;
    }
    if (u.tool === "pg_basebackup") {
      const dir = u.args[u.args.indexOf("-D") + 1];
      if (dir === w.drillDir && w.basebackupOk) w.drillExists = true;
      else if (dir !== w.drillDir && w.basebackupOk) resync();
      return w.basebackupOk ? OK : { exitCode: 1, stdout: "", stderr: "pg_basebackup: error: could not connect to server" };
    }
    if (cmd === "docker" && u.viaDocker && u.tool === "test") {
      return { exitCode: w.drillExists ? 0 : 1, stdout: "", stderr: "" };
    }
    if (cmd === "docker" && u.viaDocker && u.tool === "rm") {
      if (!w.rmOk) return { exitCode: 1, stdout: "", stderr: "rm: cannot remove: Permission denied" };
      w.drillExists = false;
      return OK;
    }
    if (cmd === "docker" && args[0] === "inspect") {
      return { exitCode: 0, stdout: w.containerRunning ? "true\n" : "false\n", stderr: "" };
    }
    if (cmd === "docker" && args[0] === "stop") {
      if (!w.dockerStopFails) w.containerRunning = false;
      return OK;
    }
    if (cmd === "docker" && args[0] === "compose") {
      if (w.composeFailPattern && args.join(" ").includes(w.composeFailPattern)) {
        return { exitCode: 1, stdout: "", stderr: "compose: error" };
      }
      if (args.includes("stop")) {
        if (!w.composeStopOk) return { exitCode: 1, stdout: "", stderr: "compose stop failed" };
        if (!w.composeStopNoop) w.containerRunning = false;
        return OK;
      }
      if (args.includes("up") && args.includes("myrmidon-pg-standby")) {
        w.containerRunning = true;
        return w.composeOk ? OK : { exitCode: 1, stdout: "", stderr: "compose up failed" };
      }
      return w.composeOk ? OK : { exitCode: 1, stdout: "", stderr: "compose error" };
    }
    return OK;
  };

  w.indexOf = (pred) => w.events.findIndex(pred);
  w.lastIndexOf = (pred) => {
    for (let i = w.events.length - 1; i >= 0; i--) if (pred(w.events[i])) return i;
    return -1;
  };
  return w;
}

const isPsqlEvent = (e) => e.kind === "cmd" && unwrap(e.cmd, e.args).tool === "psql";
const isComposeStop = (e) => e.kind === "cmd" && e.cmd === "docker" && e.args[0] === "compose" && e.args.includes("stop");
const isBasebackup = (e) =>
  e.kind === "cmd" && (e.cmd === "pg_basebackup" || unwrap(e.cmd, e.args).tool === "pg_basebackup" || (unwrapOneShot(e.cmd, e.args) || {}).tool === "pg_basebackup");
const isPromote = (e) => e.kind === "cmd" && /pg_ctl$/.test(unwrap(e.cmd, e.args).tool) && unwrap(e.cmd, e.args).args[0] === "promote";

/** Stateful in-memory fsOps for the data directory; records ordered fs events. */
function makeFs(over = {}) {
  const dataDir = over.dataDir || "/srv/standby/myrmidon-pg/data";
  const st = {
    entries: over.entries ? [...over.entries] : [],
    walEntries: over.walEntries || [],
    writes: [],
    mkdirs: [],
    chowns: [],
    rms: [],
    events: over.events || [],
  };
  const under = (p) => (p.startsWith(`${dataDir}/`) ? p.slice(dataDir.length + 1) : null);
  const fsOps = {
    existsSync: (p) => {
      if ((over.missing || []).includes(p)) return false;
      if (p === dataDir) return over.dataDirExists !== false;
      const rel = under(p);
      if (rel !== null) return st.entries.includes(rel.split("/")[0]);
      return true;
    },
    readdirSync: (p) => {
      if (p === dataDir) return [...st.entries];
      if (p === `${dataDir}/pg_wal`) return [...st.walEntries];
      return [];
    },
    readFileSync: () => over.passfileContent ?? "192.0.2.1:15432:*:myr_replicator:dummy-pw\n",
    writeFileSync: (p, content) => {
      st.writes.push({ file: p, content: String(content) });
      st.events.push({ kind: "fs", op: "write", path: p });
      const rel = under(p);
      if (rel !== null && !rel.includes("/") && !st.entries.includes(rel)) st.entries.push(rel);
    },
    mkdirSync: (p) => {
      st.mkdirs.push(p);
      st.events.push({ kind: "fs", op: "mkdir", path: p });
    },
    rmSync: (p) => {
      if (over.rmFails) throw new Error(`EACCES: permission denied, rm '${p}'`);
      st.rms.push(p);
      st.events.push({ kind: "fs", op: "rm", path: p });
      const rel = under(p);
      if (rel !== null) st.entries = st.entries.filter((e) => e !== rel.split("/")[0]);
    },
    chmodSync: () => {},
    chownSync: (p, uid, gid) => {
      const fails = typeof over.chownFails === "function" ? over.chownFails(p) : over.chownFails;
      if (fails) throw new Error("EPERM: operation not permitted, chown");
      st.chowns.push({ path: p, uid, gid });
      st.events.push({ kind: "fs", op: "chown", path: p });
    },
  };
  if (over.noChown) delete fsOps.chownSync;
  return { fsOps, state: st, dataDir };
}

/** A filesystem that fails the test if ANY host filesystem call is made. */
function makeForbiddenFs() {
  const boom = (op) => () => {
    throw new Error(`host filesystem call '${op}' is forbidden in docker mode`);
  };
  return {
    existsSync: boom("existsSync"),
    readdirSync: boom("readdirSync"),
    readFileSync: boom("readFileSync"),
    writeFileSync: boom("writeFileSync"),
    mkdirSync: boom("mkdirSync"),
    rmSync: boom("rmSync"),
    chmodSync: boom("chmodSync"),
    chownSync: boom("chownSync"),
  };
}

const PRIMARY = { primaryHost: "192.0.2.1", primaryPort: 15432 };

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

  // Exact boundary when byte lag is present: lag === rpoMaxSeconds -> OK
  const exact = calculateLag({
    receiveLsn: "1/1000",
    replayLsn: "1/0",
    lastXactReplayTimestamp: "2026-10-30T11:45:00Z", // 900s ago
    rpoMaxSeconds: 900,
    now,
  });
  assert.equal(exact.timeLagSeconds, 900);
  assert.equal(exact.rpoOk, true);
  assert.equal(exact.rpoStatus, "ok");

  // Over boundary by 1 second with byte lag: lag > rpoMaxSeconds -> lag_exceeded
  const exceeded = calculateLag({
    receiveLsn: "1/1000",
    replayLsn: "1/0",
    lastXactReplayTimestamp: "2026-10-30T11:44:59Z", // 901s ago
    rpoMaxSeconds: 900,
    now,
  });
  assert.equal(exceeded.timeLagSeconds, 901);
  assert.equal(exceeded.rpoOk, false);
  assert.equal(exceeded.rpoStatus, "lag_exceeded");

  // Idle database test (byteLag === 0n): timeLag naturally grows but rpoOk remains true!
  const idleDb = calculateLag({
    receiveLsn: "1/0",
    replayLsn: "1/0",
    lastXactReplayTimestamp: "2026-10-30T10:00:00Z", // 7200s ago (2 hours)
    rpoMaxSeconds: 900,
    now,
  });
  assert.equal(idleDb.timeLagSeconds, 7200);
  assert.equal(idleDb.byteLag, 0n);
  assert.equal(idleDb.rpoOk, true);
  assert.equal(idleDb.rpoStatus, "ok");

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
    primaryLsn: "1/10",
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
  const normal = parseReplicationStatus("1 | 0/17FCA00 | 0/17FCA00 | 2026-10-30 10:00:00+00");
  assert.equal(normal.inRecovery, true);
  assert.equal(normal.receiveLsn, "0/17FCA00");
  assert.equal(normal.replayLsn, "0/17FCA00");
  assert.equal(normal.role, "standby");

  // psql's native boolean rendering ("t"/"f"/"true") is still understood
  assert.equal(parseReplicationStatus("t | 0/1 | 0/1 | ").inRecovery, true);
  assert.equal(parseReplicationStatus("true | 0/1 | 0/1 | ").inRecovery, true);
  const notStandby = parseReplicationStatus("0 | | | ");
  assert.equal(notStandby.inRecovery, false);
  assert.equal(notStandby.role, "primary_or_standalone");

  const connRefused = parseReplicationStatus("psql: error: connection to server on socket failed: Connection refused");
  assert.equal(connRefused.inRecovery, false);
  assert.equal(connRefused.role, "unreachable");

  const empty = parseReplicationStatus("");
  assert.equal(empty.inRecovery, false);
  assert.equal(empty.role, "unknown");
});

test("setupStandby fails closed when primary max_slot_wal_keep_size is unbounded", () => {
  // current_setting('max_slot_wal_keep_size') is '-1' -> the policy query answers 0 (real ::int output)
  const w = makeWorld({ walPolicyOk: false });
  const { fsOps } = makeFs();

  const res = setupStandby("board", { replicatorPassword: "pw", pgRunner: "host", ...PRIMARY }, { runner: w.runner, fsOps });
  assert.equal(res.success, false);
  assert.match(res.error, /max_slot_wal_keep_size/);
  assert.equal(w.events.some(isBasebackup), false, "no basebackup on a refused policy");
});

test("setupStandby creates physical replication slot before basebackup", () => {
  const w = makeWorld();
  const { fsOps } = makeFs();

  const res = setupStandby(
    "board",
    { replicatorPassword: "pw", pgRunner: "host", readinessDelayMs: 0, ...PRIMARY },
    { runner: w.runner, fsOps }
  );
  assert.equal(res.success, true);
  const slotIdx = w.indexOf((e) => isPsqlEvent(e) && e.args.some((a) => a.includes("pg_create_physical_replication_slot")));
  const basebackupIdx = w.indexOf(isBasebackup);
  assert.ok(slotIdx >= 0, "Slot creation SQL executed");
  assert.ok(basebackupIdx > slotIdx, "Slot creation happens before pg_basebackup");

  // Finding 2/4: the primary is queried as the REPLICATOR over a replication connection,
  // never as the application role (the passfile only holds myr_replicator).
  const slotCall = w.events[slotIdx];
  assert.equal(userOf(slotCall.args), "myr_replicator");
  assert.match(dbOf(slotCall.args), /^replication=database dbname=paperclip/);
});

test("checkLag reports slot retention and fails closed on lost slot WAL", () => {
  // Slot WAL lost -> fail closed
  const lostSlotMock = (cmd, args) => {
    const sql = args[args.indexOf("-c") + 1] || "";
    if (cmd === "psql") {
      if (sql.includes("pg_replication_slots")) {
        return { exitCode: 0, stdout: "lost|1000|1024\n", stderr: "" };
      }
      if (sql.includes("IDENTIFY_SYSTEM")) {
        return { exitCode: 0, stdout: "729374172937|1|1/1000|\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "1 | 1/1000 | 1/1000 | 2026-10-30 10:00:00+00\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const lostRes = checkLag("board", { pgRunner: "host" }, { runner: lostSlotMock });
  assert.equal(lostRes.success, false);
  assert.equal(lostRes.rpoStatus, "slot_wal_lost");
  assert.match(lostRes.error, /standby_board_slot/);

  // Healthy slot retention -> success with slot info surfaced
  const healthySlotMock = (cmd, args) => {
    const sql = args[args.indexOf("-c") + 1] || "";
    if (cmd === "psql") {
      if (sql.includes("pg_replication_slots")) {
        return { exitCode: 0, stdout: "streaming|1048576|2048\n", stderr: "" };
      }
      if (sql.includes("IDENTIFY_SYSTEM")) {
        return { exitCode: 0, stdout: "729374172937|1|1/1000|\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "1 | 1/1000 | 1/1000 | 2026-10-30 10:00:00+00\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const okRes = checkLag("board", { pgRunner: "host" }, { runner: healthySlotMock });
  assert.equal(okRes.success, true);
  assert.equal(okRes.slotWalStatus, "streaming");
  assert.equal(okRes.slotRetainedBytes, 1048576);
  assert.equal(okRes.slotRetentionWarn, false);
});

test("generateStandbyConfig includes required streaming parameters and credentials via passfile", () => {
  const cfg = generateStandbyConfig("board");
  assert.match(cfg, /primary_conninfo = 'host=(?:10\.10\.100\.1|primary\.internal)/);
  assert.match(cfg, /primary_slot_name = 'standby_board_slot'/);
  assert.match(cfg, /passfile=\/var\/lib\/postgresql\/data\/\.pgpass/);
  assert.doesNotMatch(cfg, /password=/);
  assert.match(cfg, /hot_standby = 'on'/);
  assert.match(cfg, /restore_command = /);
  assert.match(cfg, /archive_cleanup_command = /);
});

test("generateBasebackupCommand generates slot and stream flags", () => {
  const cmd = generateBasebackupCommand("board");
  assert.equal(cmd.executable, "pg_basebackup");
  assert.ok(cmd.args.includes("-R"));
  assert.ok(cmd.args.includes("-Xs"));
  assert.ok(cmd.args.includes("--slot=standby_board_slot"));
  assert.ok(cmd.args.includes("-Fp"));
});

test("checkLag measures primary-to-standby lag and handles fail-closed errors", () => {
  const now = new Date("2026-10-30T12:00:00Z");

  // Normal lag check
  const normalMock = (cmd, args) => {
    const sql = args[args.indexOf("-c") + 1] || "";
    if (sql.includes("IDENTIFY_SYSTEM")) {
      return { exitCode: 0, stdout: "729374172937|1|1/2000000|\n", stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: "1 | 1/1500000 | 1/1000000 | 2026-10-30 11:55:00+00\n",
      stderr: "",
    };
  };

  const normal = checkLag("board", { now, rpoMaxSeconds: 900, pgRunner: "host" }, { runner: normalMock });
  assert.equal(normal.success, true);
  assert.equal(normal.role, "standby");
  assert.equal(normal.byteLag, 0x1000000n);
  assert.equal(normal.receiveByteLag, 0x500000n);
  assert.equal(normal.timeLagSeconds, 300);
  assert.equal(normal.rpoOk, true);

  // Standby query failure -> fail-closed
  const failStandbyMock = () => ({ exitCode: 2, stdout: "", stderr: "psql: error: connection refused" });
  const failedStandby = checkLag("board", { pgRunner: "host" }, { runner: failStandbyMock });
  assert.equal(failedStandby.success, false);
  assert.equal(failedStandby.rpoOk, false);
  assert.equal(failedStandby.role, "unreachable");

  // Primary unreachable -> fail-closed
  const failPrimaryMock = (cmd, args) => {
    const sql = args[args.indexOf("-c") + 1] || "";
    if (sql.includes("IDENTIFY_SYSTEM")) {
      return { exitCode: 2, stdout: "", stderr: "psql: error: primary host down" };
    }
    return { exitCode: 0, stdout: "1 | 1/1000 | 1/1000 | 2026-10-30 11:59:00+00\n", stderr: "" };
  };
  const failedPrimary = checkLag("board", { pgRunner: "host" }, { runner: failPrimaryMock });
  assert.equal(failedPrimary.success, false);
  assert.equal(failedPrimary.rpoOk, false);
  assert.equal(failedPrimary.rpoStatus, "primary_unreachable");
});

test("setupStandby executes directory setup, basebackup, and config writes", () => {
  const w = makeWorld();
  const { fsOps, state, dataDir } = makeFs();

  const res = setupStandby("board", { pgRunner: "host", readinessDelayMs: 0, ...PRIMARY }, { runner: w.runner, fsOps });
  assert.equal(res.success, true, res.error);
  assert.equal(res.inRecovery, true);
  assert.equal(res.streamingActive, true);

  assert.ok(state.mkdirs.includes(dataDir));
  assert.ok(w.events.some(isBasebackup));
  assert.ok(state.writes.some((f) => f.file.endsWith("standby.signal")));
  assert.ok(state.writes.some((f) => f.file.endsWith("postgresql.auto.conf")));
  assert.ok(state.writes.some((f) => f.file.endsWith(".pgpass")));
});

test("setupStandby fails closed if data directory is non-empty without --force", () => {
  const mockFs = {
    mkdirSync: () => {},
    writeFileSync: () => {},
    existsSync: () => true,
    readdirSync: () => ["PG_VERSION", "base", "global"],
    readFileSync: () => "",
    rmSync: () => {},
  };

  const executedCmds = [];
  const mockRunner = (cmd, args) => {
    executedCmds.push({ cmd, args });
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const res = setupStandby("board", { pgRunner: "host" }, { runner: mockRunner, fsOps: mockFs });
  assert.equal(res.success, false);
  assert.match(res.error, /exists but is not empty/);
  // Ensure pg_basebackup was NOT run
  assert.equal(executedCmds.some((c) => c.cmd === "pg_basebackup"), false);
});

test("setupStandby with --force stops container, wipes dataDir, and sets up standby", () => {
  const w = makeWorld();
  const { fsOps, state } = makeFs({ entries: ["PG_VERSION", "base", "standby.signal"] });

  const res = setupStandby("board", { force: true, pgRunner: "host", readinessDelayMs: 0, ...PRIMARY }, { runner: w.runner, fsOps });
  assert.equal(res.success, true, res.error);
  assert.equal(res.inRecovery, true);
  assert.equal(res.streamingActive, true);
  assert.deepEqual(state.rms.map((p) => p.split("/").pop()).sort(), ["PG_VERSION", "base", "standby.signal"]);
  assert.ok(w.events.some(isComposeStop));
  assert.ok(w.events.some(isBasebackup));
});

test("setupStandby fails if WAL receiver stream is not active (walReceivers === 0)", () => {
  const w = makeWorld({ streaming: 0 });
  const { fsOps } = makeFs({ dataDirExists: false });

  const res = setupStandby(
    "board",
    { replicatorPassword: "test_secret", readinessAttempts: 3, readinessDelayMs: 0, pgRunner: "host", ...PRIMARY },
    { runner: w.runner, fsOps }
  );
  assert.equal(res.success, false);
  assert.equal(res.inRecovery, true);
  assert.equal(res.walReceivers, 0);
  assert.equal(res.streamingActive, false);
  assert.match(res.error, /WAL streaming receiver is not active/);
});

test("executeFailover promotes standby, polls recovery exit, and restarts app", () => {
  // Primary is down (connection refused) and the operator confirmed fencing.
  const w = makeWorld({ primary: "unreachable" });

  const res = executeFailover(
    "board",
    {
      pgRunner: "host",
      fenced: true,
      restartApp: true,
      appComposeFile: "/opt/myrmidon/docker-compose.yml",
      checkHealth: true,
      verifyDelayMs: 0,
      ...PRIMARY,
    },
    { runner: w.runner }
  );
  assert.equal(res.success, true, res.error);
  assert.equal(res.promoted, true);
  assert.equal(res.inRecovery, false);
  assert.equal(res.appSwitched, true);
  assert.equal(res.healthOk, true);
  assert.equal(res.rtoOk, true);
  assert.equal(res.guard.state, "unreachable_fenced");

  const compose = w.calls.find((c) => c.cmd === "docker" && c.args.includes("--force-recreate"));
  assert.deepStrictEqual(compose.args, ["compose", "-f", "/opt/myrmidon/docker-compose.yml", "up", "-d", "--force-recreate", "myrmidon-board"]);
  assert.ok(w.calls.some((c) => c.cmd === "curl"));
});

test("executeSwitchback resynchronizes standby from active primary", () => {
  // Real PostgreSQL answers: the original primary says 0 (not in recovery), the standby says 1.
  const w = makeWorld({ primary: "writable", standbyInRecovery: true });
  const { fsOps } = makeFs({ entries: ["PG_VERSION", "base", "standby.signal"] });

  const res = executeSwitchback(
    "board",
    { force: true, pgRunner: "host", readinessDelayMs: 0, ...PRIMARY },
    { runner: w.runner, fsOps }
  );
  assert.equal(res.success, true, res.error);
  assert.equal(res.resynchronized, true);
  assert.equal(res.inRecovery, true);
  assert.equal(res.streamingActive, true);
});

test("executeSwitchback refuses to discard writes on a promoted (non-recovery) standby", () => {
  // BOTH primary and standby answer 0: the standby was promoted and is the active writer.
  const w = makeWorld({ primary: "writable", standbyInRecovery: false, standbyTimeline: 2 });
  const { fsOps, state } = makeFs({ entries: ["PG_VERSION", "existing_pg_file"] });

  // Even with --force the promoted standby must be protected without the explicit discard flag
  const res = executeSwitchback("board", { force: true, pgRunner: "host", ...PRIMARY }, { runner: w.runner, fsOps });
  assert.equal(res.success, false);
  assert.match(res.error, /NOT a standby any more/);
  assert.match(res.error, /--discard-promoted-standby/);
  assert.equal(state.rms.length, 0, "nothing wiped");
  assert.equal(w.events.some(isComposeStop), false, "container not stopped");
  assert.equal(w.events.some(isBasebackup), false, "no basebackup");
  // The comparison is part of the refusal so the operator can see what would be lost.
  assert.equal(res.comparison.verdict, "standby_ahead");
});

test("executeSwitchback fails closed without explicit force flag", () => {
  const w = makeWorld({ primary: "writable" });
  const { fsOps, state } = makeFs({ entries: ["existing_pg_file"] });

  const res = executeSwitchback("board", { pgRunner: "host", ...PRIMARY }, { runner: w.runner, fsOps });
  assert.equal(res.success, false);
  assert.match(res.error, /force/);
  assert.equal(state.rms.length, 0);
  assert.equal(w.events.some(isComposeStop), false);
  assert.equal(w.events.some(isBasebackup), false);
  assert.equal(w.calls.length, 0, "the --force check runs before any command is executed");
});

test("executeRehearsal conducts isolated drill, smoke tests both databases, and measures RTO", () => {
  const executedCmds = [];
  let drillCleaned = false;
  const queriedDatabases = [];
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
      const dbIdx = args.indexOf("-d");
      if (dbIdx !== -1) {
        queriedDatabases.push(args[dbIdx + 1]);
      }
      if (sql.includes("pg_is_in_recovery")) return { exitCode: 0, stdout: "0\n", stderr: "" };
      if (sql.includes("SELECT 1;")) return { exitCode: 0, stdout: "1\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const res = executeRehearsal("board", { pgRunner: "host" }, { runner: mockRunner, fsOps: mockFs });
  assert.equal(res.success, true);
  assert.equal(res.promoted, true);
  assert.equal(res.smokeTestPassed, true);
  assert.deepStrictEqual(res.verifiedDatabases, ["paperclip", "myrmidon_hindsight"]);
  assert.ok(queriedDatabases.includes("paperclip"));
  assert.ok(queriedDatabases.includes("myrmidon_hindsight"));
  assert.equal(res.rtoOk, true);
  assert.equal(drillCleaned, true);

  assert.ok(executedCmds.some((c) => c.cmd === "pg_basebackup"));
  assert.ok(executedCmds.some((c) => c.cmd === "pg_ctl" && c.args.includes("start")));
  assert.ok(executedCmds.some((c) => c.cmd === "pg_ctl" && c.args.includes("stop")));
});

test("runCli commands output structured JSON and return correct exit codes", () => {
  const w = makeWorld({ primary: "unreachable" });
  const { fsOps } = makeFs();

  // check-lag within RPO -> exit 0
  const codeCheck = runCli(["check-lag", "board", "--offline", "--pg-runner=host"], {}, { runner: w.runner, fsOps });
  assert.equal(codeCheck, 0);

  // failover dry-run -> exit 0
  const codeFailoverDry = runCli(["failover", "board", "--dry-run"], {}, { runner: w.runner, fsOps });
  assert.equal(codeFailoverDry, 0);

  // failover against an UNREACHABLE primary without fencing confirmation -> refused (exit 1)
  const codeUnfenced = runCli(["failover", "board", "--pg-runner=host"], {}, { runner: w.runner, fsOps });
  assert.equal(codeUnfenced, 1);
  assert.equal(w.events.some(isPromote), false, "nothing promoted without --fenced");

  // failover real execution with --fenced -> exit 0
  const codeFailover = runCli(["failover", "board", "--pg-runner=host", "--fenced"], {}, { runner: w.runner, fsOps });
  assert.equal(codeFailover, 0);
  assert.equal(w.events.some(isPromote), true);

  // rehearse real execution -> exit 0
  const codeRehearse = runCli(["rehearse", "board", "--pg-runner=host"], {}, { runner: makeWorld().runner, fsOps });
  assert.equal(codeRehearse, 0);
});

test("setupStandby uses credential path, sets PGPASSFILE env on basebackup, and omits password from config", () => {
  const w = makeWorld();
  const { fsOps, state } = makeFs({ passfileContent: "primary.internal:5432:*:myr_replicator:secret123\n" });

  const res = setupStandby(
    "board",
    { credentialPath: "/etc/standby/pgpass", pgRunner: "host", readinessDelayMs: 0, ...PRIMARY },
    { runner: w.runner, fsOps }
  );

  assert.equal(res.success, true, res.error);
  assert.equal(res.inRecovery, true);
  assert.equal(res.walReceivers, 1);

  // Verify pg_basebackup was invoked with PGPASSFILE pointing to credential path
  const basebackupCall = w.calls.find((c) => c.cmd === "pg_basebackup");
  assert.ok(basebackupCall);
  assert.equal(basebackupCall.ro.env?.PGPASSFILE, "/etc/standby/pgpass");

  // Verify container .pgpass was written into dataDir
  assert.ok(state.writes.some((f) => f.file.endsWith(".pgpass")));

  // Verify postgresql.auto.conf uses container passfile (/var/lib/postgresql/data/.pgpass)
  // and does NOT use host credential path (/etc/standby/pgpass) nor embed raw password
  const autoConf = state.writes.find((f) => f.file.endsWith("postgresql.auto.conf"));
  assert.ok(autoConf);
  assert.match(autoConf.content, /passfile=\/var\/lib\/postgresql\/data\/\.pgpass/);
  assert.doesNotMatch(autoConf.content, /\/etc\/standby\/pgpass/);
  assert.doesNotMatch(autoConf.content, /password=/);
});

test("executeRehearsal fails closed if promotion verification fails (in_recovery is true)", () => {
  // pg_ctl promote "succeeds" but the instance is still in recovery: pg_is_in_recovery()::int = 1
  const w = makeWorld({ drillStuck: true });
  const { fsOps } = makeFs();

  const res = executeRehearsal("board", { pgRunner: "host" }, { runner: w.runner, fsOps });
  assert.equal(res.success, false);
  assert.equal(res.promoted, false);
  assert.match(res.error, /Promotion verification failed/);

  // CLI exit code must be 1 (non-zero)
  const cliCode = runCli(["rehearse", "board", "--pg-runner=host"], {}, { runner: makeWorld({ drillStuck: true }).runner, fsOps });
  assert.equal(cliCode, 1);
});

test("executeRehearsal fails closed if smoke test fails for database", () => {
  const w = makeWorld({ hindsightSmokeOk: false });
  const { fsOps } = makeFs();

  const res = executeRehearsal("board", { pgRunner: "host" }, { runner: w.runner, fsOps });
  assert.equal(res.success, false);
  assert.equal(res.promoted, true);
  assert.equal(res.smokeTestPassed, false);
  assert.match(res.error, /Smoke test failed for database 'myrmidon_hindsight'/);

  // CLI exit code must be 1 (non-zero)
  const cliCode = runCli(["rehearse", "board", "--pg-runner=host"], {}, { runner: makeWorld({ hindsightSmokeOk: false }).runner, fsOps });
  assert.equal(cliCode, 1);
});

test("checkLag verifies both databases on shared standby cluster port 5433 without split ports", () => {
  const calls = [];
  const mockRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "psql") {
      const sql = args[args.indexOf("-c") + 1] || "";
      if (sql.includes("pg_is_in_recovery")) {
        return {
          exitCode: 0,
          stdout: "1|1/1000|1/1000|2026-10-31 12:00:00+00\n",
          stderr: "",
        };
      }
      if (sql.includes("IDENTIFY_SYSTEM")) {
        return { exitCode: 0, stdout: "729374172937|1|1/1000|\n", stderr: "" };
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  // Run checkLag with target="all"
  const res = checkLag("all", { pgRunner: "host" }, { runner: mockRunner });
  assert.equal(res.success, true);
  assert.equal(res.rpoOk, true);
  assert.equal(res.target, "all");
  assert.equal(res.databases.length, 2);

  // Both databases (paperclip and myrmidon_hindsight) must be queried
  const queriedDbs = [];
  const queriedPorts = [];
  for (const call of calls) {
    if (call.cmd === "psql") {
      const pIdx = call.args.indexOf("-p");
      if (pIdx !== -1) queriedPorts.push(call.args[pIdx + 1]);
      const dIdx = call.args.indexOf("-d");
      if (dIdx !== -1) queriedDbs.push(call.args[dIdx + 1]);
    }
  }

  assert.ok(queriedDbs.includes("paperclip"));
  assert.ok(queriedDbs.includes("myrmidon_hindsight"));
  // All standby queries must use the single shared port 5433 (no separate 5434/etc)
  const standbyPortQueries = queriedPorts.filter((p) => p === "5433");
  assert.ok(standbyPortQueries.length >= 2, "Both databases queried on shared standby port 5433");
  assert.ok(!queriedPorts.some((p) => p !== "5433" && p !== "5432"), "No divergent or split standby ports used");
});

test("checkLag respects unified custom standbyPort and primaryPort on single cluster", () => {
  const calls = [];
  const mockRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "psql") {
      return {
        exitCode: 0,
        stdout: "1|1/1000|1/1000|2026-10-31 12:00:00+00\n",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const customStandbyPort = 5444;
  const customPrimaryPort = 5422;
  const res = checkLag("all", { standbyPort: customStandbyPort, primaryPort: customPrimaryPort, pgRunner: "host" }, { runner: mockRunner });
  assert.equal(res.success, true);

  const standbyCalls = calls.filter((c) => c.cmd === "psql" && c.args.includes("-p") && c.args[c.args.indexOf("-p") + 1] === String(customStandbyPort));
  assert.ok(standbyCalls.length >= 2, "Both databases queried using the unified custom standbyPort");
});

test("runCli check-lag defaults to checking both databases on shared cluster port 5433", () => {
  const calls = [];
  const mockRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "psql") {
      return {
        exitCode: 0,
        stdout: "1|1/1000|1/1000|2026-10-31 12:00:00+00\n",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const code = runCli(["check-lag", "--offline", "--pg-runner=host"], {}, { runner: mockRunner });
  assert.equal(code, 0);

  const queriedDbs = calls
    .filter((c) => c.cmd === "psql" && c.args.includes("-d"))
    .map((c) => c.args[c.args.indexOf("-d") + 1]);
  assert.ok(queriedDbs.includes("paperclip"), "Checks paperclip DB");
  assert.ok(queriedDbs.includes("myrmidon_hindsight"), "Checks myrmidon_hindsight DB");

  const ports = calls
    .filter((c) => c.cmd === "psql" && c.args.includes("-p"))
    .map((c) => c.args[c.args.indexOf("-p") + 1]);
  assert.ok(ports.every((p) => p === "5433"), "All offline queries target shared standby port 5433");
});

test("runCli rehearse respects --drill-dir and --drill-port and executes successfully", () => {
  const dirsCreated = [];
  const mockFs = {
    mkdirSync: (dir) => { dirsCreated.push(dir); },
    writeFileSync: () => {},
    existsSync: () => true,
    readFileSync: () => "",
    rmSync: () => {},
  };

  const calls = [];
  const mockRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "psql") {
      const sql = args[args.indexOf("-c") + 1] || "";
      if (sql.includes("pg_is_in_recovery")) {
        return { exitCode: 0, stdout: "0\n", stderr: "" };
      }
      if (sql.includes("SELECT 1;")) {
        return { exitCode: 0, stdout: "1\n", stderr: "" };
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const code = runCli(["rehearse", "all", "--drill-dir=/var/tmp/standby-test/drill-dir", "--drill-port=5599", "--pg-runner=host"], {}, { runner: mockRunner, fsOps: mockFs });
  assert.equal(code, 0);
  assert.ok(dirsCreated.includes("/var/tmp/standby-test/drill-dir"));

  const drillCalls = calls.filter((c) => c.cmd === "psql" && c.args.includes("-p") && c.args[c.args.indexOf("-p") + 1] === "5599");
  assert.ok(drillCalls.length >= 2, "Smoke tests executed on custom drill port 5599");
});

// ── ADM rehearsal feedback (03.11) ─────────────────────────────────────────

test("dockerPgPrefix uses docker exec into the standby container", () => {
  const prefix = dockerPgPrefix();
  assert.deepStrictEqual(prefix, ["exec", "-u", "postgres", "-e", "PGPASSFILE=/var/lib/postgresql/data/.pgpass", "myrmidon-pg-standby"]);
});

test("dockerPgPrefix respects custom pgContainer", () => {
  const prefix = dockerPgPrefix({ pgContainer: "custom-pg" });
  assert.deepStrictEqual(prefix, ["exec", "-u", "postgres", "-e", "PGPASSFILE=/var/lib/postgresql/data/.pgpass", "custom-pg"]);
});

test("mapPgBinaryForDocker maps pg_ctl to full container path", () => {
  assert.equal(mapPgBinaryForDocker("pg_ctl"), "/usr/lib/postgresql/18/bin/pg_ctl");
  assert.equal(mapPgBinaryForDocker("psql"), "psql");
  assert.equal(mapPgBinaryForDocker("pg_basebackup"), "pg_basebackup");
  assert.equal(mapPgBinaryForDocker("pg_isready"), "pg_isready");
});

test("remapHostPortForDocker remaps standby 127.0.0.1:5433 to container port 5432", () => {
  const r = remapHostPortForDocker("127.0.0.1", 5433);
  assert.deepStrictEqual(r, { host: "127.0.0.1", port: 5432 });
});

test("remapHostPortForDocker does NOT remap primary connections", () => {
  const r = remapHostPortForDocker("192.0.2.1", 15432);
  assert.deepStrictEqual(r, { host: "192.0.2.1", port: 15432 });
});

test("remapHostPortForDocker does NOT remap non-standby localhost ports", () => {
  const r = remapHostPortForDocker("127.0.0.1", 5533);
  assert.deepStrictEqual(r, { host: "127.0.0.1", port: 5533 });
});

test("wrapPgForDocker builds docker exec command for psql to standby", () => {
  const wrapped = wrapPgForDocker("psql", [
    "-h", "127.0.0.1", "-p", "5433",
    "-U", "paperclip", "-d", "paperclip",
    "-t", "-A", "-c", "SELECT 1;",
  ]);
  assert.equal(wrapped.cmd, "docker");
  assert.deepStrictEqual(wrapped.args, [
    "exec", "-u", "postgres", "-e", "PGPASSFILE=/var/lib/postgresql/data/.pgpass", "myrmidon-pg-standby",
    "psql",
    "-h", "127.0.0.1", "-p", "5432",
    "-U", "paperclip", "-d", "paperclip",
    "-t", "-A", "-c", "SELECT 1;",
  ]);
});

test("wrapPgForDocker builds docker exec command for psql to primary (no remap)", () => {
  const wrapped = wrapPgForDocker("psql", [
    "-h", "192.0.2.1", "-p", "15432",
    "-U", "myr_replicator", "-d", "replication=database dbname=paperclip",
    "-t", "-A", "-c", "IDENTIFY_SYSTEM;",
  ]);
  assert.equal(wrapped.cmd, "docker");
  assert.deepStrictEqual(wrapped.args, [
    "exec", "-u", "postgres", "-e", "PGPASSFILE=/var/lib/postgresql/data/.pgpass", "myrmidon-pg-standby",
    "psql",
    "-h", "192.0.2.1", "-p", "15432",
    "-U", "myr_replicator", "-d", "replication=database dbname=paperclip",
    "-t", "-A", "-c", "IDENTIFY_SYSTEM;",
  ]);
});

test("wrapPgForDocker maps pg_ctl to container path", () => {
  const wrapped = wrapPgForDocker("pg_ctl", ["promote", "-D", "/srv/standby/myrmidon-pg/data"]);
  assert.equal(wrapped.cmd, "docker");
  assert.deepStrictEqual(wrapped.args, [
    "exec", "-u", "postgres", "-e", "PGPASSFILE=/var/lib/postgresql/data/.pgpass", "myrmidon-pg-standby",
    "/usr/lib/postgresql/18/bin/pg_ctl",
    "promote", "-D", "/srv/standby/myrmidon-pg/data",
  ]);
});

test("wrapPgForDocker maps pg_basebackup to docker exec", () => {
  const wrapped = wrapPgForDocker("pg_basebackup", [
    "-h", "127.0.0.1", "-p", "5433",
    "-U", "myr_replicator", "-D", "/srv/standby/drill",
    "-Fp", "-Xs", "-R", "--max-rate=100M",
  ]);
  assert.equal(wrapped.cmd, "docker");
  assert.deepStrictEqual(wrapped.args, [
    "exec", "-u", "postgres", "-e", "PGPASSFILE=/var/lib/postgresql/data/.pgpass", "myrmidon-pg-standby",
    "pg_basebackup",
    "-h", "127.0.0.1", "-p", "5432",
    "-U", "myr_replicator", "-D", "/srv/standby/drill",
    "-Fp", "-Xs", "-R", "--max-rate=100M",
  ]);
});

test("queryPrimaryLsn parses IDENTIFY_SYSTEM output", () => {
  const mockRunner = (cmd, args) => {
    if (cmd === "psql") {
      return {
        exitCode: 0,
        stdout: "729374172937|1|0/17FCA00|\n",
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: "" };
  };
  const res = queryPrimaryLsn({ host: "192.0.2.1", port: 15432, user: "myr_replicator" }, mockRunner);
  assert.equal(res.ok, true);
  assert.equal(res.lsn, "0/17FCA00");
});

test("queryPrimaryLsn handles failure", () => {
  const mockRunner = () => ({ exitCode: 2, stdout: "", stderr: "connection refused" });
  const res = queryPrimaryLsn({ host: "192.0.2.1", port: 15432 }, mockRunner);
  assert.equal(res.ok, false);
  assert.equal(res.lsn, null);
});

test("queryPrimaryLsn uses replication=database connection string", () => {
  const calls = [];
  const mockRunner = (cmd, args) => {
    calls.push({ cmd, args });
    return { exitCode: 0, stdout: "729374172937|1|0/17FCA00|\n", stderr: "" };
  };
  queryPrimaryLsn({ host: "192.0.2.1", port: 15432, user: "myr_replicator" }, mockRunner);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "psql");
  assert.ok(calls[0].args.includes("replication=database dbname=paperclip"));
  assert.ok(calls[0].args.includes("IDENTIFY_SYSTEM;"));
  assert.ok(calls[0].args.includes("myr_replicator"));
});

test("checkLag uses createPgRunner — docker mode wraps psql in docker exec", () => {
  const calls = [];
  const mockRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "docker") {
      // docker exec calls: simulate success with standby output
      return { exitCode: 0, stdout: "1|1/1000|1/1000|2026-10-31 12:00:00+00\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const res = checkLag("board", { pgRunner: "docker" }, { runner: mockRunner });
  assert.equal(res.success, true);

  // Verify that psql calls were wrapped in docker exec
  const dockerExecCalls = calls.filter((c) => c.cmd === "docker");
  assert.ok(dockerExecCalls.length >= 1, "At least one docker exec call was made");
  for (const call of dockerExecCalls) {
    assert.ok(call.args[0] === "exec", "docker command uses exec");
    assert.ok(call.args.includes("myrmidon-pg-standby"), "exec targets the standby container");
  }
});

test("checkLag uses createPgRunner — host mode passes psql directly", () => {
  const calls = [];
  const mockRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "psql") {
      return { exitCode: 0, stdout: "1|1/1000|1/1000|2026-10-31 12:00:00+00\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const res = checkLag("board", { pgRunner: "host" }, { runner: mockRunner });
  assert.equal(res.success, true);

  // In host mode, psql should be called directly (not wrapped in docker)
  const psqlCalls = calls.filter((c) => c.cmd === "psql");
  assert.ok(psqlCalls.length >= 1, "psql called directly in host mode");
  const dockerCalls = calls.filter((c) => c.cmd === "docker");
  assert.equal(dockerCalls.length, 0, "No docker exec calls in host mode");
});

test("checkLag primary LSN uses replication protocol (IDENTIFY_SYSTEM)", () => {
  const calls = [];
  const mockRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "docker") {
      // Check if this is an IDENTIFY_SYSTEM call
      const isIdentify = args.includes("IDENTIFY_SYSTEM;");
      if (isIdentify) {
        return { exitCode: 0, stdout: "729374172937|1|0/2000|\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "1|1/1000|1/1000|2026-10-31 12:00:00+00\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const res = checkLag("board", { pgRunner: "docker" }, { runner: mockRunner });
  assert.equal(res.success, true);
  assert.equal(res.primaryLsn, "0/2000");

  // Verify IDENTIFY_SYSTEM was called via replication protocol
  const identifyCalls = calls.filter(
    (c) => c.cmd === "docker" && c.args.includes("IDENTIFY_SYSTEM;")
  );
  assert.ok(identifyCalls.length >= 1, "IDENTIFY_SYSTEM was called");
  for (const call of identifyCalls) {
    assert.ok(call.args.includes("replication=database dbname=paperclip"), "Uses replication=database dbname=paperclip");
    assert.ok(call.args.includes("myr_replicator"), "Uses myr_replicator user");
  }
});

test("checkLag standby query goes to container port 5432 via docker exec", () => {
  const calls = [];
  const mockRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "docker") {
      // Check if this is a standby query (not IDENTIFY_SYSTEM)
      const isIdentify = args.includes("IDENTIFY_SYSTEM;");
      if (isIdentify) {
        return { exitCode: 0, stdout: "729374172937|1|0/2000|\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "1|1/1000|1/1000|2026-10-31 12:00:00+00\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const res = checkLag("board", { pgRunner: "docker" }, { runner: mockRunner });
  assert.equal(res.success, true);

  // Find the standby query call (has pg_is_in_recovery or pg_last_wal)
  const standbyCalls = calls.filter(
    (c) => c.cmd === "docker" && !c.args.includes("IDENTIFY_SYSTEM;")
  );
  assert.ok(standbyCalls.length >= 1, "Standby query was made");
  for (const call of standbyCalls) {
    const pIdx = call.args.indexOf("-p");
    assert.ok(pIdx !== -1, "Has -p flag");
    assert.equal(call.args[pIdx + 1], "5432", "Standby query uses container port 5432");
  }
});

test("executeRehearsal passes --max-rate=100M to pg_basebackup by default", () => {
  const calls = [];
  const mockFs = {
    mkdirSync: () => {},
    writeFileSync: () => {},
    existsSync: () => true,
    readFileSync: () => "",
    rmSync: () => {},
  };

  const mockRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "psql") {
      const sql = args[args.indexOf("-c") + 1] || "";
      if (sql.includes("pg_is_in_recovery")) return { exitCode: 0, stdout: "0\n", stderr: "" };
      if (sql.includes("SELECT 1;")) return { exitCode: 0, stdout: "1\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const res = executeRehearsal("board", { pgRunner: "host" }, { runner: mockRunner, fsOps: mockFs });
  assert.equal(res.success, true);

  const basebackupCall = calls.find((c) => c.cmd === "pg_basebackup");
  assert.ok(basebackupCall, "pg_basebackup was called");
  assert.ok(
    basebackupCall.args.includes("--max-rate=100M"),
    "Default --max-rate=100M passed to pg_basebackup"
  );
});

test("executeRehearsal respects explicit --max-rate override", () => {
  const calls = [];
  const mockFs = {
    mkdirSync: () => {},
    writeFileSync: () => {},
    existsSync: () => true,
    readFileSync: () => "",
    rmSync: () => {},
  };

  const mockRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "psql") {
      const sql = args[args.indexOf("-c") + 1] || "";
      if (sql.includes("pg_is_in_recovery")) return { exitCode: 0, stdout: "0\n", stderr: "" };
      if (sql.includes("SELECT 1;")) return { exitCode: 0, stdout: "1\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const res = executeRehearsal("board", { pgRunner: "host", maxRate: "50M" }, { runner: mockRunner, fsOps: mockFs });
  assert.equal(res.success, true);

  const basebackupCall = calls.find((c) => c.cmd === "pg_basebackup");
  assert.ok(basebackupCall, "pg_basebackup was called");
  assert.ok(
    basebackupCall.args.includes("--max-rate=50M"),
    "Explicit --max-rate=50M overrides default"
  );
  assert.ok(
    !basebackupCall.args.includes("--max-rate=100M"),
    "Default 100M not present when overridden"
  );
});

test("resolvePrimaryEndpoint falls back to env PRIMARY_PG_HOST/PRIMARY_PG_PORT", () => {
  const oldHost = process.env.PRIMARY_PG_HOST;
  const oldPort = process.env.PRIMARY_PG_PORT;
  process.env.PRIMARY_PG_HOST = "192.0.2.1";
  process.env.PRIMARY_PG_PORT = "15432";
  try {
    const ep = resolvePrimaryEndpoint({}, "board", {});
    assert.equal(ep.host, "192.0.2.1");
    assert.equal(ep.port, 15432);
  } finally {
    if (oldHost === undefined) delete process.env.PRIMARY_PG_HOST; else process.env.PRIMARY_PG_HOST = oldHost;
    if (oldPort === undefined) delete process.env.PRIMARY_PG_PORT; else process.env.PRIMARY_PG_PORT = oldPort;
  }
});

test("resolvePrimaryEndpoint auto-detects from standby primary_conninfo when env absent", () => {
  const oldHost = process.env.PRIMARY_PG_HOST;
  const oldPort = process.env.PRIMARY_PG_PORT;
  delete process.env.PRIMARY_PG_HOST;
  delete process.env.PRIMARY_PG_PORT;
  try {
    const mockRunner = (cmd, args) => {
      if (cmd === "psql") {
        const sql = args[args.indexOf("-c") + 1] || "";
        if (sql.includes("SHOW primary_conninfo")) {
          return { exitCode: 0, stdout: "host=192.0.2.1 port=15432 user=myr_replicator\n", stderr: "" };
        }
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    };
    const ep = resolvePrimaryEndpoint({}, "board", { runner: mockRunner });
    assert.equal(ep.host, "192.0.2.1");
    assert.equal(ep.port, 15432);
  } finally {
    if (oldHost !== undefined) process.env.PRIMARY_PG_HOST = oldHost;
    if (oldPort !== undefined) process.env.PRIMARY_PG_PORT = oldPort;
  }
});

test("planRehearsal default drillDir is in-container path", () => {
  const plan = planRehearsal("board", {});
  assert.equal(plan.drillDir, "/var/lib/postgresql/drill-cluster");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// OPE-7656 review fixes (ADM review of PR #2029)
// ═══════════════════════════════════════════════════════════════════════════════════════════

const psqlCalls = (w) =>
  w.events.filter(isPsqlEvent).map((e) => {
    const u = unwrap(e.cmd, e.args);
    return { args: u.args, sql: sqlOf(u.args), host: hostOf(u.args), port: portOf(u.args), user: userOf(u.args), db: dbOf(u.args) };
  });
const firstPsqlIdx = (w, needle) => w.indexOf((e) => isPsqlEvent(e) && sqlOf(unwrap(e.cmd, e.args).args).includes(needle));

// ── Finding 1: real PostgreSQL booleans ──────────────────────────────────────────────────────

test("parsePgBool understands what psql really prints (::int, bare boolean, ::text)", () => {
  for (const v of ["1", "t", "true", " 1 ", "TRUE"]) assert.equal(parsePgBool(v), true, v);
  for (const v of ["0", "f", "false", " 0\n", "FALSE"]) assert.equal(parsePgBool(v), false, v);
  for (const v of ["", "maybe", "2", null, undefined]) assert.equal(parsePgBool(v), null, String(v));
  assert.equal(firstField("1|0/17FCA00|x\n"), "1");
  assert.equal(SQL_IN_RECOVERY, "SELECT pg_is_in_recovery()::int;");
});

test("role is read as ::int everywhere and real '1'/'0' answers drive failover, switchback and setup", () => {
  // The world answers like real PostgreSQL: "1"/"0" for ::int; ::text would have printed "true"/"false"
  // which the old code compared against "t"/"f" (switchback refused at step 1, the failover guard
  // read every answer as "not t").
  const checks = [];
  const fsFor = () => makeFs({ entries: ["PG_VERSION", "standby.signal"] });

  const w1 = makeWorld({ primary: "in_recovery" });
  checks.push(["failover", w1, executeFailover("board", { pgRunner: "host", verifyDelayMs: 0, ...PRIMARY }, { runner: w1.runner })]);

  const w2 = makeWorld({ primary: "writable" });
  checks.push([
    "switchback",
    w2,
    executeSwitchback("board", { pgRunner: "host", force: true, readinessDelayMs: 0, ...PRIMARY }, { runner: w2.runner, fsOps: fsFor().fsOps }),
  ]);

  const w3 = makeWorld();
  checks.push([
    "setup",
    w3,
    setupStandby("board", { pgRunner: "host", force: true, readinessDelayMs: 0, ...PRIMARY }, { runner: w3.runner, fsOps: fsFor().fsOps }),
  ]);

  const w4 = makeWorld();
  checks.push(["check-lag", w4, checkLag("board", { pgRunner: "host", ...PRIMARY }, { runner: w4.runner })]);

  for (const [name, w, res] of checks) {
    assert.equal(res.success, true, `${name}: ${res.error}`);
    const sql = psqlCalls(w).map((c) => c.sql);
    assert.ok(sql.every((s) => !/pg_is_in_recovery\(\)::text/.test(s)), `${name}: no ::text boolean query`);
  }
  assert.ok(psqlCalls(w2).some((c) => c.sql === SQL_IN_RECOVERY), "switchback probes the primary with the ::int helper");
});

test("switchback refuses a primary that is in recovery (real answer '1') or unreachable, before touching anything", () => {
  for (const primary of ["in_recovery", "unreachable", "auth_error"]) {
    const w = makeWorld({ primary });
    const { fsOps, state } = makeFs({ entries: ["PG_VERSION"] });
    const res = executeSwitchback("board", { pgRunner: "host", force: true, ...PRIMARY }, { runner: w.runner, fsOps });
    assert.equal(res.success, false, primary);
    assert.match(res.error, /Original primary is not an active primary/, primary);
    assert.equal(state.rms.length, 0, primary);
    assert.equal(w.events.some(isComposeStop), false, primary);
  }
});

// ── Finding 2: failover split-brain guard ────────────────────────────────────────────────────

test("failover guard: reachable WRITABLE primary -> refuse, nothing promoted", () => {
  const w = makeWorld({ primary: "writable" });
  const res = executeFailover("board", { pgRunner: "host", fenced: true, ...PRIMARY }, { runner: w.runner });
  assert.equal(res.success, false);
  assert.equal(res.promoted, false);
  assert.equal(res.guard.state, "writable");
  assert.match(res.error, /reachable and accepts writes/);
  assert.equal(w.events.some(isPromote), false);
});

test("failover guard: AUTH error from the primary does NOT mean 'down' -> refuse, nothing promoted", () => {
  const w = makeWorld({ primary: "auth_error" });
  // Even with --fenced: an authentication error proves the primary answered, i.e. it is alive.
  const res = executeFailover("board", { pgRunner: "host", fenced: true, ...PRIMARY }, { runner: w.runner });
  assert.equal(res.success, false);
  assert.equal(res.guard.state, "probe_error");
  assert.match(res.error, /could not determine the state of the original primary/);
  assert.match(res.error, /password authentication failed/);
  assert.equal(w.events.some(isPromote), false);
});

test("failover guard: unparseable answers and tool-level timeouts also block", () => {
  for (const primary of ["garbage", "tool_timeout"]) {
    const w = makeWorld({ primary });
    const res = executeFailover("board", { pgRunner: "host", fenced: true, ...PRIMARY }, { runner: w.runner });
    assert.equal(res.success, false, primary);
    assert.equal(res.guard.state, "probe_error", primary);
    assert.equal(w.events.some(isPromote), false, primary);
  }
});

test("failover guard: docker exec failing (standby container down) is an error, not 'primary down'", () => {
  const w = makeWorld({ primary: "writable", containerRunning: false });
  // The probe runs inside the standby container; with the container stopped docker answers with an error.
  const runner = (cmd, args, ro) => {
    if (cmd === "docker" && args[0] === "exec") return { exitCode: 1, stdout: "", stderr: NO_CONTAINER };
    return w.runner(cmd, args, ro);
  };
  const res = executeFailover("board", { pgRunner: "docker", fenced: true, ...PRIMARY }, { runner });
  assert.equal(res.success, false);
  assert.equal(res.guard.state, "probe_error");
});

test("failover guard: UNREACHABLE primary without --fenced -> refuse with fencing instructions", () => {
  for (const primary of ["unreachable", "timeout"]) {
    const w = makeWorld({ primary });
    const res = executeFailover("board", { pgRunner: "host", ...PRIMARY }, { runner: w.runner });
    assert.equal(res.success, false, primary);
    assert.equal(res.promoted, false, primary);
    assert.equal(res.guard.state, "unreachable_unfenced", primary);
    assert.match(res.error, /--fenced/, primary);
    assert.match(res.error, /split-brain/, primary);
    assert.equal(w.events.some(isPromote), false, primary);
  }
});

test("failover guard: UNREACHABLE primary + --fenced -> promotes and records the fencing evidence", () => {
  const w = makeWorld({ primary: "unreachable" });
  const res = executeFailover("board", { pgRunner: "host", fenced: true, verifyDelayMs: 0, ...PRIMARY }, { runner: w.runner });
  assert.equal(res.success, true, res.error);
  assert.equal(res.promoted, true);
  assert.equal(res.guard.state, "unreachable_fenced");
  assert.equal(res.guard.fencing, "operator_confirmed");
  assert.equal(w.events.some(isPromote), true);

  const w2 = makeWorld({ primary: "unreachable" });
  const res2 = executeFailover(
    "board",
    { pgRunner: "host", fenced: "hypervisor poweroff vm-core 10:00", verifyDelayMs: 0, ...PRIMARY },
    { runner: w2.runner }
  );
  assert.equal(res2.guard.fencing, "hypervisor poweroff vm-core 10:00");
});

test("failover guard: a primary that answers and is IN RECOVERY is not a writer -> promote without --fenced", () => {
  const w = makeWorld({ primary: "in_recovery" });
  const res = executeFailover("board", { pgRunner: "host", verifyDelayMs: 0, ...PRIMARY }, { runner: w.runner });
  assert.equal(res.success, true, res.error);
  assert.equal(res.guard.state, "in_recovery");
});

test("failover guard probes with the REPLICATOR over the replication protocol at the resolved live endpoint", () => {
  // No --primary-host: the endpoint must come from the standby's primary_conninfo (live relay 15432),
  // not from the compile-time default primary.internal:5432.
  const w = makeWorld({ primary: "unreachable" });
  const res = executeFailover("board", { pgRunner: "host", fenced: true, verifyDelayMs: 0 }, { runner: w.runner });
  assert.equal(res.success, true, res.error);
  assert.equal(res.guard.primary, "192.0.2.1:15432");
  assert.equal(res.guard.primarySource, "conninfo");

  const toPrimary = psqlCalls(w).filter((c) => c.host === "192.0.2.1");
  assert.ok(toPrimary.length >= 1);
  for (const c of toPrimary) {
    assert.equal(c.port, "15432");
    assert.equal(c.user, "myr_replicator", "never the application role: the passfile only has the replicator");
    assert.match(c.db, /^replication=database dbname=paperclip connect_timeout=\d+$/);
  }
  assert.ok(!psqlCalls(w).some((c) => c.host === "primary.internal"), "compile-time default endpoint is not used");
});

test("failover guard blocks when the primary endpoint cannot be determined (fail closed)", () => {
  const oldHost = process.env.PRIMARY_PG_HOST;
  delete process.env.PRIMARY_PG_HOST;
  try {
    const w = makeWorld({ primary: "unreachable", conninfo: "" });
    const res = executeFailover("board", { pgRunner: "host", fenced: true }, { runner: w.runner });
    assert.equal(res.success, false);
    assert.equal(res.guard.state, "endpoint_unknown");
    assert.match(res.error, /cannot determine where the original primary is/);
    assert.equal(w.events.some(isPromote), false);
  } finally {
    if (oldHost !== undefined) process.env.PRIMARY_PG_HOST = oldHost;
  }
});

test("failover --accept-split-brain bypasses the guard (and is reported)", () => {
  const w = makeWorld({ primary: "writable" });
  const res = executeFailover("board", { pgRunner: "host", acceptSplitBrain: true, verifyDelayMs: 0, ...PRIMARY }, { runner: w.runner });
  assert.equal(res.success, true, res.error);
  assert.equal(res.guard.state, "override");
  assert.match(res.guard.note, /accept-split-brain/);
  // No probe query was sent to the primary at all.
  assert.equal(psqlCalls(w).some((c) => c.host === "192.0.2.1"), false);
});

test("classifyPsqlFailure separates 'no network answer' from 'the server answered with an error'", () => {
  assert.equal(classifyPsqlFailure({ stderr: CONN_REFUSED }), "unreachable");
  assert.equal(classifyPsqlFailure({ stderr: CONN_TIMEOUT }), "unreachable");
  assert.equal(
    classifyPsqlFailure({ stderr: 'psql: error: could not translate host name "primary.internal" to address: Name or service not known' }),
    "unreachable"
  );
  assert.equal(
    classifyPsqlFailure({ stderr: "psql: error: connection to server at \"x\", port 15432 failed: server closed the connection unexpectedly" }),
    "unreachable"
  );
  assert.equal(classifyPsqlFailure({ stderr: AUTH_FAILED }), "error");
  assert.equal(classifyPsqlFailure({ stderr: "psql: error: connection to server failed: FATAL:  no pg_hba.conf entry for host" }), "error");
  assert.equal(classifyPsqlFailure({ stderr: "ERROR:  permission denied for function pg_promote" }), "error");
  assert.equal(classifyPsqlFailure({ stderr: NO_CONTAINER }), "error");
  assert.equal(classifyPsqlFailure({ stderr: "Error: spawnSync docker ETIMEDOUT" }), "error");
  assert.equal(classifyPsqlFailure({ stderr: "something odd" }), "error");
});

test("runCli maps --accept-split-brain / --fenced / --primary-host and does not let --fenced swallow the target", () => {
  const w = makeWorld({ primary: "writable" });
  // --accept-split-brain -> promotes even though the primary is writable
  assert.equal(runCli(["failover", "board", "--accept-split-brain", "--pg-runner=host", "--primary-host=192.0.2.1", "--primary-port=15432"], {}, { runner: w.runner }), 0);
  assert.equal(w.events.some(isPromote), true);
  const probe = psqlCalls(w).filter((c) => c.host === "192.0.2.1");
  assert.equal(probe.length, 0, "bypass sends no probe");

  // --fenced placed BEFORE the target must not consume it as its value
  const w2 = makeWorld({ primary: "unreachable" });
  assert.equal(runCli(["failover", "--fenced", "board", "--pg-runner=host", "--primary-host=192.0.2.1", "--primary-port=15432"], {}, { runner: w2.runner }), 0);
  assert.equal(w2.events.some(isPromote), true);

  // --primary-host / --primary-port reach the probe
  const w3 = makeWorld({ primary: "unreachable" });
  assert.equal(runCli(["failover", "board", "--pg-runner=host", "--primary-host=198.51.100.7", "--primary-port=16000"], {}, { runner: w3.runner }), 1);
  const p = psqlCalls(w3).find((c) => c.host === "198.51.100.7");
  assert.ok(p && p.port === "16000");
});

// ── Finding 3: docker-mode failover paths and honest outcomes ────────────────────────────────

test("failover in docker mode promotes with the IN-CONTAINER data dir, never the host path", () => {
  const w = makeWorld({ primary: "unreachable" });
  const res = executeFailover(
    "board",
    { pgRunner: "docker", fenced: true, verifyDelayMs: 0, dataDir: "/srv/standby/myrmidon-pg/data", ...PRIMARY },
    { runner: w.runner }
  );
  assert.equal(res.success, true, res.error);
  const call = w.calls.find((c) => c.cmd === "docker" && c.args.includes("/usr/lib/postgresql/18/bin/pg_ctl"));
  assert.ok(call, "pg_ctl ran through docker exec");
  assert.deepStrictEqual(call.args.slice(call.args.indexOf("promote")), ["promote", "-D", "/var/lib/postgresql/data"]);
  assert.ok(!call.args.includes("/srv/standby/myrmidon-pg/data"));
  assert.equal(res.promoteMethod, "pg_ctl");
});

test("failover in host mode promotes with the host data dir (--data-dir)", () => {
  const w = makeWorld({ primary: "unreachable" });
  const code = runCli(["failover", "board", "--pg-runner=host", "--fenced", "--data-dir=/data/pg", "--primary-host=192.0.2.1", "--primary-port=15432"], {}, { runner: w.runner });
  assert.equal(code, 0);
  const call = w.calls.find((c) => c.cmd === "pg_ctl");
  assert.deepStrictEqual(call.args, ["promote", "-D", "/data/pg"]);
});

test("failover falls back to SQL pg_promote() when pg_ctl fails, and reports both failures if both fail", () => {
  const w = makeWorld({ primary: "unreachable", pgCtlPromoteOk: false });
  const res = executeFailover("board", { pgRunner: "docker", fenced: true, verifyDelayMs: 0, ...PRIMARY }, { runner: w.runner });
  assert.equal(res.success, true, res.error);
  assert.equal(res.promoteMethod, "pg_promote");

  const w2 = makeWorld({ primary: "unreachable", pgCtlPromoteOk: false, pgPromoteSqlOk: false });
  const res2 = executeFailover("board", { pgRunner: "docker", fenced: true, verifyDelayMs: 0, ...PRIMARY }, { runner: w2.runner });
  assert.equal(res2.success, false);
  assert.equal(res2.promoted, false);
  assert.match(res2.error, /pg_ctl promote -D \/var\/lib\/postgresql\/data \(in container myrmidon-pg-standby\)/);
  assert.match(res2.error, /permission denied for function pg_promote/);
});

test("failover reports appSwitched/healthOk as null (skipped) unless requested, never true", () => {
  const w = makeWorld({ primary: "unreachable" });
  const res = executeFailover("board", { pgRunner: "docker", fenced: true, verifyDelayMs: 0, ...PRIMARY }, { runner: w.runner });
  assert.equal(res.success, true);
  assert.equal(res.promoted, true);
  assert.equal(res.appSwitched, null);
  assert.equal(res.healthOk, null);
  assert.match(res.appSwitchNote, /not requested/);
  assert.match(res.healthNote, /not checked/);
  assert.equal(w.calls.some((c) => c.cmd === "curl"), false);
  assert.equal(w.calls.some((c) => c.cmd === "docker" && c.args[0] === "compose"), false);
});

test("failover --restart-app: real compose outcome, requires the production compose file", () => {
  // no compose file -> not switched (false), command fails, but the promotion is still reported
  const w = makeWorld({ primary: "unreachable" });
  const res = executeFailover("board", { pgRunner: "docker", fenced: true, restartApp: true, verifyDelayMs: 0, ...PRIMARY }, { runner: w.runner });
  assert.equal(res.promoted, true);
  assert.equal(res.appSwitched, false);
  assert.equal(res.success, false);
  assert.match(res.appSwitchNote, /--app-compose-file/);
  assert.equal(w.calls.some((c) => c.args.includes("--force-recreate")), false, "never guesses a compose file from the cwd");

  // compose fails -> false
  const w2 = makeWorld({ primary: "unreachable", composeFailPattern: "--force-recreate" });
  const res2 = executeFailover(
    "board",
    { pgRunner: "docker", fenced: true, restartApp: true, appComposeFile: "/opt/app/compose.yml", appService: "board", verifyDelayMs: 0, ...PRIMARY },
    { runner: w2.runner }
  );
  assert.equal(res2.appSwitched, false);
  assert.equal(res2.success, false);

  // compose ok -> true, with the chosen file and service
  const w3 = makeWorld({ primary: "unreachable" });
  const res3 = executeFailover(
    "board",
    { pgRunner: "docker", fenced: true, restartApp: true, appComposeFile: "/opt/app/compose.yml", appService: "board", verifyDelayMs: 0, ...PRIMARY },
    { runner: w3.runner }
  );
  assert.equal(res3.appSwitched, true);
  assert.equal(res3.success, true);
  const c = w3.calls.find((x) => x.args.includes("--force-recreate"));
  assert.deepStrictEqual(c.args, ["compose", "-f", "/opt/app/compose.yml", "up", "-d", "--force-recreate", "board"]);
});

test("failover --check-health: healthOk reflects the real curl exit code and honours --health-url", () => {
  const w = makeWorld({ primary: "unreachable", curlOk: false });
  const res = executeFailover(
    "board",
    { pgRunner: "docker", fenced: true, checkHealth: true, healthUrl: "http://127.0.0.1:3100/api/health", verifyDelayMs: 0, ...PRIMARY },
    { runner: w.runner }
  );
  assert.equal(res.promoted, true);
  assert.equal(res.healthOk, false);
  assert.equal(res.success, false);
  const curl = w.calls.find((c) => c.cmd === "curl");
  assert.ok(curl.args.includes("http://127.0.0.1:3100/api/health"));

  const w2 = makeWorld({ primary: "unreachable", curlOk: true });
  const res2 = executeFailover("board", { pgRunner: "docker", fenced: true, checkHealth: true, verifyDelayMs: 0, ...PRIMARY }, { runner: w2.runner });
  assert.equal(res2.healthOk, true);
  assert.equal(res2.success, true);
});

test("runCli maps --restart-app, --app-compose-file, --app-service, --check-health, --health-url", () => {
  const w = makeWorld({ primary: "unreachable" });
  const code = runCli(
    [
      "failover", "board", "--pg-runner=docker", "--fenced", "--primary-host=192.0.2.1", "--primary-port=15432",
      "--restart-app", "--app-compose-file=/opt/app/compose.yml", "--app-service=board",
      "--check-health", "--health-url=http://127.0.0.1:3100/api/health",
    ],
    {},
    { runner: w.runner }
  );
  assert.equal(code, 0);
  assert.ok(w.calls.some((c) => c.cmd === "docker" && c.args.join(" ") === "compose -f /opt/app/compose.yml up -d --force-recreate board"));
  assert.ok(w.calls.some((c) => c.cmd === "curl" && c.args.includes("http://127.0.0.1:3100/api/health")));
});

// ── Finding 4: no wipe before checks; promoted-standby guard; docker-mode basebackup ─────────

test("compareTimelines: a higher timeline (or LSN) on the standby means it holds history the primary lacks", () => {
  assert.equal(compareTimelines({ primary: { timeline: 1, lsn: "1/100" }, standby: { timeline: 2, lsn: "0/10" } }).verdict, "standby_ahead");
  assert.equal(compareTimelines({ primary: { timeline: 3, lsn: "1/100" }, standby: { timeline: 2, lsn: "9/10" } }).verdict, "primary_ahead");
  assert.equal(compareTimelines({ primary: { timeline: 2, lsn: "1/100" }, standby: { timeline: 2, lsn: "1/200" } }).verdict, "standby_ahead");
  assert.equal(compareTimelines({ primary: { timeline: 2, lsn: "1/200" }, standby: { timeline: 2, lsn: "1/100" } }).verdict, "primary_ahead");
  assert.equal(compareTimelines({ primary: { timeline: 2, lsn: "1/200" }, standby: { timeline: 2, lsn: "1/200" } }).verdict, "equal");
  assert.equal(compareTimelines({ primary: {}, standby: { timeline: 2 } }).verdict, "unknown");
});

test("every check runs BEFORE the container is stopped and the data directory is wiped (switchback)", () => {
  const events = [];
  const w = makeWorld({ events });
  const { fsOps, state } = makeFs({ events, entries: ["PG_VERSION", "base", "standby.signal"] });

  const res = executeSwitchback("board", { pgRunner: "host", force: true, readinessDelayMs: 0, ...PRIMARY }, { runner: w.runner, fsOps });
  assert.equal(res.success, true, res.error);

  const stopIdx = w.indexOf(isComposeStop);
  assert.ok(stopIdx > 0);
  for (const needle of [SQL_IN_RECOVERY, "max_slot_wal_keep_size", "pg_create_physical_replication_slot", "IDENTIFY_SYSTEM"]) {
    const idx = firstPsqlIdx(w, needle);
    assert.ok(idx >= 0 && idx < stopIdx, `${needle} checked before stop`);
  }
  const firstRm = events.findIndex((e) => e.kind === "fs" && e.op === "rm");
  const basebackup = w.indexOf(isBasebackup);
  assert.ok(firstRm > stopIdx, "wipe happens after the stop");
  assert.ok(basebackup > firstRm, "basebackup after the wipe");
  assert.equal(state.rms.length, 3);
});

test("prerequisite failures leave the standby untouched (no stop, no wipe): credentials, WAL policy, slot", () => {
  const entries = ["PG_VERSION", "base", "standby.signal"];

  // credentials missing: no password, no passfile
  {
    const w = makeWorld();
    const { fsOps, state } = makeFs({ entries, missing: ["/srv/standby/myrmidon-pg/.pgpass"] });
    const res = setupStandby("board", { pgRunner: "host", force: true, ...PRIMARY }, { runner: w.runner, fsOps });
    assert.equal(res.success, false);
    assert.match(res.error, /Replication credentials missing/);
    assert.equal(state.rms.length, 0);
    assert.equal(w.events.some(isComposeStop), false);
    assert.equal(w.calls.length, 0, "not even a query is sent");
  }
  // unbounded WAL retention
  {
    const w = makeWorld({ walPolicyOk: false });
    const { fsOps, state } = makeFs({ entries });
    const res = setupStandby("board", { pgRunner: "host", force: true, ...PRIMARY }, { runner: w.runner, fsOps });
    assert.equal(res.success, false);
    assert.match(res.error, /max_slot_wal_keep_size/);
    assert.equal(state.rms.length, 0);
    assert.equal(w.events.some(isComposeStop), false);
  }
  // slot cannot be created
  {
    const w = makeWorld({ slotOk: false });
    const { fsOps, state } = makeFs({ entries });
    const res = setupStandby("board", { pgRunner: "host", force: true, ...PRIMARY }, { runner: w.runner, fsOps });
    assert.equal(res.success, false);
    assert.match(res.error, /replication slot/);
    assert.equal(state.rms.length, 0);
    assert.equal(w.events.some(isComposeStop), false);
  }
  // primary unreachable
  {
    const w = makeWorld({ primary: "unreachable" });
    const { fsOps, state } = makeFs({ entries });
    const res = setupStandby("board", { pgRunner: "host", force: true, ...PRIMARY }, { runner: w.runner, fsOps });
    assert.equal(res.success, false);
    assert.equal(state.rms.length, 0);
    assert.equal(w.events.some(isComposeStop), false);
  }
});

test("setup --force refuses to wipe a PROMOTED standby (not in recovery) and reports the timeline/LSN comparison", () => {
  const w = makeWorld({ standbyInRecovery: false, standbyTimeline: 2, standbyLsn: "1/3000000", primaryTimeline: 1 });
  const { fsOps, state } = makeFs({ entries: ["PG_VERSION", "base"] });

  const res = setupStandby("board", { pgRunner: "host", force: true, ...PRIMARY }, { runner: w.runner, fsOps });
  assert.equal(res.success, false);
  assert.equal(res.standbyRole, "promoted");
  assert.equal(res.comparison.verdict, "standby_ahead");
  assert.equal(res.comparison.standbyTimeline, 2);
  assert.equal(res.comparison.primaryTimeline, 1);
  assert.match(res.error, /promoted writer/);
  assert.match(res.error, /--discard-promoted-standby/);
  assert.equal(state.rms.length, 0);
  assert.equal(w.events.some(isComposeStop), false);
  assert.equal(w.events.some(isBasebackup), false);
});

test("--discard-promoted-standby wipes a promoted standby only after all checks, with the comparison recorded", () => {
  const events = [];
  const w = makeWorld({ events, standbyInRecovery: false, standbyTimeline: 2, primaryTimeline: 1 });
  const { fsOps, state } = makeFs({ events, entries: ["PG_VERSION", "base"] });

  const res = setupStandby(
    "board",
    { pgRunner: "host", force: true, discardPromotedStandby: true, acceptDataLoss: true, readinessDelayMs: 0, ...PRIMARY },
    { runner: w.runner, fsOps }
  );
  assert.equal(res.success, true, res.error);
  assert.equal(res.promotedStandbyDiscarded, true);
  assert.equal(res.previousStandbyRole, "promoted");
  assert.equal(res.comparison.verdict, "standby_ahead", "the lost-history evidence is returned for the worklog");
  assert.equal(res.comparison.standbyTimeline, 2);
  assert.equal(state.rms.length, 2, "data wiped only because the flag was given");
  const stopIdx = w.indexOf(isComposeStop);
  assert.ok(stopIdx > firstPsqlIdx(w, "IDENTIFY_SYSTEM"));
  assert.ok(events.findIndex((e) => e.kind === "fs" && e.op === "rm") > stopIdx);
});

test("with the container down, the role comes from the data directory: no standby.signal = promoted", () => {
  // Container stopped: every standby query fails, so the guard must fall back to the files.
  const promotedDir = makeFs({ entries: ["PG_VERSION", "base"] }); // no standby.signal
  const w = makeWorld({ containerRunning: false });
  const res = setupStandby("board", { pgRunner: "host", force: true, ...PRIMARY }, { runner: w.runner, fsOps: promotedDir.fsOps });
  assert.equal(res.success, false);
  assert.equal(res.standbyRole, "promoted");
  assert.equal(promotedDir.state.rms.length, 0);

  const standbyDir = makeFs({ entries: ["PG_VERSION", "base", "standby.signal"] });
  const w2 = makeWorld({ containerRunning: false });
  const res2 = setupStandby("board", { pgRunner: "host", force: true, readinessDelayMs: 0, readinessAttempts: 1, ...PRIMARY }, { runner: w2.runner, fsOps: standbyDir.fsOps });
  assert.equal(res2.success, true, res2.error);
  assert.equal(standbyDir.state.rms.length, 3, "a stopped real standby may be re-synced without the discard flag");
});

test("a failed stop leaves the data directory untouched; an incomplete wipe aborts before the basebackup", () => {
  const w = makeWorld({ composeStopOk: false });
  const a = makeFs({ entries: ["PG_VERSION", "standby.signal"] });
  const stopFail = setupStandby("board", { pgRunner: "host", force: true, ...PRIMARY }, { runner: w.runner, fsOps: a.fsOps });
  assert.equal(stopFail.success, false);
  assert.match(stopFail.error, /Failed to stop standby container/);
  assert.equal(a.state.rms.length, 0);
  assert.equal(w.events.some(isBasebackup), false);

  const w2 = makeWorld();
  const b = makeFs({ entries: ["PG_VERSION", "standby.signal"], rmFails: true });
  const wipeFail = setupStandby("board", { pgRunner: "host", force: true, ...PRIMARY }, { runner: w2.runner, fsOps: b.fsOps });
  assert.equal(wipeFail.success, false);
  assert.match(wipeFail.error, /Could not empty/);
  assert.equal(w2.events.some(isBasebackup), false);
});

test("switchback keeps the live primary endpoint (relay) in the regenerated primary_conninfo", () => {
  const w = makeWorld({ primary: "writable" });
  const { fsOps, state } = makeFs({ entries: ["PG_VERSION", "standby.signal"] });
  // no --primary-host: endpoint comes from the standby's primary_conninfo
  const res = executeSwitchback("board", { pgRunner: "host", force: true, readinessDelayMs: 0 }, { runner: w.runner, fsOps });
  assert.equal(res.success, true, res.error);
  const autoConf = state.writes.find((f) => f.file.endsWith("postgresql.auto.conf"));
  assert.match(autoConf.content, /primary_conninfo = 'host=192\.0\.2\.1 port=15432 user=myr_replicator/);
  assert.doesNotMatch(autoConf.content, /primary\.internal/);
});

test("docker mode: base backup runs in a one-shot container with IN-CONTAINER paths, files owned by uid 999", () => {
  const events = [];
  const w = makeWorld({ events });
  const { fsOps, state, dataDir } = makeFs({ events, entries: ["PG_VERSION", "base", "standby.signal", "postgresql.auto.conf"] });

  const res = executeSwitchback(
    "board",
    { pgRunner: "docker", force: true, replicatorPassword: "dummy-pw", readinessDelayMs: 0, ...PRIMARY },
    { runner: w.runner, fsOps }
  );
  assert.equal(res.success, true, res.error);

  // basebackup: compose run, as postgres, in-container -D, staged passfile mounted read-only
  const run = w.calls.find((c) => unwrapOneShot(c.cmd, c.args)?.tool === "pg_basebackup");
  assert.ok(run, "base backup ran through a one-shot container");
  const a = run.args;
  assert.deepStrictEqual(a.slice(0, 4), ["compose", "-f", DEFAULT_COMPOSE_FILE, "run"]);
  assert.ok(a.includes("--rm") && a.includes("--no-deps"));
  assert.deepStrictEqual(a.slice(a.indexOf("-u"), a.indexOf("-u") + 2), ["-u", "postgres"]);
  assert.ok(a.includes("PGPASSFILE=/run/standby/pgpass"));
  assert.ok(a.includes("/srv/standby/myrmidon-pg/.pgpass:/run/standby/pgpass:ro"));
  assert.equal(a[a.indexOf("-D") + 1], "/var/lib/postgresql/data", "in-container PGDATA, not the host path");
  assert.ok(!a.includes(dataDir), "the host data dir is never handed to pg_basebackup");
  // ...and NOT a docker exec into the (stopped) standby container
  assert.equal(w.calls.some((c) => c.cmd === "docker" && c.args[0] === "exec" && c.args.includes("pg_basebackup")), false);

  // ownership: data dir, staged passfile and the in-data .pgpass belong to uid/gid 999
  const owned = new Map(state.chowns.map((c) => [c.path, `${c.uid}:${c.gid}`]));
  assert.equal(owned.get(dataDir), "999:999");
  assert.equal(owned.get("/srv/standby/myrmidon-pg/.pgpass"), "999:999");
  assert.equal(owned.get(`${dataDir}/.pgpass`), "999:999");

  // the restarted standby keeps the live relay endpoint
  const autoConf = state.writes.find((f) => f.file.endsWith("postgresql.auto.conf"));
  assert.match(autoConf.content, /host=192\.0\.2\.1 port=15432/);
});

test("docker mode: if the passfile cannot be given to uid 999, nothing is stopped or wiped", () => {
  const w = makeWorld();
  const { fsOps, state } = makeFs({ entries: ["PG_VERSION", "standby.signal"], chownFails: true });
  const res = setupStandby("board", { pgRunner: "docker", force: true, replicatorPassword: "pw", ...PRIMARY }, { runner: w.runner, fsOps });
  assert.equal(res.success, false);
  assert.match(res.error, /Cannot give the staged passfile/);
  assert.equal(state.rms.length, 0);
  assert.equal(w.events.some(isComposeStop), false);

  // .pgpass inside the data dir not chown-able -> explicit error instead of a standby that cannot authenticate
  const w2 = makeWorld();
  const b = makeFs({ entries: ["PG_VERSION", "standby.signal"], chownFails: (p) => p.endsWith("/data/.pgpass") });
  const res2 = setupStandby("board", { pgRunner: "docker", force: true, replicatorPassword: "pw", ...PRIMARY }, { runner: w2.runner, fsOps: b.fsOps });
  assert.equal(res2.success, false);
  assert.match(res2.error, /must be owned by uid 999/);
});

test("docker mode, first setup (no standby container yet): preflight falls back to a one-shot container", () => {
  const w = makeWorld({ containerRunning: false });
  const { fsOps } = makeFs({ dataDirExists: false });
  const res = setupStandby("board", { pgRunner: "docker", replicatorPassword: "pw", readinessDelayMs: 0, ...PRIMARY }, { runner: w.runner, fsOps });
  assert.equal(res.success, true, res.error);
  const oneShotPsql = w.calls.filter((c) => unwrapOneShot(c.cmd, c.args)?.tool === "psql");
  assert.ok(oneShotPsql.length >= 2, "WAL-policy and slot queries ran in a one-shot container");
  assert.ok(w.calls.some((c) => unwrapOneShot(c.cmd, c.args)?.tool === "pg_basebackup"));
  // no stop/wipe on an empty directory
  assert.equal(w.events.some(isComposeStop), false);
});

test("dockerOneShotArgs maps pg_ctl-style binaries and mounts the passfile read-only", () => {
  const a = dockerOneShotArgs(
    { composeFile: "/c.yml", service: "svc", hostPassfile: "/h/.pgpass", containerPassfile: "/run/standby/pgpass" },
    "pg_basebackup",
    ["-h", "x"]
  );
  assert.deepStrictEqual(a, [
    "compose", "-f", "/c.yml", "run", "--rm", "--no-deps", "-T", "-u", "postgres",
    "-e", "PGPASSFILE=/run/standby/pgpass", "-v", "/h/.pgpass:/run/standby/pgpass:ro",
    "--entrypoint", "pg_basebackup", "svc", "-h", "x",
  ]);
});

// ── Finding 5: rehearse cleanup, drill board, networking ─────────────────────────────────────

test("validateDrillDir refuses anything that could make rm -rf hit real data", () => {
  assert.equal(validateDrillDir("/var/lib/postgresql/drill-cluster", { pgRunner: "docker" }), null);
  // a host path is fine in host mode; in docker mode it is a compose bind-mount point (rm -rf -> EBUSY)
  assert.equal(validateDrillDir("/srv/standby/drill-cluster", { pgRunner: "host" }), null);
  assert.notEqual(validateDrillDir("/srv/standby/drill-cluster", { pgRunner: "docker" }), null);
  for (const bad of [
    "/", "/var", "/var/lib/postgresql", "/var/lib/postgresql/data", "/var/lib/postgresql/data/drill",
    "/srv/standby/myrmidon-pg/data", "/srv/standby", "drill-cluster", "./drill", "/tmp/drill", "/var/lib/postgresql/cluster",
    "/srv/backups/wal/myrmidon-pg", "/srv/backups/wal/myrmidon-pg/drill",
  ]) {
    assert.notEqual(validateDrillDir(bad, { pgRunner: "docker" }), null, bad);
  }
});

test("rehearse in docker mode: snapshot, drill, cleanup all in the container; host filesystem never touched", () => {
  const w = makeWorld();
  const res = executeRehearsal("board", { pgRunner: "docker" }, { runner: w.runner, fsOps: makeForbiddenFs() });
  assert.equal(res.success, true, res.error);
  assert.equal(res.promoted, true);
  assert.equal(res.smokeTestPassed, true);
  assert.equal(res.cleanup.removed, true);
  assert.equal(w.drillExists, false, "drill dir is gone");

  const rm = w.calls.find((c) => c.cmd === "docker" && c.args.includes("rm"));
  assert.deepStrictEqual(rm.args.slice(rm.args.indexOf("rm")), ["rm", "-rf", "/var/lib/postgresql/drill-cluster"]);
  assert.ok(rm.args.includes("myrmidon-pg-standby") && rm.args[0] === "exec", "rm ran through docker exec in the standby container");

  const order = [isBasebackup, (e) => e.kind === "cmd" && unwrap(e.cmd, e.args).args[0] === "stop", (e) => unwrap(e.cmd, e.args).tool === "rm"];
  const idx = order.map((p) => w.indexOf(p));
  assert.ok(idx[0] >= 0 && idx[0] < idx[1] && idx[1] < idx[2], `basebackup < pg_ctl stop < rm (got ${idx})`);
});

test("rehearse cleans up inside the container on EVERY failure path (finally)", () => {
  const scenarios = [
    ["snapshot", { basebackupOk: false }],
    ["pg_ctl start", { drillStartOk: false }],
    ["promote", { drillPromoteOk: false }],
    ["stuck in recovery", { drillStuck: true }],
    ["hindsight smoke", { hindsightSmokeOk: false }],
    ["board smoke", { boardSmokeOk: false }],
  ];
  for (const [name, over] of scenarios) {
    const w = makeWorld(over);
    const res = executeRehearsal("board", { pgRunner: "docker" }, { runner: w.runner, fsOps: makeForbiddenFs() });
    assert.equal(res.success, false, name);
    assert.ok(w.calls.some((c) => c.cmd === "docker" && c.args.includes("rm") && c.args.includes("-rf")), `${name}: rm -rf ran in the container`);
    assert.equal(w.drillExists, false, `${name}: nothing left behind`);
    assert.equal(res.cleanup.removed, true, name);
  }
});

test("rehearse reports a cleanup failure instead of silently leaving a huge directory", () => {
  const w = makeWorld({ rmOk: false });
  const res = executeRehearsal("board", { pgRunner: "docker" }, { runner: w.runner, fsOps: makeForbiddenFs() });
  assert.equal(res.success, false);
  assert.equal(res.cleanup.removed, false);
  assert.match(res.error, /Drill cleanup FAILED/);
  assert.match(res.error, /docker exec -u postgres myrmidon-pg-standby rm -rf \/var\/lib\/postgresql\/drill-cluster/);
});

test("rehearse refuses dangerous --drill-dir values before running anything", () => {
  for (const drillDir of ["/", "/var/lib/postgresql/data", "/srv/standby/myrmidon-pg/data", "/var/lib/postgresql", "relative/drill"]) {
    const w = makeWorld();
    const res = executeRehearsal("board", { pgRunner: "docker", drillDir }, { runner: w.runner, fsOps: makeForbiddenFs() });
    assert.equal(res.success, false, drillDir);
    assert.match(res.error, /Refusing drill directory|absolute path/, drillDir);
    assert.equal(w.calls.length, 0, `${drillDir}: nothing executed`);
  }
});

test("rehearse never reuses or deletes a drill dir it did not create", () => {
  const w = makeWorld({ drillExists: true });
  const res = executeRehearsal("board", { pgRunner: "docker" }, { runner: w.runner, fsOps: makeForbiddenFs() });
  assert.equal(res.success, false);
  assert.match(res.error, /already exists/);
  assert.match(res.error, /--cleanup-drill/);
  assert.equal(w.events.some(isBasebackup), false);
  assert.equal(w.calls.some((c) => c.args.includes("rm")), false, "pre-existing dir is left alone");
});

test("rehearse --keep-drill needs real secrets, listens beyond loopback and STARTS the drill board from --compose-file", () => {
  // missing secrets: refused before any work
  const w0 = makeWorld();
  const refused = executeRehearsal("board", { pgRunner: "docker", keepDrill: true }, { runner: w0.runner, fsOps: makeForbiddenFs(), env: {} });
  assert.equal(refused.success, false);
  assert.match(refused.error, /BETTER_AUTH_SECRET and PAPERCLIP_DB_PASSWORD/);
  assert.equal(w0.calls.length, 0);

  const env = { BETTER_AUTH_SECRET: "drill-secret", PAPERCLIP_DB_PASSWORD: "drill-pw" };
  const w = makeWorld();
  const res = executeRehearsal(
    "board",
    { pgRunner: "docker", keepDrill: true, composeFile: "/opt/standby/docker-compose.standby.yml" },
    { runner: w.runner, fsOps: makeForbiddenFs(), env }
  );
  assert.equal(res.success, true, res.error);
  assert.equal(res.keepDrill, true);
  assert.equal(res.boardStarted, true);
  assert.equal(res.boardUrl, "http://127.0.0.1:3101/healthz");
  assert.equal(res.teardown, "standby-ctl.sh rehearse --cleanup-drill");

  const board = w.calls.find((c) => c.cmd === "docker" && c.args.includes("myrmidon-board"));
  assert.deepStrictEqual(board.args, ["compose", "-f", "/opt/standby/docker-compose.standby.yml", "--profile", "drill", "up", "-d", "--no-deps", "myrmidon-board"]);
  const start = w.calls.find((c) => c.args.includes("start"));
  assert.match(start.args[start.args.indexOf("-o") + 1], /-c listen_addresses='\*'/);
  // the kept drill is not cleaned up
  assert.equal(w.calls.some((c) => c.args.includes("rm") && c.args.includes("-rf")), false);
  assert.equal(w.drillExists, true);
});

test("rehearse without --keep-drill keeps the drill instance on loopback", () => {
  const w = makeWorld();
  executeRehearsal("board", { pgRunner: "docker" }, { runner: w.runner, fsOps: makeForbiddenFs() });
  const start = w.calls.find((c) => c.args.includes("start"));
  assert.match(start.args[start.args.indexOf("-o") + 1], /-c listen_addresses=127\.0\.0\.1 /);
  assert.equal(w.calls.some((c) => c.args.includes("myrmidon-board")), false, "no board without --keep-drill");
});

test("rehearse --keep-drill cleans up when the drill fails or the board cannot start", () => {
  const env = { BETTER_AUTH_SECRET: "s", PAPERCLIP_DB_PASSWORD: "p" };

  const w1 = makeWorld({ hindsightSmokeOk: false });
  const r1 = executeRehearsal("board", { pgRunner: "docker", keepDrill: true }, { runner: w1.runner, fsOps: makeForbiddenFs(), env });
  assert.equal(r1.success, false);
  assert.equal(w1.drillExists, false, "failed drill is not kept");
  assert.equal(w1.calls.some((c) => c.args.includes("myrmidon-board")), false, "board not started for a failed drill");

  const w2 = makeWorld({ composeFailPattern: "myrmidon-board" });
  const r2 = executeRehearsal("board", { pgRunner: "docker", keepDrill: true }, { runner: w2.runner, fsOps: makeForbiddenFs(), env });
  assert.equal(r2.success, false);
  assert.match(r2.error, /Drill board failed to start/);
  assert.equal(w2.drillExists, false, "drill removed when the board did not start");
});

test("rehearse --cleanup-drill tears down the kept board and drill cluster", () => {
  const w = makeWorld({ drillExists: true });
  const code = runCli(["rehearse", "board", "--cleanup-drill", "--pg-runner=docker", "--compose-file=/opt/standby/docker-compose.standby.yml"], {}, { runner: w.runner, fsOps: makeForbiddenFs() });
  assert.equal(code, 0);
  assert.equal(w.drillExists, false);
  const rmBoard = w.calls.find((c) => c.cmd === "docker" && c.args[0] === "compose");
  assert.deepStrictEqual(rmBoard.args, ["compose", "-f", "/opt/standby/docker-compose.standby.yml", "--profile", "drill", "rm", "-sf", "myrmidon-board"]);
  assert.equal(w.events.some(isBasebackup), false, "teardown does not start a new drill");
});

test("runCli maps --compose-file / --keep-drill so the drill board is really started", () => {
  const w = makeWorld();
  const code = runCli(
    ["rehearse", "board", "--keep-drill", "--compose-file=/x/compose.yml", "--pg-runner=docker"],
    { BETTER_AUTH_SECRET: "s", PAPERCLIP_DB_PASSWORD: "p" },
    { runner: w.runner, fsOps: makeForbiddenFs() }
  );
  assert.equal(code, 0);
  const board = w.calls.find((c) => c.cmd === "docker" && c.args.includes("myrmidon-board"));
  assert.equal(board.args[2], "/x/compose.yml");
});

test("rehearse --dry-run exits 0 and runs nothing (review #9)", () => {
  const w = makeWorld();
  assert.equal(runCli(["rehearse", "board", "--dry-run"], {}, { runner: w.runner, fsOps: makeForbiddenFs() }), 0);
  assert.equal(runCli(["rehearse", "all", "--dry-run", "--pg-runner=host"], {}, { runner: w.runner, fsOps: makeForbiddenFs() }), 0);
  assert.equal(w.calls.length, 0);
  // the plan documents the in-container cleanup
  assert.match(planRehearsal("board", { pgRunner: "docker" }).step7_cleanup, /docker exec -u postgres/);
});

test("failover/switchback/setup --dry-run also exit 0 without running anything", () => {
  const w = makeWorld();
  for (const cmd of ["failover", "switchback", "setup"]) {
    assert.equal(runCli([cmd, "board", "--dry-run"], {}, { runner: w.runner, fsOps: makeForbiddenFs() }), 0, cmd);
  }
  assert.equal(w.calls.length, 0);
});

// ── Static checks of the shipped compose file, wrapper and docs ──────────────────────────────

const STANDBY_DIR = path.dirname(fileURLToPath(import.meta.url));
const composeText = fs.readFileSync(path.join(STANDBY_DIR, "docker-compose.standby.yml"), "utf8");
const wrapperText = fs.readFileSync(path.join(STANDBY_DIR, "standby-ctl.sh"), "utf8");
const composeCode = composeText.replace(/^\s*#.*$/gm, "");

test("drill board compose uses only switches the server really reads (review #5)", () => {
  assert.doesNotMatch(composeCode, /PAPERCLIP_DISABLE_SCHEDULER|PAPERCLIP_DISABLE_OUTBOUND/);
  // HEARTBEAT_SCHEDULER_ENABLED: server/src/config.ts; MYRMIDON_PROCESS_ROLE: server/src/services/process-role.ts
  assert.match(composeCode, /HEARTBEAT_SCHEDULER_ENABLED:\s*"false"/);
  assert.match(composeCode, /MYRMIDON_PROCESS_ROLE:\s*"api"/);
  assert.match(composeCode, /MYRMIDON_DB_BACKUP_ENABLED:\s*"false"/);
  const configTs = path.join(STANDBY_DIR, "../../../server/src/config.ts");
  if (fs.existsSync(configTs)) {
    assert.match(fs.readFileSync(configTs, "utf8"), /HEARTBEAT_SCHEDULER_ENABLED/);
  }
  const roleTs = path.join(STANDBY_DIR, "../../../server/src/services/process-role.ts");
  if (fs.existsSync(roleTs)) {
    assert.match(fs.readFileSync(roleTs, "utf8"), /MYRMIDON_PROCESS_ROLE/);
  }
  // The drill board must not be given a secrets master key: it starts with no connector credentials.
  assert.doesNotMatch(composeCode, /SECRETS_MASTER_KEY/);
});

test("drill board reaches the drill PG over the compose network, not host.docker.internal:5533", () => {
  assert.doesNotMatch(composeCode, /host\.docker\.internal/);
  assert.match(composeCode, /@myrmidon-pg-standby:5533\/paperclip/);
  assert.match(composeCode, /profiles:\s*\["drill"\]/);
});

test("compose ships no default secrets (no weak 'paperclip' password) and the standby healthcheck uses psql -tA", () => {
  assert.doesNotMatch(composeCode, /PAPERCLIP_DB_PASSWORD:-paperclip/);
  assert.doesNotMatch(composeCode, /PAPERCLIP_DB_PASSWORD:-[^}]/);
  assert.doesNotMatch(composeCode, /BETTER_AUTH_SECRET:-[^}]/);
  assert.match(composeCode, /psql -U paperclip -d paperclip -tA -c 'SELECT pg_is_in_recovery\(\)::int'/);
  assert.doesNotMatch(composeCode, /grep -q t\b/);
});

test("wrapper forwards the primary port and secrets by name, and can run compose and curl", () => {
  assert.match(wrapperText, /PRIMARY_PG_PORT/);
  assert.match(wrapperText, /docker-cli-compose/);
  assert.match(wrapperText, /curl/);
  // secrets are inherited from the environment (-e NAME), never expanded onto the docker command line
  assert.doesNotMatch(wrapperText, /PG_REPLICATOR_PASSWORD=/);
  assert.doesNotMatch(wrapperText, /BETTER_AUTH_SECRET=/);
  assert.doesNotMatch(wrapperText, /PAPERCLIP_DB_PASSWORD=/);
  assert.match(wrapperText, /-e PG_REPLICATOR_PASSWORD(\s|\\)/);
});

test("docker mode stages a uid-999 copy of --credentials and mounts the copy, not the user's file", () => {
  const w = makeWorld();
  const { fsOps, state } = makeFs({ passfileContent: "192.0.2.1:15432:*:myr_replicator:fromfile\n" });
  const res = setupStandby(
    "board",
    { pgRunner: "docker", credentialPath: "/srv/standby/creds/pgpass", readinessDelayMs: 0, ...PRIMARY },
    { runner: w.runner, fsOps }
  );
  assert.equal(res.success, true, res.error);
  const staged = state.writes.find((f) => f.file === "/srv/standby/myrmidon-pg/.pgpass");
  assert.ok(staged, "a staged copy is written next to the data dir");
  assert.equal(staged.content, "192.0.2.1:15432:*:myr_replicator:fromfile\n");
  assert.ok(state.chowns.some((c) => c.path === "/srv/standby/myrmidon-pg/.pgpass" && c.uid === 999 && c.gid === 999));
  assert.ok(!state.chowns.some((c) => c.path === "/srv/standby/creds/pgpass"), "the user's own credentials file is never chowned");
  const run = w.calls.find((c) => unwrapOneShot(c.cmd, c.args)?.tool === "pg_basebackup");
  assert.ok(run.args.includes("/srv/standby/myrmidon-pg/.pgpass:/run/standby/pgpass:ro"));
});

test("docker-mode remap honours a custom --standby-port instead of the compile-time default", () => {
  const calls = [];
  const runner = createPgRunner((cmd, args) => { calls.push({ cmd, args }); return { exitCode: 0, stdout: "", stderr: "" }; }, {
    pgRunner: "docker",
    standbyPort: 5444,
  });
  runner("psql", ["-h", "127.0.0.1", "-p", "5444", "-U", "paperclip", "-d", "paperclip", "-c", "SELECT 1;"]);
  assert.equal(calls[0].args[calls[0].args.indexOf("-p") + 1], "5432");
});

test("runInStandbyContainer always goes through docker exec in the standby container", () => {
  const calls = [];
  runInStandbyContainer((cmd, args) => { calls.push({ cmd, args }); return OK; }, { pgContainer: "custom-pg" }, "rm", ["-rf", "/x/drill"]);
  assert.deepStrictEqual(calls[0], {
    cmd: "docker",
    args: ["exec", "-u", "postgres", "-e", "PGPASSFILE=/var/lib/postgresql/data/.pgpass", "custom-pg", "rm", "-rf", "/x/drill"],
  });
});

// ── Second-round review hardening ────────────────────────────────────────────────────────────

test("preflight uses the SAME credentials as the base backup: staged passfile (docker) / host passfile env (host)", () => {
  // docker: every primary-side query runs in a one-shot container with the staged passfile mounted,
  // not through docker exec with the container's old .pgpass
  const w = makeWorld();
  const { fsOps } = makeFs({ entries: ["PG_VERSION", "standby.signal"] });
  const res = setupStandby("board", { pgRunner: "docker", force: true, replicatorPassword: "pw", readinessDelayMs: 0, ...PRIMARY }, { runner: w.runner, fsOps });
  assert.equal(res.success, true, res.error);
  const oneShotPsql = w.calls.filter((c) => unwrapOneShot(c.cmd, c.args)?.tool === "psql");
  assert.ok(oneShotPsql.length >= 2);
  for (const c of oneShotPsql) assert.ok(c.args.includes("/srv/standby/myrmidon-pg/.pgpass:/run/standby/pgpass:ro"));
  const execPreflight = w.calls.filter(
    (c) => c.cmd === "docker" && c.args[0] === "exec" && c.args.includes("192.0.2.1") && /max_slot_wal_keep_size|pg_create_physical_replication_slot/.test(sqlOf(c.args))
  );
  assert.equal(execPreflight.length, 0, "WAL-policy and slot checks never use the container's own old passfile");

  // host: the preflight psql gets the same PGPASSFILE the base backup gets
  const w2 = makeWorld();
  const f2 = makeFs({ entries: ["PG_VERSION", "standby.signal"] });
  setupStandby("board", { pgRunner: "host", force: true, credentialPath: "/etc/standby/pgpass", readinessDelayMs: 0, ...PRIMARY }, { runner: w2.runner, fsOps: f2.fsOps });
  const wal = w2.calls.find((c) => c.cmd === "psql" && sqlOf(c.args).includes("max_slot_wal_keep_size"));
  assert.equal(wal.ro.env.PGPASSFILE, "/etc/standby/pgpass");
});

test("a successful 'compose stop' is verified; a container that keeps running blocks the wipe", () => {
  // compose stop is a no-op (wrong project name): fall back to docker stop by container name
  const w = makeWorld({ composeStopNoop: true });
  const a = makeFs({ entries: ["PG_VERSION", "standby.signal"] });
  const ok = setupStandby("board", { pgRunner: "host", force: true, readinessDelayMs: 0, ...PRIMARY }, { runner: w.runner, fsOps: a.fsOps });
  assert.equal(ok.success, true, ok.error);
  assert.ok(w.calls.some((c) => c.cmd === "docker" && c.args[0] === "stop" && c.args[1] === "myrmidon-pg-standby"));

  // neither stop works: nothing is deleted
  const w2 = makeWorld({ composeStopNoop: true, dockerStopFails: true });
  const b = makeFs({ entries: ["PG_VERSION", "standby.signal"] });
  const res = setupStandby("board", { pgRunner: "host", force: true, ...PRIMARY }, { runner: w2.runner, fsOps: b.fsOps });
  assert.equal(res.success, false);
  assert.match(res.error, /still running/);
  assert.equal(b.state.rms.length, 0);
  assert.equal(w2.events.some(isBasebackup), false);
});

test("the wipe target must look like a PostgreSQL data directory (PG_VERSION, deep enough)", () => {
  assert.equal(validateStandbyDataDir("/srv/standby/myrmidon-pg/data", ["PG_VERSION", "base"]), null);
  assert.match(validateStandbyDataDir("/srv/standby", ["PG_VERSION"]), /at least 3 segments/);
  assert.match(validateStandbyDataDir("/srv/standby/myrmidon-pg", ["data", "tmp"]), /no PG_VERSION/);
  assert.match(validateStandbyDataDir("relative/dir/x", ["PG_VERSION"]), /absolute path/);

  const w = makeWorld();
  const { fsOps, state } = makeFs({ dataDir: "/srv/standby/other", entries: ["myrmidon-pg", "drill-cluster"] });
  const res = setupStandby("board", { pgRunner: "host", force: true, dataDir: "/srv/standby/other", ...PRIMARY }, { runner: w.runner, fsOps });
  assert.equal(res.success, false);
  assert.match(res.error, /does not look like a PostgreSQL data directory/);
  assert.equal(state.rms.length, 0);
  assert.equal(w.calls.length, 0, "refused before any command");
});

test("--discard-promoted-standby alone is not enough when the standby is AHEAD of the primary (needs --accept-data-loss)", () => {
  const mk = (over) => {
    const w = makeWorld({ standbyInRecovery: false, ...over });
    const f = makeFs({ entries: ["PG_VERSION", "base"] });
    return { w, f };
  };
  // standby on a higher timeline: the primary was never re-synced from it
  {
    const { w, f } = mk({ standbyTimeline: 2, primaryTimeline: 1 });
    const res = setupStandby("board", { pgRunner: "host", force: true, discardPromotedStandby: true, ...PRIMARY }, { runner: w.runner, fsOps: f.fsOps });
    assert.equal(res.success, false);
    assert.match(res.error, /even with --discard-promoted-standby/);
    assert.match(res.error, /--accept-data-loss/);
    assert.equal(res.comparison.verdict, "standby_ahead");
    assert.equal(f.state.rms.length, 0);
    assert.equal(w.events.some(isComposeStop), false);
  }
  // a different database system identifier: the "primary" is another cluster
  {
    const { w, f } = mk({ standbyTimeline: 1, primaryTimeline: 1, primarySystemId: "111", standbySystemId: "222" });
    const res = setupStandby("board", { pgRunner: "host", force: true, discardPromotedStandby: true, ...PRIMARY }, { runner: w.runner, fsOps: f.fsOps });
    assert.equal(res.success, false);
    assert.equal(res.comparison.verdict, "different_cluster");
  }
  // primary was re-synced from the promoted standby (same timeline, nothing newer on the standby): the flag suffices
  {
    const { w, f } = mk({ standbyTimeline: 2, primaryTimeline: 2, standbyLsn: "1/1000000", primaryLsn: "1/2000000" });
    const res = setupStandby("board", { pgRunner: "host", force: true, discardPromotedStandby: true, readinessDelayMs: 0, ...PRIMARY }, { runner: w.runner, fsOps: f.fsOps });
    assert.equal(res.success, true, res.error);
    assert.equal(res.comparison.verdict, "primary_ahead");
    assert.equal(res.promotedStandbyDiscarded, true);
  }
  // CLI mapping through switchback
  {
    const { w, f } = mk({ standbyTimeline: 2, primaryTimeline: 1 });
    const refused = runCli(["switchback", "board", "--pg-runner=host", "--force", "--discard-promoted-standby", "--primary-host=192.0.2.1", "--primary-port=15432"], {}, { runner: w.runner, fsOps: f.fsOps });
    assert.equal(refused, 1);
    const { w: w2, f: f2 } = mk({ standbyTimeline: 2, primaryTimeline: 1 });
    const ok = runCli(["switchback", "board", "--pg-runner=host", "--force", "--discard-promoted-standby", "--accept-data-loss", "--primary-host=192.0.2.1", "--primary-port=15432"], {}, { runner: w2.runner, fsOps: f2.fsOps });
    assert.equal(ok, 0);
    assert.equal(f2.state.rms.length, 2);
  }
});

test("failover guard refuses an endpoint whose port was only defaulted (the live primary is behind a relay)", () => {
  const w = makeWorld({ primary: "unreachable" });
  const res = executeFailover("board", { pgRunner: "host", fenced: true, primaryHost: "192.0.2.1" }, { runner: w.runner });
  assert.equal(res.success, false);
  assert.equal(res.guard.state, "endpoint_incomplete");
  assert.match(res.error, /--primary-port/);
  assert.equal(w.events.some(isPromote), false);
  assert.equal(psqlCalls(w).some((c) => c.host === "192.0.2.1"), false, "does not even probe the guessed port");

  const oldPort = process.env.PRIMARY_PG_PORT;
  const oldHost = process.env.PRIMARY_PG_HOST;
  process.env.PRIMARY_PG_HOST = "192.0.2.1";
  delete process.env.PRIMARY_PG_PORT;
  try {
    const w2 = makeWorld({ primary: "unreachable" });
    const r2 = executeFailover("board", { pgRunner: "host", fenced: true }, { runner: w2.runner });
    assert.equal(r2.guard.state, "endpoint_incomplete");
    process.env.PRIMARY_PG_PORT = "15432";
    const w3 = makeWorld({ primary: "unreachable" });
    const r3 = executeFailover("board", { pgRunner: "host", fenced: true, verifyDelayMs: 0 }, { runner: w3.runner });
    assert.equal(r3.success, true, r3.error);
  } finally {
    if (oldPort === undefined) delete process.env.PRIMARY_PG_PORT; else process.env.PRIMARY_PG_PORT = oldPort;
    if (oldHost === undefined) delete process.env.PRIMARY_PG_HOST; else process.env.PRIMARY_PG_HOST = oldHost;
  }
});

test("the drill instance starts with a log file so docker exec does not hang on the inherited stdout", () => {
  const w = makeWorld();
  executeRehearsal("board", { pgRunner: "docker" }, { runner: w.runner, fsOps: makeForbiddenFs() });
  const start = w.calls.find((c) => c.args.includes("start"));
  const i = start.args.indexOf("-l");
  assert.ok(i > 0);
  assert.equal(start.args[i + 1], "/var/lib/postgresql/drill-cluster/pg_ctl.log");
});

test("a docker error (container not running) is not mistaken for 'drill dir absent'", () => {
  const w = makeWorld({ containerRunning: false });
  const res = executeRehearsal("board", { pgRunner: "docker" }, { runner: w.runner, fsOps: makeForbiddenFs() });
  assert.equal(res.success, false);
  assert.match(res.error, /Cannot determine whether drill directory/);
  assert.equal(w.events.some(isBasebackup), false);
});

test("pgpassLine escapes ':' and '\\' so odd passwords still authenticate", () => {
  assert.equal(pgpassLine("h", 5432, "u", "a:b\\c"), "h:5432:*:u:a\\:b\\\\c\n");
  assert.equal(pgpassLine("h", 5432, "u", "plain"), "h:5432:*:u:plain\n");
  const w = makeWorld();
  const { fsOps, state } = makeFs({ dataDirExists: false });
  setupStandby("board", { pgRunner: "host", replicatorPassword: "p:w\\d", readinessDelayMs: 0, ...PRIMARY }, { runner: w.runner, fsOps });
  const pass = state.writes.find((f) => f.file.endsWith("/data/.pgpass"));
  assert.equal(pass.content, "192.0.2.1:15432:*:myr_replicator:p\\:w\\\\d\n");
});

test("a child killed by a signal or by the timeout is a failure with its reason, never exit 0", () => {
  assert.deepStrictEqual(spawnResultToRunnerResult({ status: 0, stdout: "x", stderr: "" }), { exitCode: 0, stdout: "x", stderr: "" });
  assert.equal(spawnResultToRunnerResult({ status: 3, stdout: "", stderr: "e" }).exitCode, 3);
  const killed = spawnResultToRunnerResult({ status: null, signal: "SIGKILL", stdout: "", stderr: "" });
  assert.equal(killed.exitCode, 1);
  assert.match(killed.stderr, /SIGKILL/);
  const timedOut = spawnResultToRunnerResult({ status: null, signal: "SIGTERM", error: new Error("spawnSync docker ETIMEDOUT"), stdout: "", stderr: "" });
  assert.equal(timedOut.exitCode, 1);
  assert.match(timedOut.stderr, /ETIMEDOUT/);
  // and the guard treats such a tool-level failure as an error (blocking), not as 'primary down'
  assert.equal(classifyPsqlFailure(timedOut), "error");
});

test("check-lag sees a MISSING replication slot (outer join returns a row) and reads the limit from pg_settings", () => {
  const seen = [];
  const runner = (cmd, args) => {
    const sql = sqlOf(args);
    seen.push(sql);
    if (sql.includes("IDENTIFY_SYSTEM")) return { exitCode: 0, stdout: "729374172937|1|1/2000000|paperclip\n", stderr: "" };
    if (sql.includes("wal_status")) return { exitCode: 0, stdout: "missing||6144\n", stderr: "" };
    return { exitCode: 0, stdout: `1|1/1500000|1/1500000|${new Date(Date.now() - 5000).toISOString()}\n`, stderr: "" };
  };
  const res = checkLag("board", { pgRunner: "host", ...PRIMARY }, { runner });
  assert.equal(res.success, false);
  assert.equal(res.rpoStatus, "slot_missing");
  const slotSql = seen.find((q) => q.includes("wal_status"));
  assert.match(slotSql, /FROM \(SELECT 1\) d LEFT JOIN pg_replication_slots s ON/);
  assert.match(slotSql, /FROM pg_settings WHERE name = 'max_slot_wal_keep_size'/);
  assert.doesNotMatch(slotSql, /current_setting\('max_slot_wal_keep_size'\)/, "'6GB' would be parsed as 6 MB");
});

test("--help and unknown targets are handled by the CLI itself", () => {
  const w = makeWorld();
  assert.equal(runCli(["failover", "--help"], {}, { runner: w.runner }), 0);
  assert.equal(runCli(["failover", "bord", "--fenced", "--pg-runner=host"], {}, { runner: w.runner }), 1);
  assert.equal(w.calls.length, 0, "neither --help nor a mistyped target executes anything");
});

test("compose/server cross-check: DB_BACKUP_ENABLED is a real server switch", () => {
  const configTs = path.join(STANDBY_DIR, "../../../server/src/config.ts");
  if (fs.existsSync(configTs)) {
    assert.match(fs.readFileSync(configTs, "utf8"), /readProductEnv\("DB_BACKUP_ENABLED"\)/);
  }
});

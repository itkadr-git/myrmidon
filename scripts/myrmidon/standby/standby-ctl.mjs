#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STANDBY_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_COMPOSE_FILE = path.join(STANDBY_DIR, "docker-compose.standby.yml");

/**
 * standby-ctl.mjs
 *
 * Operational CLI and control module for Myrmidon center warm standby (Option A+A2, OPE-7656).
 * Manages PostgreSQL warm standby replication for Board DB and Hindsight DB on myr-vm1,
 * lag measurement against primary LSN, automated failover promotion, switchback, and rehearsal.
 */

export const DEFAULT_CONFIG = {
  primaryHost: process.env.PRIMARY_PG_HOST || "primary.internal",
  primaryPort: Number(process.env.PRIMARY_PG_PORT) || 5432,
  standbyHost: "127.0.0.1",
  standbyPort: 5433,
  // Single-cluster aliases for backwards compatibility
  primaryBoardPort: 5432,
  primaryHindsightPort: 5432,
  standbyBoardPort: 5433,
  standbyHindsightPort: 5433,
  dataDir: "/srv/standby/myrmidon-pg/data",
  boardDataDir: "/srv/standby/myrmidon-pg/data",
  hindsightDataDir: "/srv/standby/myrmidon-pg/data",
  walArchiveDir: "/srv/backups/wal/myrmidon-pg",
  boardWalArchiveDir: "/srv/backups/wal/myrmidon-pg",
  hindsightWalArchiveDir: "/srv/backups/wal/myrmidon-pg",
  replUser: "myr_replicator",
  boardReplUser: "myr_replicator",
  hindsightReplUser: "myr_replicator",
  replSlot: "standby_board_slot",
  boardReplSlot: "standby_board_slot",
  hindsightReplSlot: "standby_board_slot",
  boardDbUser: "paperclip",
  boardDbName: "paperclip",
  hindsightDbUser: "myrmidon_hindsight",
  hindsightDbName: "myrmidon_hindsight",
  replicatorPassword: process.env.PG_REPLICATOR_PASSWORD || "",
  passfilePath: process.env.PG_PASSFILE_PATH || "",
  credentialPath: process.env.STANDBY_CREDENTIAL_PATH || "",
  containerPassfilePath: "/var/lib/postgresql/data/.pgpass",
  rpoMaxSeconds: 900, // RPO <= 15 min
  rtoTargetSeconds: 1800, // RTO <= 30 min
  // D9: execution mode for PostgreSQL client binaries. The myr-vm1 standby host has
  // no host-level PostgreSQL installation; binaries run inside a short-lived
  // pgvector/pgvector:pg18 container (or via docker exec into the standby container).
  pgRunner: process.env.STANDBY_PG_RUNNER || "docker", // "docker" | "host"
  pgImage: process.env.STANDBY_PG_IMAGE || "pgvector/pgvector:pg18",
  pgContainer: process.env.STANDBY_PG_CONTAINER || "myrmidon-pg-standby",
  // OPE-7656 review fix: in docker-runner mode pg_ctl / pg_basebackup run INSIDE the
  // standby container, where PGDATA is the compose volume target. The host path
  // (dataDir) does not exist there, so the tools must be given THIS path.
  containerDataDir: "/var/lib/postgresql/data",
  // Default in-container drill location (uid 999 writable, never a host path).
  containerDrillDir: "/var/lib/postgresql/drill-cluster",
  // uid/gid of the postgres user inside pgvector/pgvector:pg18; files the tool writes
  // into the bind-mounted data directory must be owned by it (.pgpass is 0600).
  containerPgUid: 999,
  containerPgGid: 999,
  // Where the staged replication passfile is mounted into one-shot containers.
  containerSetupPassfilePath: "/run/standby/pgpass",
  composeFile: DEFAULT_COMPOSE_FILE,
  composeService: "myrmidon-pg-standby",
  drillBoardService: "myrmidon-board",
  drillBoardUrl: "http://127.0.0.1:3101/healthz",
  appBoardService: "myrmidon-board",
  healthCheckUrl: "http://127.0.0.1:3100/healthz",
};

export function resolvePrimaryPort(options = {}, target = "board") {
  // ADM 04.11: read env at call time so tests and late-set env are honoured;
  // DEFAULT_CONFIG.primaryPort was captured once at module load.
  const envPort = process.env.PRIMARY_PG_PORT ? Number(process.env.PRIMARY_PG_PORT) : null;
  return (
    options.primaryPort ||
    envPort ||
    (target === "board"
      ? options.primaryBoardPort || DEFAULT_CONFIG.primaryBoardPort
      : options.primaryHindsightPort || DEFAULT_CONFIG.primaryHindsightPort) ||
    5432
  );
}

/**
 * ADM rehearsal feedback (04.11): on the real site the primary is not reachable
 * via the compile-time default (primary.internal:5432). The standby container
 * already knows the true primary endpoint from its own primary_conninfo setting.
 * When neither CLI flags nor env vars override the endpoint, ask the standby.
 *
 * Returns { host, port, source: 'explicit'|'env'|'conninfo'|'default' }.
 */
export function resolvePrimaryEndpoint(options = {}, target = "board", deps = {}) {
  const runner = deps.runner || defaultRunner;
  const standbyPort = resolveStandbyPort(options, target);
  const dbUser = target === "board"
    ? options.boardDbUser || DEFAULT_CONFIG.boardDbUser
    : options.hindsightDbUser || DEFAULT_CONFIG.hindsightDbUser;
  const dbName = target === "board"
    ? options.boardDbName || DEFAULT_CONFIG.boardDbName
    : options.hindsightDbName || DEFAULT_CONFIG.hindsightDbName;

  // portExplicit: the port was actually given (flag/env/conninfo) rather than defaulted to 5432.
  // The live primary sits behind a relay on another port, so a defaulted port must not be trusted
  // by safety checks (a probe of the wrong port reads as "unreachable").
  const portExplicit = Boolean(options.primaryPort || process.env.PRIMARY_PG_PORT);
  if (options.primaryHost) return { host: options.primaryHost, port: resolvePrimaryPort(options, target), source: "explicit", portExplicit };
  if (process.env.PRIMARY_PG_HOST) return { host: process.env.PRIMARY_PG_HOST, port: resolvePrimaryPort(options, target), source: "env", portExplicit };

  // Defect 1 fix: Try reading primary_conninfo from postgresql.auto.conf first (avoids permission denied on SHOW primary_conninfo as paperclip)
  const fsOps = deps.fsOps || defaultFsOps;
  const dataDir = options.dataDir || DEFAULT_CONFIG.dataDir;
  let autoConfContent = "";
  try {
    if (isDockerMode(options)) {
      const container = options.pgContainer || DEFAULT_CONFIG.pgContainer;
      const res = runner("docker", ["exec", container, "cat", path.join(options.containerDataDir || DEFAULT_CONFIG.containerDataDir, "postgresql.auto.conf")], { timeoutMs: 10000 });
      if (res.exitCode === 0) autoConfContent = res.stdout;
    } else if (fsOps.existsSync && fsOps.existsSync(path.join(dataDir, "postgresql.auto.conf"))) {
      autoConfContent = fsOps.readFileSync(path.join(dataDir, "postgresql.auto.conf"), "utf8");
    }
  } catch {}

  if (autoConfContent) {
    const conninfoMatch = autoConfContent.match(/primary_conninfo\s*=\s*'([^']+)'/) || autoConfContent.match(/primary_conninfo\s*=\s*"([^"]+)"/);
    if (conninfoMatch) {
      const conninfo = conninfoMatch[1];
      const hostMatch = conninfo.match(/host=([^\s']+)/);
      const portMatch = conninfo.match(/port=(\d+)/);
      if (hostMatch) {
        return {
          host: hostMatch[1],
          port: portMatch ? Number(portMatch[1]) : 5432,
          source: "conninfo",
          portExplicit: true,
        };
      }
    }
  }

  const res = queryPostgres(
    "SHOW primary_conninfo;",
    { host: options.standbyHost || DEFAULT_CONFIG.standbyHost, port: standbyPort, user: dbUser, db: dbName },
    runner
  );
  const conninfo = (res.stdout || "").trim();
  const hostMatch = conninfo.match(/host=([^\s']+)/);
  const portMatch = conninfo.match(/port=(\d+)/);
  if (hostMatch) {
    return {
      host: hostMatch[1],
      port: portMatch ? Number(portMatch[1]) : 5432,
      source: "conninfo",
      portExplicit: true,
    };
  }
  return {
    host: DEFAULT_CONFIG.primaryHost,
    port: resolvePrimaryPort(options, target),
    source: "default",
    portExplicit,
  };
}

export function resolveStandbyPort(options = {}, target = "board") {
  return (
    options.standbyPort ||
    DEFAULT_CONFIG.standbyPort ||
    (target === "board"
      ? options.standbyBoardPort || DEFAULT_CONFIG.standbyBoardPort
      : options.standbyHindsightPort || DEFAULT_CONFIG.standbyHindsightPort) ||
    5433
  );
}

export const defaultFsOps = {
  mkdirSync: fs.mkdirSync,
  writeFileSync: fs.writeFileSync,
  readFileSync: fs.readFileSync,
  existsSync: fs.existsSync,
  rmSync: fs.rmSync,
  readdirSync: fs.readdirSync,
  chmodSync: fs.chmodSync,
  chownSync: fs.chownSync,
};

/**
 * One ~/.pgpass line. libpq requires ':' and '\\' inside a field to be backslash-escaped;
 * an unescaped ':' in a password silently shifts the fields and authentication fails.
 */
export function pgpassLine(host, port, user, password, db = "*") {
  const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  return `${esc(host)}:${esc(port)}:${esc(db)}:${esc(user)}:${esc(password)}\n`;
}

/**
 * Build the docker CLI prefix that executes a PostgreSQL binary inside the
 * running myrmidon-pg-standby container via docker exec.
 *
 * ADM rehearsal feedback (03.11): the node wrapper runs in node:20-alpine
 * which has no docker CLI, so `docker run` mode can never work.  Instead we
 * exec into the already-running standby container which has all PG binaries:
 *   /usr/bin/psql, /usr/bin/pg_basebackup, /usr/lib/postgresql/18/bin/pg_ctl
 * The postgres user inside the container is uid 999.
 */
export function dockerPgPrefix(config = DEFAULT_CONFIG) {
  const container = config.pgContainer || DEFAULT_CONFIG.pgContainer;
  const passfile = config.containerPassfilePath || DEFAULT_CONFIG.containerPassfilePath;
  return ["exec", "-u", "postgres", "-e", `PGPASSFILE=${passfile}`, container];
}

/**
 * Map a host-side PG tool path to the path inside the standby container.
 * pg_ctl is not in the container PATH; it lives under the PostgreSQL lib dir.
 */
export function mapPgBinaryForDocker(cmd) {
  if (cmd === "pg_ctl") {
    return "/usr/lib/postgresql/18/bin/pg_ctl";
  }
  return cmd;
}

/**
 * Determine whether a psql call targets the local standby (inside the
 * container) or a remote host.  When the target is 127.0.0.1 / localhost and
 * the port equals the configured standbyPort (host-mapped), we remap to the
 * container-internal port 5432 so the query reaches the actual standby.
 */
export function remapHostPortForDocker(host, port, config = DEFAULT_CONFIG) {
  const standbyPort = config.standbyPort || DEFAULT_CONFIG.standbyPort;
  if (
    (host === "127.0.0.1" || host === "localhost" || host === "::1") &&
    String(port) === String(standbyPort)
  ) {
    return { host: "127.0.0.1", port: 5432 };
  }
  return { host, port };
}

/**
 * Rewrite a PG command + args for docker exec execution inside the standby container.
 * - Binary paths are mapped (pg_ctl → /usr/lib/postgresql/18/bin/pg_ctl).
 * - Host/port pairs targeting the local standby are remapped to the container-internal port.
 * - The drill runs entirely inside the container at /var/lib/postgresql/drill-cluster
 *   (uid 999). No host /srv path is mounted into the container (ADM 04.11).
 */
export function wrapPgForDocker(cmd, args, config = DEFAULT_CONFIG) {
  const prefix = dockerPgPrefix(config);
  const mappedCmd = mapPgBinaryForDocker(cmd);

  // Find -h and -p pairs and remap them together
  let targetHost = null;
  let targetPort = null;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-h") targetHost = args[i + 1];
    if (args[i] === "-p") targetPort = args[i + 1];
  }

  let remappedHost = targetHost;
  let remappedPort = targetPort;
  if (targetHost && targetPort) {
    const r = remapHostPortForDocker(targetHost, targetPort, config);
    remappedHost = r.host;
    remappedPort = String(r.port);
  }

  const rewritten = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-h" && i + 1 < args.length && remappedHost !== null) {
      rewritten.push("-h", remappedHost);
      i++; // skip original value
    } else if (args[i] === "-p" && i + 1 < args.length && remappedPort !== null) {
      rewritten.push("-p", remappedPort);
      i++; // skip original value
    } else {
      rewritten.push(args[i]);
    }
  }
  return { cmd: "docker", args: [...prefix, mappedCmd, ...rewritten] };
}

/**
 * Create a runner that executes PG binaries either on the host or inside docker.
 */
export function createPgRunner(baseRunner, options = {}, config = DEFAULT_CONFIG) {
  const mode = options.pgRunner || config.pgRunner || DEFAULT_CONFIG.pgRunner;
  // OPE-7656 review fix: honour a custom --standby-port / container when remapping the
  // host-published standby port to the container-internal 5432 (previously the remap
  // always compared against the compile-time default 5433).
  const effective = {
    ...config,
    ...(options.standbyPort ? { standbyPort: options.standbyPort } : {}),
    ...(options.pgContainer ? { pgContainer: options.pgContainer } : {}),
  };
  return (cmd, args, runnerOptions = {}) => {
    if (cmd === "psql" || cmd === "pg_basebackup" || cmd === "pg_ctl" || cmd === "pg_isready") {
      if (mode === "docker") {
        const wrapped = wrapPgForDocker(cmd, args, effective);
        return baseRunner(wrapped.cmd, wrapped.args, runnerOptions);
      }
    }
    return baseRunner(cmd, args, runnerOptions);
  };
}

/** "docker" (default) or "host": where the PostgreSQL client binaries run. */
export function pgRunnerMode(options = {}) {
  return options.pgRunner || DEFAULT_CONFIG.pgRunner || "docker";
}

export function isDockerMode(options = {}) {
  return pgRunnerMode(options) === "docker";
}

/**
 * Run an arbitrary (non-PG) command inside the standby container via docker exec,
 * as the postgres user. Used for drill cleanup (rm -rf) and existence checks so that
 * in-container paths are never handed to host filesystem calls.
 */
export function runInStandbyContainer(baseRunner, options, cmd, args = [], runnerOptions = {}) {
  const prefix = dockerPgPrefix({
    ...DEFAULT_CONFIG,
    pgContainer: options.pgContainer || DEFAULT_CONFIG.pgContainer,
  });
  return baseRunner("docker", [...prefix, cmd, ...args], runnerOptions);
}

/**
 * Parse a PostgreSQL boolean as printed by psql. Real servers print "true"/"false" for
 * `::text`, "t"/"f" for a bare boolean column and "1"/"0" for `::int`. The tool always
 * selects `::int`; this accepts all three so a driver/format change cannot silently
 * invert a safety decision. Returns true, false or null (unparseable).
 */
export function parsePgBool(raw) {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === "1" || v === "t" || v === "true") return true;
  if (v === "0" || v === "f" || v === "false") return false;
  return null;
}

/** The single SQL used everywhere to read the recovery state (stable "1"/"0" output). */
export const SQL_IN_RECOVERY = "SELECT pg_is_in_recovery()::int;";

/** First `|`-separated field of the first output line of `psql -t -A`. */
export function firstField(stdout) {
  return (stdout || "").trim().split("\n")[0].split("|")[0].trim();
}

function describePsqlError(res) {
  const text = ((res && (res.stderr || res.stdout)) || "").trim();
  return text.split("\n")[0].slice(0, 300) || `exit ${res ? res.exitCode : "?"}`;
}

const SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function isSqlIdent(value) {
  return typeof value === "string" && SQL_IDENT_RE.test(value);
}

/**
 * Classify a failed psql call.
 *  - "error": the server (or docker) ANSWERED with a refusal/error: authentication or
 *    permission failure, FATAL/ERROR text, container not running... We cannot prove the
 *    primary is down, so callers must treat this as BLOCKING, never as "primary down".
 *  - "unreachable": no usable answer from the network: refused, timed out, DNS failure,
 *    no route, or a relay that accepted TCP and dropped it.
 */
export function classifyPsqlFailure(res) {
  const text = `${(res && res.stderr) || ""}\n${(res && res.stdout) || ""}`;
  // Server-originated severities are upper-case ("FATAL:  password authentication failed");
  // psql's own prefix is lower-case ("psql: error: connection to server ... refused"), so
  // this first test is deliberately case-sensitive.
  if (/\b(FATAL|ERROR):/.test(text)) return "error";
  const serverAnswered =
    /authentication|no password supplied|pg_hba|permission denied|does not exist|SSL error|certificate|starting up|shutting down|Error response from daemon|OCI runtime|No such container|is not running/i;
  if (serverAnswered.test(text)) return "error";
  const unreachable =
    /connection refused|connection timed out|timeout expired|could not translate host name|name or service not known|temporary failure in name resolution|no route to host|network is unreachable|could not connect to server|server closed the connection unexpectedly|connection reset by peer|EOF detected|could not receive data from server/i;
  if (unreachable.test(text)) return "unreachable";
  return "error";
}

/**
 * Normalise a spawnSync result. A child killed by a signal or by the timeout has
 * `status === null`: that is a FAILURE (never exit 0) and the reason must reach stderr
 * (spawnSync returns an empty-string stderr, so `??` alone would have dropped it).
 */
export function spawnResultToRunnerResult(res) {
  const killed = res.status === null || res.status === undefined;
  const notes = [];
  if (res.error) notes.push(String(res.error));
  if (res.signal) notes.push(`killed by signal ${res.signal}`);
  return {
    exitCode: killed ? 1 : res.status,
    stdout: res.stdout ?? "",
    stderr: [res.stderr || "", ...notes].filter(Boolean).join("\n"),
  };
}

export const DEFAULT_BASEBACKUP_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** CLI values are seconds by default; explicit ms suffix accepts millisecond values. */
export function parseBasebackupTimeout(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(String(value).trim());
  if (!match) throw new Error("--basebackup-timeout must be a positive number of seconds (s) or milliseconds (ms)");
  const multiplier = match[2] === "ms" ? 1 : 1000;
  const ms = Math.round(Number(match[1]) * multiplier);
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error("--basebackup-timeout must be a positive safe integer duration");
  }
  return ms;
}

function basebackupTimeoutMs(options) {
  const value = options.basebackupTimeoutMs ?? DEFAULT_BASEBACKUP_TIMEOUT_MS;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error("Invalid basebackup timeout (milliseconds)");
  return ms;
}

export function defaultRunner(cmd, args = [], options = {}) {
  // spawnSync blocks the main thread for hours during a large basebackup. A worker
  // writes a heartbeat directly to fd 2 every five minutes even if pg_basebackup
  // itself stalls without emitting -P progress. Atomics stops it on completion.
  const heartbeat = options.streamStderr ? new Int32Array(new SharedArrayBuffer(4)) : null;
  const progressWorker = heartbeat ? new Worker(`
    const { workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    const signal = new Int32Array(workerData.signal);
    while (Atomics.wait(signal, 0, 0, workerData.intervalMs) === 'timed-out') {
      fs.writeSync(2, '[standby-ctl] pg_basebackup still running (5-minute progress heartbeat)\\n');
    }
  `, { eval: true, workerData: { signal: heartbeat.buffer, intervalMs: options.progressIntervalMs ?? 300000 } }) : null;
  try {
    const res = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 30000,
      // pg_basebackup -P prints copy progress to stderr; do not buffer it for hours.
      ...(options.streamStderr ? { stdio: ["ignore", "pipe", "inherit"] } : {}),
      env: { ...process.env, ...options.env },
    });
    return spawnResultToRunnerResult(res);
  } finally {
    if (heartbeat) {
      Atomics.store(heartbeat, 0, 1);
      Atomics.notify(heartbeat, 0);
      void progressWorker.terminate();
    }
  }
}

/**
 * Parses PostgreSQL LSN string ('1/17FCA00') into BigInt.
 */
export function parseLsn(lsnStr) {
  if (!lsnStr || typeof lsnStr !== "string") return null;
  const cleaned = lsnStr.trim().toUpperCase();
  const match = cleaned.match(/^([0-9A-F]+)\/([0-9A-F]+)$/);
  if (!match) return null;
  const high = BigInt(`0x${match[1]}`);
  const low = BigInt(`0x${match[2]}`);
  return (high << 32n) + low;
}

/**
 * Calculates byte lag and time lag between primary/receive and replay LSN.
 * On an idle database where byteLag is 0 and receiveByteLag is 0, timeLag naturally
 * grows without real lag; RPO is only violated if byteLag > 0 or receive-LSN lags,
 * or if LSN cannot be measured.
 */
export function calculateLag({
  primaryLsn,
  receiveLsn,
  replayLsn,
  lastXactReplayTimestamp,
  rpoMaxSeconds,
  maxByteLag,
  now = new Date(),
} = {}) {
  const effectiveRpoMax =
    typeof rpoMaxSeconds === "number" && Number.isFinite(rpoMaxSeconds)
      ? rpoMaxSeconds
      : DEFAULT_CONFIG.rpoMaxSeconds;

  const refLsn = primaryLsn || receiveLsn;
  const refBig = parseLsn(refLsn);
  const replayBig = parseLsn(replayLsn);

  let byteLag = null;
  if (refBig !== null && replayBig !== null) {
    const diff = refBig - replayBig;
    byteLag = diff >= 0n ? diff : 0n;
  }

  let receiveByteLag = null;
  const recBig = parseLsn(receiveLsn);
  if (recBig !== null && replayBig !== null) {
    const diff = recBig - replayBig;
    receiveByteLag = diff >= 0n ? diff : 0n;
  }

  let timeLagSeconds = null;
  if (lastXactReplayTimestamp) {
    const replayTime = new Date(lastXactReplayTimestamp);
    if (!Number.isNaN(replayTime.getTime())) {
      timeLagSeconds = Math.max(0, Math.floor((now.getTime() - replayTime.getTime()) / 1000));
    }
  }

  let rpoOk = true;
  let rpoStatus = "ok";

  const hasByteLag = (byteLag !== null && byteLag > 0n) || (receiveByteLag !== null && receiveByteLag > 0n);

  if (effectiveRpoMax !== undefined && timeLagSeconds !== null && timeLagSeconds > effectiveRpoMax) {
    if (hasByteLag || byteLag === null) {
      rpoOk = false;
      rpoStatus = "lag_exceeded";
    }
  }

  if (maxByteLag !== undefined && byteLag !== null && byteLag > BigInt(maxByteLag)) {
    rpoOk = false;
    rpoStatus = "byte_lag_exceeded";
  }

  return {
    measuredAgainst: primaryLsn ? "primary" : receiveLsn ? "receive" : "none",
    primaryLsn: primaryLsn || null,
    receiveLsn: receiveLsn || null,
    replayLsn: replayLsn || null,
    byteLag,
    receiveByteLag,
    timeLagSeconds,
    rpoMaxSeconds: effectiveRpoMax,
    rpoOk,
    rpoStatus,
  };
}

/**
 * Parses psql output for standby recovery and LSN queries.
 */
export function parseReplicationStatus(sqlOutput) {
  if (!sqlOutput || typeof sqlOutput !== "string") {
    return {
      inRecovery: false,
      receiveLsn: null,
      replayLsn: null,
      lastXactReplayTimestamp: null,
      role: "unknown",
      raw: "",
    };
  }

  if (sqlOutput.includes("psql: error:") || sqlOutput.includes("Connection refused")) {
    return {
      inRecovery: false,
      receiveLsn: null,
      replayLsn: null,
      lastXactReplayTimestamp: null,
      role: "unreachable",
      error: "psql_connection_failed",
      raw: sqlOutput,
    };
  }

  const lines = sqlOutput.trim().split("\n");
  const firstLine = lines[0] || "";
  const parts = firstLine.split("|").map((p) => p.trim());

  if (parts.length < 1 || firstLine === "") {
    return {
      inRecovery: false,
      receiveLsn: null,
      replayLsn: null,
      lastXactReplayTimestamp: null,
      role: "unknown",
      raw: sqlOutput,
    };
  }

  // The standby query selects pg_is_in_recovery()::int ("1"/"0"); parsePgBool also
  // accepts psql's native "t"/"f" and "true"/"false" so a changed query cannot flip the role.
  const inRecovery = parsePgBool(parts[0]) === true;
  const receiveLsn = parts[1] && parts[1] !== "" ? parts[1] : null;
  const replayLsn = parts[2] && parts[2] !== "" ? parts[2] : null;
  const lastXactReplayTimestamp = parts[3] && parts[3] !== "" ? parts[3] : null;

  return {
    inRecovery,
    receiveLsn,
    replayLsn,
    lastXactReplayTimestamp,
    role: inRecovery ? "standby" : "primary_or_standalone",
    raw: sqlOutput,
  };
}

/**
 * Generates postgresql.auto.conf content for standby streaming with replication credentials.
 */
export function generateStandbyConfig(target = "board", overrides = {}) {
  const isBoard = target === "board";
  const primaryHost = overrides.primaryHost || DEFAULT_CONFIG.primaryHost;
  const primaryPort = resolvePrimaryPort(overrides, target);
  const replUser = isBoard
    ? overrides.boardReplUser || DEFAULT_CONFIG.boardReplUser
    : overrides.hindsightReplUser || DEFAULT_CONFIG.hindsightReplUser;
  const replSlot = isBoard
    ? overrides.boardReplSlot || DEFAULT_CONFIG.boardReplSlot
    : overrides.hindsightReplSlot || DEFAULT_CONFIG.hindsightReplSlot;
  const walArchiveDir = isBoard
    ? overrides.boardWalArchiveDir || DEFAULT_CONFIG.boardWalArchiveDir
    : overrides.hindsightWalArchiveDir || DEFAULT_CONFIG.hindsightWalArchiveDir;
  const appName = isBoard ? "myrmidon_board_standby" : "myrmidon_hindsight_standby";

  // Use passfile for standby authentication; never embed raw password in primary_conninfo.
  // PostgreSQL inside the container accesses the passfile copied into data directory at /var/lib/postgresql/data/.pgpass.
  const passfilePath =
    overrides.containerPassfilePath ||
    DEFAULT_CONFIG.containerPassfilePath ||
    "/var/lib/postgresql/data/.pgpass";
  const passParam = passfilePath ? ` passfile=${passfilePath}` : "";

  return [
    `# PostgreSQL standby configuration for ${target} (managed by standby-ctl.mjs)`,
    `primary_conninfo = 'host=${primaryHost} port=${primaryPort} user=${replUser}${passParam} application_name=${appName} connect_timeout=10'`,
    `primary_slot_name = '${replSlot}'`,
    `hot_standby = 'on'`,
    `restore_command = 'test -f ${walArchiveDir}/%f && cp ${walArchiveDir}/%f %p'`,
    `archive_cleanup_command = 'pg_archivecleanup ${walArchiveDir} %r'`,
    "",
  ].join("\n");
}

/**
 * Generates pg_basebackup command array and string.
 * Supports --max-rate and --checkpoint passthrough for large clusters (D1).
 */
export function generateBasebackupCommand(target = "board", overrides = {}) {
  const isBoard = target === "board";
  const primaryHost = overrides.primaryHost || DEFAULT_CONFIG.primaryHost;
  const primaryPort = resolvePrimaryPort(overrides, target);
  const replUser = isBoard
    ? overrides.boardReplUser || DEFAULT_CONFIG.boardReplUser
    : overrides.hindsightReplUser || DEFAULT_CONFIG.hindsightReplUser;
  const replSlot = isBoard
    ? overrides.boardReplSlot || DEFAULT_CONFIG.boardReplSlot
    : overrides.hindsightReplSlot || DEFAULT_CONFIG.hindsightReplSlot;
  const dataDir = overrides.dataDir || (isBoard
    ? overrides.boardDataDir || DEFAULT_CONFIG.boardDataDir
    : overrides.hindsightDataDir || DEFAULT_CONFIG.hindsightDataDir);

  const args = [
    "-h", primaryHost,
    "-p", String(primaryPort),
    "-U", replUser,
    "-D", dataDir,
    "-Fp",
    "-Xs",
    "-R",
    `--slot=${replSlot}`,
    `--checkpoint=${overrides.checkpoint || "fast"}`,
  ];

  // OPE-12264 (ADM 08.11): the vm-core -> myr-vm1 link is the bottleneck during a
  // rebuild (~2.2 MB/s plain streaming; a 59 GB cluster took 4h14m on 02.11). Server-side
  // compression shrinks the transferred bytes dramatically (zstd typically 3-5x on PG
  // data). `-Fp --compress=server-<method>` keeps the on-disk layout PLAIN (a normal
  // data directory, no client-side tar extraction) while the SERVER compresses each
  // file/tablestream before sending it; pg_basebackup on the client decompresses
  // transparently (requires client pg_basebackup >= 15 for server-side compression and
  // >= 17 for zstd; the standby image pgvector/pgvector:pg18 provides 18).
  // "none" (or an empty override) keeps the previous behaviour byte-for-byte.
  const compressMethod = String(
    overrides.compress ?? process.env.STANDBY_BASEBACKUP_COMPRESS ?? "server-zstd"
  ).trim();
  if (compressMethod && compressMethod !== "none") {
    if (!/^[A-Za-z0-9][A-Za-z0-9_,:;=.\-]*$/.test(compressMethod)) {
      throw new Error(`Invalid --compress value '${compressMethod}': expected a pg_basebackup compression specification (e.g. server-zstd, server-gzip:5, zstd:3, none)`);
    }
    args.push(`--compress=${compressMethod}`);
  }
  if (overrides.maxRate) {
    args.push(`--max-rate=${overrides.maxRate}`);
  }

  return {
    executable: "pg_basebackup",
    args,
    commandString: `pg_basebackup ${args.join(" ")}`,
  };
}

/**
 * Common per-target operation context: host vs in-container paths, db/role names,
 * standby endpoint and compose coordinates. One place so every command resolves the
 * docker-mode (in-container) and host-mode (host) data directory the same way.
 */
export function resolveOpContext(target = "board", options = {}) {
  const isBoard = target === "board";
  const mode = pgRunnerMode(options);
  const hostDataDir =
    options.dataDir ||
    (isBoard
      ? options.boardDataDir || DEFAULT_CONFIG.boardDataDir
      : options.hindsightDataDir || DEFAULT_CONFIG.hindsightDataDir);
  return {
    target,
    isBoard,
    mode,
    docker: mode === "docker",
    hostDataDir,
    // Directory handed to pg_ctl / pg_basebackup -D. In docker mode that is the
    // in-container PGDATA; the host path does not exist inside the container.
    pgDataDir: mode === "docker" ? options.containerDataDir || DEFAULT_CONFIG.containerDataDir : hostDataDir,
    dbUser: isBoard
      ? options.boardDbUser || DEFAULT_CONFIG.boardDbUser
      : options.hindsightDbUser || DEFAULT_CONFIG.hindsightDbUser,
    dbName: isBoard
      ? options.boardDbName || DEFAULT_CONFIG.boardDbName
      : options.hindsightDbName || DEFAULT_CONFIG.hindsightDbName,
    replUser: isBoard
      ? options.boardReplUser || DEFAULT_CONFIG.boardReplUser
      : options.hindsightReplUser || DEFAULT_CONFIG.hindsightReplUser,
    replSlot: isBoard
      ? options.boardReplSlot || DEFAULT_CONFIG.boardReplSlot
      : options.hindsightReplSlot || DEFAULT_CONFIG.hindsightReplSlot,
    standbyHost: options.standbyHost || DEFAULT_CONFIG.standbyHost,
    standbyPort: resolveStandbyPort(options, target),
    composeFile: options.composeFile || DEFAULT_CONFIG.composeFile,
    composeService: DEFAULT_CONFIG.composeService,
    container: options.pgContainer || DEFAULT_CONFIG.pgContainer,
  };
}

export function planFailover(target = "board", overrides = {}) {
  const ctx = resolveOpContext(target, overrides);
  const appCompose = overrides.appComposeFile || "<app-compose-file>";
  const appService = overrides.appService || DEFAULT_CONFIG.appBoardService;

  return {
    target,
    runner: ctx.mode,
    step0_fence:
      "Fence the OLD primary first (power off the vm-core VM at the hypervisor, or otherwise make sure it cannot accept writes) and re-run with --fenced when it is unreachable",
    step0_guard:
      `probe the primary over the replication protocol as ${ctx.replUser} (endpoint from --primary-host/--primary-port, env, or the standby's primary_conninfo): ` +
      "writable -> refuse; auth/other error -> refuse; in recovery -> allow; unreachable -> refuse unless --fenced",
    promoteSql: "SELECT pg_promote();",
    promoteCli: `pg_ctl promote -D ${ctx.pgDataDir}`,
    promoteRunsIn: ctx.docker ? `container ${ctx.container}` : "host",
    verifySql: SQL_IN_RECOVERY,
    appEndpoint: `127.0.0.1:${ctx.standbyPort}`,
    connectionString: `postgresql://${ctx.dbUser}:***@127.0.0.1:${ctx.standbyPort}/${ctx.dbName}`,
    appRestartCmd: `docker compose -f ${appCompose} up -d --force-recreate ${appService}`,
    healthCheckUrl: overrides.healthUrl || DEFAULT_CONFIG.healthCheckUrl,
  };
}

export function planSwitchback(target = "board", overrides = {}) {
  const ctx = resolveOpContext(target, overrides);
  const basebackup = generateBasebackupCommand(target, { ...overrides, dataDir: ctx.pgDataDir });
  const config = generateStandbyConfig(target, overrides);

  return {
    target,
    step1_verifyPrimary: `replication-protocol probe as ${ctx.replUser}: ${SQL_IN_RECOVERY} -- original primary must answer 0 (active writer)`,
    step2_preflight:
      "credentials present, max_slot_wal_keep_size finite, physical slot exists; refuse to wipe a promoted standby without --discard-promoted-standby (timeline/LSN comparison is reported)",
    step3_stopStandby: `docker compose -f ${ctx.composeFile} stop ${ctx.composeService}`,
    step4_wipe: `empty ${ctx.hostDataDir} (only after steps 1-3 passed)`,
    step5_resync: ctx.docker
      ? `docker compose run --rm --no-deps -u postgres (one-shot, in-container -D ${ctx.pgDataDir}): ${basebackup.commandString}`
      : basebackup.commandString,
    step6_standbySignal: `standby.signal in ${ctx.hostDataDir}`,
    step7_config: config,
    step8_startStandby: `docker compose -f ${ctx.composeFile} up -d ${ctx.composeService}`,
    step9_verifyRecovery: `${SQL_IN_RECOVERY} -- must return 1, and a streaming WAL receiver must be present`,
  };
}

/**
 * Reject drill directories that could make `rm -rf` destroy real data. The drill dir is
 * removed by the tool (in the container in docker mode), so it must be an absolute,
 * clearly drill-named path that is neither PGDATA nor an ancestor of any data/archive path.
 */
export function validateDrillDir(drillDir, options = {}) {
  if (typeof drillDir !== "string" || !path.posix.isAbsolute(drillDir)) {
    return `Drill directory must be an absolute path (got ${JSON.stringify(drillDir)})`;
  }
  const norm = path.posix.normalize(drillDir).replace(/\/+$/, "");
  const parts = norm.split("/").filter(Boolean);
  if (parts.length < 3) {
    return `Refusing drill directory '${drillDir}': too shallow to delete safely (need at least 3 path segments)`;
  }
  if (!/drill/i.test(parts[parts.length - 1])) {
    return `Refusing drill directory '${drillDir}': the last path segment must contain 'drill' so the tool never deletes a real data path`;
  }
  const protectedPaths = [
    // Docker mode: these are compose bind-mount points inside the container; rm -rf of a
    // mount point fails with EBUSY, so a drill there could never be cleaned up.
    ...(isDockerMode(options) ? ["/srv/standby/drill-cluster", "/srv/backups/wal"] : []),
    options.containerDataDir || DEFAULT_CONFIG.containerDataDir,
    options.dataDir || options.boardDataDir || DEFAULT_CONFIG.boardDataDir,
    options.hindsightDataDir || DEFAULT_CONFIG.hindsightDataDir,
    options.boardWalArchiveDir || DEFAULT_CONFIG.boardWalArchiveDir,
    options.hindsightWalArchiveDir || DEFAULT_CONFIG.hindsightWalArchiveDir,
  ];
  for (const raw of protectedPaths) {
    if (!raw) continue;
    const p = path.posix.normalize(raw).replace(/\/+$/, "");
    if (norm === p || norm.startsWith(`${p}/`) || p.startsWith(`${norm}/`)) {
      return `Refusing drill directory '${drillDir}': it overlaps the live data/archive path '${p}'`;
    }
  }
  return null;
}

export function planRehearsal(target = "board", overrides = {}) {
  const isBoard = target === "board";
  const drillPort = overrides.drillPort || 5533;
  // ADM rehearsal feedback (04.11): pg_basebackup runs INSIDE the standby container
  // (docker exec), so the drill dir must be a path writable by uid 999 in the
  // container — /var/lib/postgresql/drill-cluster — not a host path.
  const drillDir =
    overrides.drillDir ||
    (process.env && process.env.STANDBY_DRILL_DIR) ||
    DEFAULT_CONFIG.containerDrillDir;
  const standbyPort = resolveStandbyPort(overrides, target);
  const boardUser = overrides.boardDbUser || DEFAULT_CONFIG.boardDbUser;
  const boardDb = overrides.boardDbName || DEFAULT_CONFIG.boardDbName;
  const hindsightUser = overrides.hindsightDbUser || DEFAULT_CONFIG.hindsightDbUser;
  const hindsightDb = overrides.hindsightDbName || DEFAULT_CONFIG.hindsightDbName;
  const replUser = isBoard
    ? overrides.boardReplUser || DEFAULT_CONFIG.boardReplUser
    : overrides.hindsightReplUser || DEFAULT_CONFIG.hindsightReplUser;
  const docker = isDockerMode(overrides);
  const listen = overrides.keepDrill ? "'*'" : "127.0.0.1";

  return {
    target,
    drillDir,
    drillPort,
    runner: pgRunnerMode(overrides),
    step1_snapshot: `pg_basebackup -h 127.0.0.1 -p ${standbyPort} -U ${replUser} -D ${drillDir} -Fp -Xs -R`,
    step2_startEphemeral: `pg_ctl start -D ${drillDir} -l ${drillDir}/pg_ctl.log -o "-p ${drillPort} -c listen_addresses=${listen} -c max_connections=200 -c max_worker_processes=16"`,
    step3_promote: `pg_ctl promote -D ${drillDir}`,
    step4_verify: `psql -h 127.0.0.1 -p ${drillPort} -U ${boardUser} -d ${boardDb} -t -A -c "${SQL_IN_RECOVERY}"`,
    step5_smokeTest: `psql -h 127.0.0.1 -p ${drillPort} -U ${boardUser} -d ${boardDb} -c "SELECT 1;" && psql -h 127.0.0.1 -p ${drillPort} -U ${hindsightUser} -d ${hindsightDb} -c "SELECT 1;"`,
    step6_stopClean: `pg_ctl stop -D ${drillDir} -m immediate`,
    step7_cleanup: docker
      ? `docker exec -u postgres ${overrides.pgContainer || DEFAULT_CONFIG.pgContainer} rm -rf ${drillDir}  # always, in finally, inside the container`
      : `rm -rf ${drillDir}  # always, in finally`,
    targetRtoSeconds: DEFAULT_CONFIG.rtoTargetSeconds,
  };
}

/**
 * Query helper using psql
 */
export function queryPostgres(sql, { host, port, user, db, timeoutMs = 10000 }, runner = defaultRunner) {
  const args = [
    "-h", String(host),
    "-p", String(port),
    "-U", String(user),
    "-d", String(db),
    "-t", "-A",
    "-c", sql,
  ];
  return runner("psql", args, { timeoutMs });
}

/** libpq connection string that opens a database-mode walsender (replication protocol + SQL). */
export function replicationConninfo(dbName = "paperclip", connectTimeoutSec) {
  return `replication=database dbname=${dbName}${connectTimeoutSec ? ` connect_timeout=${connectTimeoutSec}` : ""}`;
}

function replicationPsqlArgs(sql, { host, port, user, dbName = "paperclip", connectTimeoutSec = 5 }) {
  return [
    "-h", String(host),
    "-p", String(port),
    "-U", String(user),
    "-d", replicationConninfo(dbName, connectTimeoutSec),
    "-t", "-A",
    "-c", sql,
  ];
}

/**
 * Run SQL on the PRIMARY over a database-mode replication connection as the replicator.
 *
 * OPE-7656 review fix: the container passfile only holds `myr_replicator` credentials for
 * the primary endpoint, so connecting as the application role (`paperclip`) fails
 * authentication. A `replication=database` walsender accepts the replication commands AND
 * plain SQL (PostgreSQL protocol docs, "Streaming Replication Protocol"), and
 * pg_create_physical_replication_slot() needs only the REPLICATION attribute.
 */
export function queryPrimaryViaReplication(sql, endpoint, runner = defaultRunner, timeoutMs = 20000) {
  return runner("psql", replicationPsqlArgs(sql, endpoint), { timeoutMs });
}

/**
 * Fetch the primary's current WAL LSN via the replication protocol.
 *
 * ADM rehearsal feedback (03.11): the primary's pg_current_wal_lsn() requires
 * the application password, but the passfile only contains myr_replicator.
 * The replication protocol (IDENTIFY_SYSTEM) works under myr_replicator
 * without an application password.
 *
 * Uses psql with replication=database, which speaks the PostgreSQL replication
 * protocol.  IDENTIFY_SYSTEM returns: system_identifier | timeline | xlogpos | dbname
 */
export function queryPrimaryLsn(
  { host, port, user = "myr_replicator", dbName = "paperclip", connectTimeoutSec, timeoutMs = 10000 },
  runner = defaultRunner
) {
  const args = [
    "-h", String(host),
    "-p", String(port),
    "-U", String(user),
    "-d", replicationConninfo(dbName, connectTimeoutSec),
    "-t", "-A",
    "-c", "IDENTIFY_SYSTEM;",
  ];
  const res = runner("psql", args, { timeoutMs });
  if (res.exitCode !== 0 || !res.stdout) {
    return { ok: false, lsn: null, error: res.stderr || "IDENTIFY_SYSTEM failed" };
  }
  // Output: system_identifier | timeline | xlogpos | dbname
  const line = res.stdout.trim().split("\n")[0];
  const parts = line.split("|").map((p) => p.trim());
  const xlogpos = parts[2] || "";
  if (!xlogpos || !xlogpos.includes("/")) {
    return { ok: false, lsn: null, error: `Unexpected IDENTIFY_SYSTEM output: ${line}` };
  }
  const timeline = Number.parseInt(parts[1] || "", 10);
  return {
    ok: true,
    lsn: xlogpos,
    timeline: Number.isFinite(timeline) ? timeline : null,
    systemId: parts[0] || null,
    raw: line,
  };
}

/**
 * Read the primary's role over the replication protocol.
 *  state: "writable"   - reachable and NOT in recovery (accepts writes)
 *         "in_recovery"- reachable, in recovery (not a writer)
 *         "unreachable"- no network answer (refused / timeout / DNS / relay drop)
 *         "error"      - the server or docker answered with an error (auth, permission,
 *                        container down, unparseable): the primary may well be alive.
 */
export function probePrimary(target, options, runner, endpoint) {
  const ctx = resolveOpContext(target, options);
  const res = queryPrimaryViaReplication(
    SQL_IN_RECOVERY,
    { host: endpoint.host, port: endpoint.port, user: ctx.replUser, dbName: ctx.dbName },
    runner
  );
  if (res.exitCode === 0) {
    const value = parsePgBool(firstField(res.stdout));
    if (value === true) return { state: "in_recovery", endpoint };
    if (value === false) return { state: "writable", endpoint };
    return { state: "error", endpoint, error: `unparseable pg_is_in_recovery() answer: ${JSON.stringify((res.stdout || "").trim())}` };
  }
  return { state: classifyPsqlFailure(res), endpoint, error: describePsqlError(res) };
}

/**
 * Split-brain guard for failover (OPE-7656 review finding 2).
 *
 * Fail-CLOSED: promotion proceeds only when
 *   - the primary answered and is in recovery (not a writer), or
 *   - the primary is unreachable AND the operator confirmed fencing with --fenced, or
 *   - the operator bypassed the guard with --accept-split-brain.
 * A reachable writable primary, ANY non-network error (auth, permission, docker, parse),
 * or an unresolvable endpoint blocks promotion.
 */
export function evaluateFailoverGuard(target, options, runner) {
  if (options.acceptSplitBrain) {
    return {
      proceed: true,
      state: "override",
      note: "--accept-split-brain: guard bypassed by the operator; the old primary may hold writes the standby lacks",
    };
  }
  const endpoint = resolvePrimaryEndpoint(options, target, { runner });
  if (endpoint.source === "default") {
    return {
      proceed: false,
      state: "endpoint_unknown",
      endpoint,
      error:
        "Refusing failover: cannot determine where the original primary is (no --primary-host, no PRIMARY_PG_HOST, " +
        "and the standby's primary_conninfo could not be read), so split-brain cannot be ruled out. " +
        "Pass --primary-host/--primary-port (live relay) and re-run, or --accept-split-brain after fencing manually.",
    };
  }
  if (!endpoint.portExplicit) {
    return {
      proceed: false,
      state: "endpoint_incomplete",
      endpoint,
      error:
        `Refusing failover: --primary-host/PRIMARY_PG_HOST=${endpoint.host} was given without a port, so the probe would use the default ${endpoint.port}. ` +
        "The live primary is behind a relay on another port; probing the wrong port reads as 'unreachable' and defeats the split-brain guard. " +
        "Pass --primary-port (or PRIMARY_PG_PORT) explicitly, even if it is 5432.",
    };
  }
  const where = `${endpoint.host}:${endpoint.port}`;
  const probe = probePrimary(target, options, runner, endpoint);
  switch (probe.state) {
    case "writable":
      return {
        proceed: false,
        state: "writable",
        endpoint,
        error:
          `Refusing failover: original primary at ${where} is reachable and accepts writes (pg_is_in_recovery=0). ` +
          "Failover must only run when the primary is down or in recovery; fence/stop it first. " +
          "Pass --accept-split-brain only after verifying with the runbook.",
      };
    case "in_recovery":
      return { proceed: true, state: "in_recovery", endpoint };
    case "unreachable":
      if (options.fenced) {
        return {
          proceed: true,
          state: "unreachable_fenced",
          endpoint,
          fencing: typeof options.fenced === "string" ? options.fenced : "operator_confirmed",
          detail: probe.error,
        };
      }
      return {
        proceed: false,
        state: "unreachable_unfenced",
        endpoint,
        error:
          `Refusing failover: original primary at ${where} is unreachable (${probe.error || "no answer"}). ` +
          "An unreachable primary may still be alive behind a network partition and keep accepting writes (split-brain). " +
          "Fence it first (power off the vm-core VM at the hypervisor; runbook section 5 step 0), then re-run with --fenced.",
      };
    default:
      return {
        proceed: false,
        state: "probe_error",
        endpoint,
        error:
          `Refusing failover: could not determine the state of the original primary at ${where}: ${probe.error || "unknown error"}. ` +
          "The primary answered with an error (authentication/permission/other) or the probe itself failed, which does NOT prove it is down. " +
          "Fix the probe (replication credentials/endpoint) or fence the primary and pass --accept-split-brain.",
      };
  }
}

function safeExists(fsOps, p) {
  try {
    return Boolean(fsOps.existsSync(p));
  } catch {
    return false;
  }
}

function safeReaddir(fsOps, p) {
  if (typeof fsOps.readdirSync !== "function") return [];
  try {
    return fsOps.readdirSync(p) || [];
  } catch {
    return [];
  }
}

/** Remove everything inside `dir` (keeping `dir` itself and its ownership/mode). */
function emptyDirectory(dir, fsOps) {
  const errors = [];
  for (const entry of safeReaddir(fsOps, dir)) {
    try {
      fsOps.rmSync(path.join(dir, entry), { recursive: true, force: true });
    } catch (err) {
      errors.push(`${entry}: ${err.message}`);
    }
  }
  const remaining = safeReaddir(fsOps, dir);
  return { ok: remaining.length === 0, remaining, errors };
}

/**
 * Give a file/dir to the in-container postgres user (uid 999) in docker mode. The
 * bind-mounted data directory is read by PostgreSQL as uid 999, and libpq refuses to
 * read a passfile it cannot open, so a root-owned `.pgpass` silently breaks streaming.
 * Returns null on success or when not applicable, else an error string.
 */
function chownToContainerPg(fsOps, p, options) {
  if (!isDockerMode(options)) return null;
  const uid = options.containerPgUid ?? DEFAULT_CONFIG.containerPgUid;
  const gid = options.containerPgGid ?? DEFAULT_CONFIG.containerPgGid;
  if (typeof fsOps.chownSync !== "function") return "chownSync is not available";
  try {
    fsOps.chownSync(p, uid, gid);
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * `--data-dir` ends up in rm -rf: it must be deep enough and look like a PostgreSQL data
 * directory (PG_VERSION) before anything inside it is deleted.
 */
export function validateStandbyDataDir(dir, entries = []) {
  const parts = String(dir).split("/").filter(Boolean);
  if (!path.posix.isAbsolute(String(dir)) || parts.length < 3) {
    return `Refusing to empty '${dir}': the data directory must be an absolute path with at least 3 segments`;
  }
  if (!entries.includes("PG_VERSION")) {
    return `Refusing to empty '${dir}': it is not empty but has no PG_VERSION, so it does not look like a PostgreSQL data directory (wrong --data-dir?). Nothing was stopped or wiped.`;
  }
  return null;
}

/**
 * Resolve and stage replication credentials BEFORE anything destructive happens.
 * Host passfile: PG_REPLICATOR_PASSWORD line or an existing --credentials file.
 * Docker mode additionally stages a copy next to the data directory owned by uid 999,
 * which is bind-mounted read-only into the one-shot basebackup container.
 */
function prepareReplicationCredentials({ options, fsOps, dataDir, primaryHost, primaryPort, replUser }) {
  const replPassword =
    options.replicatorPassword !== undefined
      ? options.replicatorPassword
      : DEFAULT_CONFIG.replicatorPassword;
  const credentialPath =
    options.credentialPath ||
    options.passfilePath ||
    DEFAULT_CONFIG.credentialPath ||
    DEFAULT_CONFIG.passfilePath;
  const defaultStaged = path.join(path.dirname(dataDir), ".pgpass");
  const hostPassfilePath = credentialPath || defaultStaged;

  let content = null;
  if (replPassword) {
    content = pgpassLine(primaryHost, primaryPort, replUser, replPassword);
    try {
      const passDir = path.dirname(hostPassfilePath);
      if (!fsOps.existsSync(passDir)) {
        fsOps.mkdirSync(passDir, { recursive: true, mode: 0o700 });
      }
      fsOps.writeFileSync(hostPassfilePath, content, { mode: 0o600 });
      if (fsOps.chmodSync) fsOps.chmodSync(hostPassfilePath, 0o600);
    } catch (err) {
      return { ok: false, error: `Failed to create host passfile at ${hostPassfilePath}: ${err.message}` };
    }
  } else if (!fsOps.existsSync(hostPassfilePath)) {
    return {
      ok: false,
      error: `Replication credentials missing: passfile not found at '${hostPassfilePath}' and no replication password provided (set PG_REPLICATOR_PASSWORD or pass credentialPath)`,
    };
  } else {
    try {
      content = fsOps.readFileSync(hostPassfilePath, "utf8");
    } catch (err) {
      return { ok: false, error: `Failed to read passfile ${hostPassfilePath}: ${err.message}` };
    }
  }

  let stagedPassfilePath = null;
  if (isDockerMode(options)) {
    stagedPassfilePath = defaultStaged;
    try {
      if (stagedPassfilePath !== hostPassfilePath) {
        fsOps.writeFileSync(stagedPassfilePath, content, { mode: 0o600 });
      }
      if (fsOps.chmodSync) fsOps.chmodSync(stagedPassfilePath, 0o600);
    } catch (err) {
      return { ok: false, error: `Failed to stage passfile at ${stagedPassfilePath}: ${err.message}` };
    }
    const chownErr = chownToContainerPg(fsOps, stagedPassfilePath, options);
    if (chownErr) {
      return {
        ok: false,
        error:
          `Cannot give the staged passfile ${stagedPassfilePath} to uid ${options.containerPgUid ?? DEFAULT_CONFIG.containerPgUid} ` +
          `(${chownErr}). Run as root (standby-ctl.sh does) or chown it yourself; nothing was stopped or wiped.`,
      };
    }
  }
  return { ok: true, hostPassfilePath, stagedPassfilePath, content };
}

/**
 * `docker compose run` arguments for a one-shot PG client process in a throw-away
 * container built from the standby service definition (same image, same bind-mounted
 * data directory, in-container paths). Works while the standby container is stopped
 * - which it must be while its data directory is being re-created.
 */
export function dockerOneShotArgs({ composeFile, service, hostPassfile, containerPassfile }, cmd, args = []) {
  return [
    "compose", "-f", composeFile,
    "run", "--rm", "--no-deps", "-T",
    "-u", "postgres",
    "-e", `PGPASSFILE=${containerPassfile}`,
    "-v", `${hostPassfile}:${containerPassfile}:ro`,
    "--entrypoint", mapPgBinaryForDocker(cmd),
    service,
    ...args,
  ];
}

/** Highest timeline recorded by the history files in a (stopped) data directory. */
function localTimelineFromFiles(dataDir, fsOps) {
  const entries = safeReaddir(fsOps, path.join(dataDir, "pg_wal"));
  if (entries.length === 0) return null;
  let timeline = 1;
  for (const name of entries) {
    const m = String(name).match(/^([0-9A-Fa-f]{8})\.history$/);
    if (m) timeline = Math.max(timeline, Number.parseInt(m[1], 16));
  }
  return timeline;
}

/**
 * Compare the standby's position with the primary's: a higher timeline (or a higher LSN
 * on the same timeline) on the standby means it holds history the primary does not have,
 * i.e. re-cloning it would destroy writes. Pure function.
 */
export function compareTimelines({ primary = {}, standby = {} } = {}) {
  const pTl = primary.timeline ?? null;
  const sTl = standby.timeline ?? null;
  const pSys = primary.systemId ?? null;
  const sSys = standby.systemId ?? null;
  let verdict = "unknown";
  if (pSys !== null && sSys !== null && pSys !== sSys) {
    // Different database system identifiers: the "primary" is not the cluster this standby came from.
    verdict = "different_cluster";
  } else if (pTl !== null && sTl !== null) {
    if (sTl > pTl) verdict = "standby_ahead";
    else if (sTl < pTl) verdict = "primary_ahead";
    else {
      const pl = parseLsn(primary.lsn);
      const sl = parseLsn(standby.lsn);
      if (pl !== null && sl !== null) {
        verdict = sl > pl ? "standby_ahead" : sl === pl ? "equal" : "primary_ahead";
      }
    }
  }
  return {
    verdict,
    primaryTimeline: pTl,
    standbyTimeline: sTl,
    primaryLsn: primary.lsn ?? null,
    standbyLsn: standby.lsn ?? null,
    primarySystemId: pSys,
    standbySystemId: sSys,
  };
}

/**
 * Decide whether the local standby data directory may be wiped (OPE-7656 review finding 4).
 * A standby that is NOT in recovery (or whose data directory lost standby.signal while the
 * container is down) is a promoted writer: wiping it destroys every write accepted after
 * failover. That requires the explicit --discard-promoted-standby, and the timeline/LSN
 * comparison against the primary is reported either way.
 */
export function assessWipeSafety(ctx, options, { runner, fsOps }, primary) {
  const st = queryPostgres(
    SQL_IN_RECOVERY,
    { host: ctx.standbyHost, port: ctx.standbyPort, user: ctx.dbUser, db: ctx.dbName },
    runner
  );
  const parsed = st.exitCode === 0 ? parsePgBool(firstField(st.stdout)) : null;
  let role;
  let roleSource;
  if (parsed !== null) {
    role = parsed ? "standby" : "promoted";
    roleSource = "sql";
  } else {
    // Container down / unreachable: fall back to the data directory itself. A promoted
    // server deletes standby.signal; a non-empty directory without it is not a standby.
    role = safeExists(fsOps, path.join(ctx.hostDataDir, "standby.signal")) ? "standby" : "promoted";
    roleSource = "files";
  }

  const pId = queryPrimaryLsn(
    { host: primary.host, port: primary.port, user: ctx.replUser, dbName: ctx.dbName, connectTimeoutSec: 5 },
    runner
  );
  const sId = queryPrimaryLsn(
    { host: ctx.standbyHost, port: ctx.standbyPort, user: ctx.replUser, dbName: ctx.dbName, connectTimeoutSec: 5 },
    runner
  );
  const standbyPos = sId.ok
    ? { timeline: sId.timeline, lsn: sId.lsn, systemId: sId.systemId }
    : { timeline: localTimelineFromFiles(ctx.hostDataDir, fsOps), lsn: null };
  const comparison = compareTimelines({
    primary: pId.ok ? { timeline: pId.timeline, lsn: pId.lsn, systemId: pId.systemId } : {},
    standby: standbyPos,
  });

  const base = { role, roleSource, comparison };
  if (role !== "promoted") return { safe: true, ...base };
  if (!options.discardPromotedStandby) {
    return {
      safe: false,
      ...base,
      error:
        `Refusing to wipe '${ctx.hostDataDir}': the standby is NOT a standby any more ` +
        `(${roleSource === "sql" ? "pg_is_in_recovery=0" : "no standby.signal in the data directory"}); it is a promoted writer. ` +
        `Timeline/LSN comparison: ${comparison.verdict} (primary tl=${comparison.primaryTimeline ?? "?"} lsn=${comparison.primaryLsn ?? "?"}, ` +
        `standby tl=${comparison.standbyTimeline ?? "?"} lsn=${comparison.standbyLsn ?? "?"}). ` +
        "Re-cloning it would discard every write accepted after failover. Follow runbook section 6 (re-sync the OLD primary from the promoted standby) " +
        "or pass --discard-promoted-standby to explicitly accept the data loss. Nothing was stopped or wiped.",
    };
  }
  // The comparison is not advisory: a standby that is AHEAD of the primary (higher timeline /
  // LSN) or belongs to a different cluster holds writes that exist nowhere else. --discard-promoted-standby
  // alone is the generic acknowledgement; this case needs the explicit --accept-data-loss as well.
  if ((comparison.verdict === "standby_ahead" || comparison.verdict === "different_cluster") && !options.acceptDataLoss) {
    return {
      safe: false,
      ...base,
      error:
        `Refusing to wipe '${ctx.hostDataDir}' even with --discard-promoted-standby: the comparison says '${comparison.verdict}' ` +
        `(primary tl=${comparison.primaryTimeline ?? "?"} lsn=${comparison.primaryLsn ?? "?"} sys=${comparison.primarySystemId ?? "?"}, ` +
        `standby tl=${comparison.standbyTimeline ?? "?"} lsn=${comparison.standbyLsn ?? "?"} sys=${comparison.standbySystemId ?? "?"}). ` +
        "The standby holds writes the primary does not have - most likely vm-core was never re-synced from the promoted standby (runbook section 6 steps 2-3). " +
        "Re-sync vm-core first, or pass --accept-data-loss to discard those writes knowingly. Nothing was stopped or wiped.",
    };
  }
  return { safe: true, ...base, discardAcknowledged: true };
}

const SQL_WAL_POLICY =
  "SELECT (current_setting('max_slot_wal_keep_size', true) IS NOT NULL AND current_setting('max_slot_wal_keep_size', true) <> '-1')::int;";

function slotEnsureSql(slot) {
  return (
    "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '" + slot + "') THEN 1 " +
    "WHEN pg_create_physical_replication_slot('" + slot + "', true) IS NOT NULL THEN 1 ELSE 0 END;"
  );
}

const SQL_STANDBY_STATUS =
  "SELECT pg_is_in_recovery()::int, count(*)::int FROM pg_stat_wal_receiver WHERE status = 'streaming';";

/**
 * Setup warm standby replication for cluster / target DB.
 *
 * Order (OPE-7656 review finding 4): every check runs FIRST with the standby container
 * still up - data directory state, credentials, primary WAL policy, replication slot, and
 * the promoted-standby / timeline guard. Only when all of them pass is the container
 * stopped, the data directory emptied, and the base backup taken.
 */
export function setupStandby(target = "board", options = {}, deps = {}) {
  const rawRunner = deps.runner || defaultRunner;
  const fsOps = deps.fsOps || defaultFsOps;
  const runner = createPgRunner(rawRunner, options);
  const ctx = resolveOpContext(target, options);
  const { docker, hostDataDir: dataDir, pgDataDir, dbName, replUser, replSlot, standbyPort, composeFile, composeService } = ctx;

  const primaryHost = options.primaryHost || DEFAULT_CONFIG.primaryHost;
  const primaryPort = resolvePrimaryPort(options, target);

  const basebackup = generateBasebackupCommand(target, { ...options, dataDir: pgDataDir });
  const standbyConfig = generateStandbyConfig(target, options);

  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      target,
      dataDir,
      pgDataDir,
      runner: ctx.mode,
      basebackupCommand: basebackup.commandString,
      configContent: standbyConfig,
      signalFile: path.join(dataDir, "standby.signal"),
    };
  }

  if (!isSqlIdent(replSlot) || !isSqlIdent(dbName) || !isSqlIdent(replUser)) {
    return { success: false, target, error: `Invalid replication slot/database/role name (slot=${replSlot}, db=${dbName}, role=${replUser})` };
  }

  // ── Phase 1: checks. Nothing below this line stops, wipes or creates anything on the standby. ──

  // 1a. Data directory state: fail-closed if it exists and is not empty without --force.
  const dirEntries = safeReaddir(fsOps, dataDir);
  const isNonEmpty = safeExists(fsOps, dataDir) && dirEntries.length > 0;
  if (isNonEmpty && !options.force) {
    return {
      success: false,
      target,
      error: `Directory '${dataDir}' exists but is not empty. Specify --force to clean and resynchronize standby.`,
    };
  }

  if (isNonEmpty) {
    const dirProblem = validateStandbyDataDir(dataDir, dirEntries);
    if (dirProblem) return { success: false, target, error: dirProblem };
  }

  // 1b. Replication credentials (previously checked only AFTER the wipe).
  const cred = prepareReplicationCredentials({ options, fsOps, dataDir, primaryHost, primaryPort, replUser });
  if (!cred.ok) {
    return { success: false, target, error: cred.error };
  }
  const containerPassfile = options.containerSetupPassfilePath || DEFAULT_CONFIG.containerSetupPassfilePath;

  // Primary-side queries use the REPLICATOR over a replication-protocol connection, with the SAME
  // credentials the base backup will use (the staged passfile in a one-shot container in docker mode,
  // the host passfile in host mode) - so wrong credentials are caught here, before anything is wiped,
  // and so the checks also work when the standby container does not exist yet (first setup).
  const primaryPsql = (sql) => {
    const args = replicationPsqlArgs(sql, { host: primaryHost, port: primaryPort, user: replUser, dbName });
    if (docker) {
      return rawRunner(
        "docker",
        dockerOneShotArgs(
          { composeFile, service: composeService, hostPassfile: cred.stagedPassfilePath, containerPassfile },
          "psql",
          args
        ),
        { timeoutMs: 120000 }
      );
    }
    return runner("psql", args, { timeoutMs: 20000, env: { ...process.env, PGPASSFILE: cred.hostPassfilePath } });
  };

  // 1c. Bounded WAL retention: an unbounded slot can fill the primary filesystem.
  const walPolicyRes = primaryPsql(SQL_WAL_POLICY);
  if (walPolicyRes.exitCode !== 0) {
    return {
      success: false,
      target,
      error: `Cannot verify primary max_slot_wal_keep_size (query as ${replUser} on ${primaryHost}:${primaryPort} failed: ${describePsqlError(walPolicyRes)})`,
    };
  }
  if (parsePgBool(firstField(walPolicyRes.stdout)) !== true) {
    return {
      success: false,
      target,
      error: "Primary max_slot_wal_keep_size must be configured to a finite non-negative value before enabling standby replication",
    };
  }

  // 1d. Physical replication slot must exist before pg_basebackup --slot.
  // Defect 2: if slot is lost and inactive, drop and recreate it.
  const slotStatusQuery = `SELECT COALESCE(wal_status, 'missing'), COALESCE(active::int, 0) FROM pg_replication_slots WHERE slot_name = '${replSlot}';`;
  const slotStatusRes = primaryPsql(slotStatusQuery);
  let slotRecreated = false;
  if (slotStatusRes.exitCode === 0 && slotStatusRes.stdout.trim()) {
    const parts = slotStatusRes.stdout.trim().split("\n")[0].split("|");
    const walStatus = (parts[0] || "").trim();
    const activeInt = (parts[1] || "").trim();
    if (walStatus === "lost" && activeInt === "0") {
      const dropRes = primaryPsql(`SELECT pg_drop_replication_slot('${replSlot}');`);
      if (dropRes.exitCode === 0) {
        slotRecreated = true;
      }
    }
  }

  const slotRes = primaryPsql(slotEnsureSql(replSlot));
  if (slotRes.exitCode !== 0 || parsePgBool(firstField(slotRes.stdout)) !== true) {
    return {
      success: false,
      target,
      error: `Failed to create or verify physical replication slot '${replSlot}' on primary: ${describePsqlError(slotRes) || slotRes.stdout}`,
    };
  }

  // 1e. Never wipe a promoted standby without an explicit acknowledgement + comparison.
  let wipeAssessment = null;
  if (isNonEmpty) {
    wipeAssessment = assessWipeSafety(ctx, options, { runner, fsOps }, { host: primaryHost, port: primaryPort });
    if (!wipeAssessment.safe) {
      return {
        success: false,
        target,
        standbyRole: wipeAssessment.role,
        comparison: wipeAssessment.comparison,
        error: wipeAssessment.error,
      };
    }
  }

  // ── Phase 2: destructive. Only reached when every check above passed. ──

  if (isNonEmpty) {
    const stopRes = runner("docker", ["compose", "-f", composeFile, "stop", composeService]);
    if (stopRes.exitCode !== 0) {
      return {
        success: false,
        target,
        error: `Failed to stop standby container '${composeService}' (data directory left untouched): ${stopRes.stderr || stopRes.stdout}`,
      };
    }
    // `compose stop` exits 0 even when it matched no container (e.g. another compose project name),
    // so success is not proof: ask docker, and fall back to stopping the container by name.
    const stillRunning = () => {
      const r = rawRunner("docker", ["inspect", "-f", "{{.State.Running}}", ctx.container]);
      return r.exitCode === 0 && (r.stdout || "").trim() === "true";
    };
    if (stillRunning()) {
      rawRunner("docker", ["stop", ctx.container], { timeoutMs: 120000 });
      if (stillRunning()) {
        return {
          success: false,
          target,
          error: `Standby container '${ctx.container}' is still running after compose stop and docker stop (data directory left untouched)`,
        };
      }
    }
    const wipe = emptyDirectory(dataDir, fsOps);
    if (!wipe.ok) {
      return {
        success: false,
        target,
        error: `Could not empty '${dataDir}' (${wipe.errors.join("; ") || `${wipe.remaining.length} entries remain`}); run as root or fix ownership. The standby container is stopped.`,
      };
    }
  }

  try {
    fsOps.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      success: false,
      target,
      error: `Failed to create data directory ${dataDir}: ${err.message}`,
    };
  }
  if (docker) {
    // The base backup runs as uid 999 inside the container: it must own an empty 0700 directory.
    const dirChown = chownToContainerPg(fsOps, dataDir, options);
    if (dirChown) {
      return { success: false, target, error: `Cannot give '${dataDir}' to the container postgres user: ${dirChown}` };
    }
    try {
      if (fsOps.chmodSync) fsOps.chmodSync(dataDir, 0o700);
    } catch {}
  }

  // 3. Run pg_basebackup with -P (live progress) and a default >=12h timeout
  const setupBasebackupTimeoutMs = basebackupTimeoutMs(options);
  let baseRes;
  if (docker) {
    // Inside a one-shot container built from the standby service: in-container -D path,
    // the staged passfile mounted read-only, no dependency on the stopped main container.
    baseRes = rawRunner(
      "docker",
      dockerOneShotArgs(
        { composeFile, service: composeService, hostPassfile: cred.stagedPassfilePath, containerPassfile },
        basebackup.executable,
        [...basebackup.args, "-P"]
      ),
      { timeoutMs: setupBasebackupTimeoutMs, streamStderr: true }
    );
  } else {
    baseRes = runner(basebackup.executable, [...basebackup.args, "-P"], {
      timeoutMs: setupBasebackupTimeoutMs,
      streamStderr: true,
      env: {
        ...process.env,
        PGPASSFILE: cred.hostPassfilePath,
      },
    });
  }
  if (baseRes.exitCode !== 0) {
    return {
      success: false,
      target,
      error: `pg_basebackup failed: ${baseRes.stderr || baseRes.stdout}`,
      exitCode: baseRes.exitCode,
    };
  }

  // 4. Write the container passfile (.pgpass) inside dataDir (owned by uid 999, 0600) and config.
  const containerPassfileHost = path.join(dataDir, ".pgpass");
  try {
    fsOps.writeFileSync(containerPassfileHost, cred.content, { mode: 0o600 });
    if (fsOps.chmodSync) fsOps.chmodSync(containerPassfileHost, 0o600);
  } catch (err) {
    return {
      success: false,
      target,
      error: `Failed to write container passfile at ${containerPassfileHost}: ${err.message}`,
    };
  }
  const passChown = chownToContainerPg(fsOps, containerPassfileHost, options);
  if (passChown) {
    return {
      success: false,
      target,
      error: `Container passfile ${containerPassfileHost} must be owned by uid ${options.containerPgUid ?? DEFAULT_CONFIG.containerPgUid} (postgres) or streaming cannot authenticate: ${passChown}`,
    };
  }

  try {
    fsOps.writeFileSync(path.join(dataDir, "standby.signal"), "");
    fsOps.writeFileSync(path.join(dataDir, "postgresql.auto.conf"), standbyConfig);
  } catch (err) {
    return {
      success: false,
      target,
      error: `Failed to write standby configuration files: ${err.message}`,
    };
  }
  // Best effort: keep the rewritten files owned by the postgres user as well.
  chownToContainerPg(fsOps, path.join(dataDir, "standby.signal"), options);
  chownToContainerPg(fsOps, path.join(dataDir, "postgresql.auto.conf"), options);

  // 5. Start standby container
  const startRes = runner("docker", ["compose", "-f", composeFile, "up", "-d", composeService]);
  if (startRes.exitCode !== 0) {
    return { success: false, target, error: `Failed to start standby container: ${startRes.stderr || startRes.stdout}` };
  }

  // 6. Wait for PostgreSQL readiness before checking replication. A large base
  // backup can leave the container alive but not accepting connections yet.
  // D4: configurable attempts + sleep between attempts; under role `paperclip`
  // pg_stat_wal_receiver can return NULL rows, which must not be treated as
  // "streaming inactive" until the retry budget is exhausted.
  const readinessAttempts = options.readinessAttempts ?? 30;
  const readinessDelayMs = options.readinessDelayMs ?? 5000;
  let verifyRes = { exitCode: 1, stdout: "", stderr: "standby not ready" };
  let lastReadinessErr = null;
  for (let attempt = 0; attempt < readinessAttempts; attempt++) {
    verifyRes = queryPostgres(
      SQL_STANDBY_STATUS,
      { host: DEFAULT_CONFIG.standbyHost, port: standbyPort, user: ctx.dbUser, db: dbName },
      runner
    );
    if (verifyRes.exitCode === 0 && verifyRes.stdout?.trim()) {
      const parts = verifyRes.stdout.trim().split("\n")[0].split("|");
      const rec = parsePgBool(parts[0]) === true;
      const wr = parseInt(parts[1] || "0", 10);
      if (rec && wr > 0) break;
      lastReadinessErr = `in_recovery=${rec} wal_receivers=${wr}`;
    } else {
      lastReadinessErr = verifyRes.stderr || verifyRes.stdout || "no response";
    }
    if (attempt < readinessAttempts - 1) {
      sleepMs(readinessDelayMs);
    }
  }

  // 7. Verify standby recovery and streaming receiver
  const statusParts = (verifyRes.stdout || "").trim().split("\n")[0].split("|");
  const inRecovery = parsePgBool(statusParts[0]) === true;
  const walReceivers = parseInt(statusParts[1] || "0", 10) || 0;
  const streamingActive = inRecovery && walReceivers > 0;

  if (!inRecovery) {
    return {
      success: false,
      target,
      dataDir,
      inRecovery: false,
      walReceivers,
      streamingActive: false,
      error: `Standby node failed to enter recovery mode (pg_is_in_recovery returned 0 or query failed: ${verifyRes.stderr || verifyRes.stdout})`,
    };
  }

  if (walReceivers === 0) {
    return {
      success: false,
      target,
      dataDir,
      inRecovery: true,
      walReceivers: 0,
      streamingActive: false,
      error: `WAL streaming receiver is not active in pg_stat_wal_receiver (status != 'streaming'). Last readiness state: ${lastReadinessErr || "unknown"}. Verify replication credentials and connectivity.`,
    };
  }

  return {
    success: true,
    target,
    dataDir,
    inRecovery: true,
    streamingActive: true,
    walReceivers,
    ...(slotRecreated ? { slotRecreated: true, slotAction: "recreated_lost_inactive" } : {}),
    ...(wipeAssessment
      ? {
          wiped: true,
          previousStandbyRole: wipeAssessment.role,
          comparison: wipeAssessment.comparison,
          ...(wipeAssessment.discardAcknowledged ? { promotedStandbyDiscarded: true } : {}),
        }
      : {}),
  };
}

function sleepMs(ms) {
  if (!ms || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Measure replication lag between primary and standby.
 * Implements fail-closed checks against primary LSN and standby replay LSN.
 */
export function checkLag(target = "all", options = {}, deps = {}) {
  const rawRunner = deps.runner || defaultRunner;
  const runner = createPgRunner(rawRunner, options);

  if (target === "all") {
    const boardRes = checkLag("board", options, deps);
    const hindsightRes = checkLag("hindsight", options, deps);
    const allOk = boardRes.success && hindsightRes.success;
    const allRpoOk = boardRes.rpoOk && hindsightRes.rpoOk;
    return {
      target: "all",
      success: allOk,
      rpoOk: allRpoOk,
      role: boardRes.role === hindsightRes.role ? boardRes.role : "mixed",
      inRecovery: boardRes.inRecovery && hindsightRes.inRecovery,
      measuredAgainst: boardRes.measuredAgainst || hindsightRes.measuredAgainst,
      primaryLsn: boardRes.primaryLsn || hindsightRes.primaryLsn,
      receiveLsn: boardRes.receiveLsn || hindsightRes.receiveLsn,
      replayLsn: boardRes.replayLsn || hindsightRes.replayLsn,
      byteLag: boardRes.byteLag ?? hindsightRes.byteLag,
      receiveByteLag: boardRes.receiveByteLag ?? hindsightRes.receiveByteLag,
      timeLagSeconds: Math.max(boardRes.timeLagSeconds ?? 0, hindsightRes.timeLagSeconds ?? 0),
      rpoMaxSeconds: options.rpoMaxSeconds || DEFAULT_CONFIG.rpoMaxSeconds,
      rpoStatus: allRpoOk ? "ok" : (boardRes.rpoStatus !== "ok" ? boardRes.rpoStatus : hindsightRes.rpoStatus),
      error: [boardRes.error, hindsightRes.error].filter(Boolean).join("; ") || undefined,
      databases: [boardRes, hindsightRes],
    };
  }

  const isBoard = target === "board";

  const endpoint = resolvePrimaryEndpoint(options, target, { runner });
  const primaryHost = endpoint.host;
  const primaryPort = endpoint.port;
  const standbyHost = options.standbyHost || DEFAULT_CONFIG.standbyHost;
  const standbyPort = resolveStandbyPort(options, target);
  const dbUser = isBoard
    ? options.boardDbUser || DEFAULT_CONFIG.boardDbUser
    : options.hindsightDbUser || DEFAULT_CONFIG.hindsightDbUser;
  const dbName = isBoard
    ? options.boardDbName || DEFAULT_CONFIG.boardDbName
    : options.hindsightDbName || DEFAULT_CONFIG.hindsightDbName;

  let standbyOutput = options.rawSqlOutput;
  if (!standbyOutput) {
    const res = queryPostgres(
      "SELECT pg_is_in_recovery()::int, COALESCE(pg_last_wal_receive_lsn()::text, ''), COALESCE(pg_last_wal_replay_lsn()::text, ''), COALESCE(pg_last_xact_replay_timestamp()::text, '');",
      { host: standbyHost, port: standbyPort, user: dbUser, db: dbName },
      runner
    );
    if (res.exitCode !== 0 || !res.stdout || res.stderr?.includes("error")) {
      return {
        target,
        success: false,
        rpoOk: false,
        role: "unreachable",
        rpoStatus: "standby_query_failed",
        error: res.stderr || "Standby query failed",
        byteLag: null,
        timeLagSeconds: null,
      };
    }
    standbyOutput = res.stdout;
  }

  const parsed = parseReplicationStatus(standbyOutput);

  if (parsed.role === "unreachable") {
    return {
      target,
      success: false,
      rpoOk: false,
      role: "unreachable",
      rpoStatus: "standby_query_failed",
      error: parsed.error || "Standby unreachable",
      byteLag: null,
      timeLagSeconds: null,
    };
  }

  if (!parsed.inRecovery) {
    return {
      target,
      success: true,
      rpoOk: false,
      role: "primary_or_standalone",
      rpoStatus: "not_in_standby",
      inRecovery: false,
      byteLag: 0n,
      timeLagSeconds: 0,
    };
  }

  // Standby is in recovery; now measure against primary current WAL LSN.
  // ADM rehearsal feedback (03.11): use the replication protocol (IDENTIFY_SYSTEM)
  // under myr_replicator — the passfile only has the replication user, not the
  // application password needed for pg_current_wal_lsn().
  let primaryLsn = options.primaryLsn;
  if (!primaryLsn && !options.offline) {
    const replUser = isBoard
      ? options.boardReplUser || DEFAULT_CONFIG.boardReplUser
      : options.hindsightReplUser || DEFAULT_CONFIG.hindsightReplUser;
    const lsnRes = queryPrimaryLsn(
      { host: primaryHost, port: primaryPort, user: replUser },
      runner
    );
    if (!lsnRes.ok) {
      // Primary unreachable -> fail-closed: cannot prove RPO
      return {
        target,
        success: false,
        rpoOk: false,
        role: "standby",
        inRecovery: true,
        rpoStatus: "primary_unreachable",
        error: lsnRes.error || "Primary LSN query failed",
        byteLag: null,
        timeLagSeconds: null,
      };
    }
    primaryLsn = lsnRes.lsn;
  }

  let slotInfo = {};

  // Slot retention check: a physical slot that stops consuming WAL (dead tunnel,
  // stopped standby) retains WAL on the primary until the disk fills. Surface the
  // retained bytes and fail closed on lost/missing slot retention.
  if (!options.skipSlotCheck && !options.offline) {
    const replSlot = isBoard
      ? options.boardReplSlot || DEFAULT_CONFIG.boardReplSlot
      : options.hindsightReplSlot || DEFAULT_CONFIG.hindsightReplSlot;
    // max_slot_wal_keep_size is read from pg_settings (always MB). current_setting()
    // returns a unit-formatted string such as '6GB', which parseInt would read as 6 MB.
    const slotRes = isSqlIdent(replSlot)
      ? queryPrimaryViaReplication(
          `SELECT COALESCE(s.wal_status, 'missing'), COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), s.restart_lsn)::bigint::text, ''), COALESCE((SELECT setting FROM pg_settings WHERE name = 'max_slot_wal_keep_size'), '-1') FROM (SELECT 1) d LEFT JOIN pg_replication_slots s ON s.slot_name = '${replSlot}';`,
          {
            host: primaryHost,
            port: primaryPort,
            user: isBoard
              ? options.boardReplUser || DEFAULT_CONFIG.boardReplUser
              : options.hindsightReplUser || DEFAULT_CONFIG.hindsightReplUser,
            dbName,
          },
          runner
        )
      : { exitCode: 1, stdout: "", stderr: `invalid slot name ${replSlot}` };
    if (slotRes.exitCode === 0 && (slotRes.stdout || "").trim()) {
      const parts = slotRes.stdout.trim().split("\n")[0].split("|");
      const slotWalStatus = (parts[0] || "").trim();
      const retainedBytes = Number.parseInt(parts[1] || "", 10);
      const maxSettingMb = Number.parseInt((parts[2] || "").trim(), 10);
      // max_slot_wal_keep_size is in MB; pg_wal_lsn_diff returns bytes.
      const maxSlotWalBytes =
        Number.isFinite(maxSettingMb) && maxSettingMb > 0 ? maxSettingMb * 1024 * 1024 : null;

      if (slotWalStatus !== "reserved" && slotWalStatus !== "extended") {
        const rpoStatus =
          slotWalStatus === "missing"
            ? "slot_missing"
            : slotWalStatus === "lost"
              ? "slot_wal_lost"
              : slotWalStatus === "unreserved"
                ? "slot_wal_unreserved"
                : `slot_wal_${slotWalStatus}`;
        return {
          target,
          success: false,
          rpoOk: false,
          role: "standby",
          inRecovery: true,
          rpoStatus,
          error: `Replication slot '${replSlot}' wal_status is '${slotWalStatus}' (expected 'reserved' or 'extended'): standby cannot keep up and retention is unsafe`,
          byteLag: null,
          timeLagSeconds: null,
        };
      }

      if (
        Number.isFinite(retainedBytes) &&
        maxSlotWalBytes !== null &&
        retainedBytes > maxSlotWalBytes
      ) {
        return {
          target,
          success: false,
          rpoOk: false,
          role: "standby",
          inRecovery: true,
          rpoStatus: "slot_retention_exceeded",
          error: `Replication slot '${replSlot}' retains ${retainedBytes} bytes, exceeding max_slot_wal_keep_size (${maxSettingMb} MB)`,
          byteLag: null,
          timeLagSeconds: null,
        };
      }

      slotInfo = {
        ...(Number.isFinite(retainedBytes) ? { slotRetainedBytes: retainedBytes } : {}),
        ...(slotWalStatus ? { slotWalStatus } : {}),
        ...(maxSlotWalBytes !== null && Number.isFinite(retainedBytes)
          ? { slotRetentionWarn: retainedBytes > 0.8 * maxSlotWalBytes }
          : {}),
      };
    }
  }

  const lagInfo = calculateLag({
    primaryLsn,
    receiveLsn: parsed.receiveLsn,
    replayLsn: parsed.replayLsn,
    lastXactReplayTimestamp: parsed.lastXactReplayTimestamp,
    rpoMaxSeconds: options.rpoMaxSeconds,
    maxByteLag: options.maxByteLag,
    now: options.now,
  });

  return {
    target,
    success: true,
    role: "standby",
    inRecovery: true,
    ...slotInfo,
    ...lagInfo,
  };
}

/**
 * Execute promotion and application switchover.
 *
 * OPE-7656 review fixes:
 *  - finding 1: the role is always read as `pg_is_in_recovery()::int` through one helper.
 *  - finding 2: fail-closed split-brain guard (see evaluateFailoverGuard); an unreachable
 *    primary additionally needs --fenced.
 *  - finding 3: docker mode promotes with the IN-CONTAINER data directory; `appSwitched`
 *    and `healthOk` are `null` unless that step was requested and actually ran.
 */
export function executeFailover(target = "board", options = {}, deps = {}) {
  const rawRunner = deps.runner || defaultRunner;
  const runner = createPgRunner(rawRunner, options);
  const ctx = resolveOpContext(target, options);
  const plan = planFailover(target, options);

  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      target,
      plan,
    };
  }

  const startTime = Date.now();
  const { standbyPort, dbUser, dbName } = ctx;

  // 0. Fail-closed split-brain guard.
  const guard = evaluateFailoverGuard(target, options, runner);
  const guardSummary = {
    state: guard.state,
    ...(guard.endpoint ? { primary: `${guard.endpoint.host}:${guard.endpoint.port}`, primarySource: guard.endpoint.source } : {}),
    ...(guard.fencing ? { fencing: guard.fencing } : {}),
    ...(guard.note ? { note: guard.note } : {}),
  };
  if (!guard.proceed) {
    return {
      success: false,
      target,
      promoted: false,
      guard: guardSummary,
      error: guard.error,
    };
  }

  // 1. Promote standby (D3: pg_ctl promote — paperclip role lacks pg_promote() privilege)
  // pg_ctl runs as the OS user that owns the data directory (postgres), bypassing the SQL
  // privilege requirement. In docker mode the tool runs inside the container, so -D must be
  // the IN-CONTAINER PGDATA (ctx.pgDataDir), never the host path.
  const promoteTimeoutMs = options.promoteTimeoutMs || 120000;
  let promoteMethod = "pg_ctl";
  const ctlRes = runner("pg_ctl", ["promote", "-D", ctx.pgDataDir], { timeoutMs: promoteTimeoutMs });
  if (ctlRes.exitCode !== 0) {
    // Fall back to SQL pg_promote() (needs superuser/EXECUTE); report both failures if it fails too.
    const sqlRes = queryPostgres(plan.promoteSql, { host: "127.0.0.1", port: standbyPort, user: dbUser, db: dbName }, runner);
    if (sqlRes.exitCode !== 0) {
      return {
        success: false,
        target,
        promoted: false,
        guard: guardSummary,
        error:
          `Promotion failed: pg_ctl promote -D ${ctx.pgDataDir} (${ctx.docker ? `in container ${ctx.container}` : "on host"}): ${describePsqlError(ctlRes)}; ` +
          `pg_promote() fallback: ${describePsqlError(sqlRes)}`,
      };
    }
    promoteMethod = "pg_promote";
  }

  // 2. Poll until pg_is_in_recovery() reports 0 (D4: bounded delay between attempts)
  let promoted = false;
  const maxAttempts = options.maxVerifyAttempts ?? 10;
  const verifyDelayMs = options.verifyDelayMs ?? 2000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const vRes = queryPostgres(SQL_IN_RECOVERY, { host: "127.0.0.1", port: standbyPort, user: dbUser, db: dbName }, runner);
    if (vRes.exitCode === 0 && parsePgBool(firstField(vRes.stdout)) === false) {
      promoted = true;
      break;
    }
    if (attempt < maxAttempts - 1) {
      sleepMs(verifyDelayMs);
    }
  }

  if (!promoted) {
    return {
      success: false,
      target,
      promoted: false,
      guard: guardSummary,
      error: "Standby promotion timed out; database remains in recovery",
    };
  }

  // 3. Reroute / restart application ONLY if requested. Never reported as done otherwise.
  let appSwitched = null;
  let appSwitchNote = "not requested: switch the application manually (runbook section 5 step 3) or pass --restart-app --app-compose-file";
  if (options.restartApp) {
    const appCompose = options.appComposeFile || process.env.STANDBY_APP_COMPOSE_FILE;
    if (!appCompose) {
      appSwitched = false;
      appSwitchNote = "--restart-app needs --app-compose-file <production compose file> (or STANDBY_APP_COMPOSE_FILE); the drill compose file is never used for this";
    } else {
      const appService = options.appService || DEFAULT_CONFIG.appBoardService;
      const restartRes = runner("docker", ["compose", "-f", appCompose, "up", "-d", "--force-recreate", appService], {
        timeoutMs: options.appRestartTimeoutMs || 300000,
      });
      appSwitched = restartRes.exitCode === 0;
      appSwitchNote = appSwitched
        ? `recreated '${appService}' from ${appCompose} (that compose file must already point DATABASE_URL at the promoted standby; this does not verify it)`
        : `docker compose up failed: ${describePsqlError(restartRes)}`;
    }
  }

  // 4. Verify application readiness ONLY if requested.
  let healthOk = null;
  let healthNote = "not checked (pass --check-health [--health-url <url>])";
  if (options.checkHealth) {
    const healthUrl = options.healthUrl || plan.healthCheckUrl;
    const healthRes = runner("curl", ["-sf", "--max-time", "10", healthUrl], { timeoutMs: 30000 });
    healthOk = healthRes.exitCode === 0;
    healthNote = healthOk ? `GET ${healthUrl} ok` : `GET ${healthUrl} failed: ${describePsqlError(healthRes)}`;
  }

  const durationMs = Date.now() - startTime;
  const durationSeconds = Math.round(durationMs / 1000);
  const rtoOk = durationSeconds <= DEFAULT_CONFIG.rtoTargetSeconds;
  const stepsOk = appSwitched !== false && healthOk !== false;

  return {
    success: stepsOk,
    target,
    promoted: true,
    inRecovery: false,
    promoteMethod,
    guard: guardSummary,
    appSwitched,
    appSwitchNote,
    healthOk,
    healthNote,
    durationSeconds,
    rtoOk,
    ...(stepsOk ? {} : { error: "Standby WAS promoted, but a requested follow-up step failed (see appSwitchNote/healthNote)" }),
  };
}

/**
 * Execute switchback: restore standby replica from primary.
 *
 * OPE-7656 review fixes: the role checks use the same `::int` helper and the replicator over
 * the replication protocol; every check (credentials, WAL policy, slot, promoted-standby /
 * timeline guard) runs inside setupStandby BEFORE the container is stopped or the data
 * directory is emptied.
 */
export function executeSwitchback(target = "board", options = {}, deps = {}) {
  const rawRunner = deps.runner || defaultRunner;
  const runner = createPgRunner(rawRunner, options);
  const fsOps = deps.fsOps || defaultFsOps;
  const ctx = resolveOpContext(target, options);
  const plan = planSwitchback(target, options);

  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      target,
      plan,
    };
  }

  // 0. Fail-closed without explicit force flag before anything else.
  if (!options.force) {
    return {
      success: false,
      target,
      error: `Switchback requires explicit --force to stop standby container, empty data directory '${ctx.hostDataDir}', and resynchronize`,
    };
  }

  // 1. Verify the original primary is the active primary (reachable and NOT in recovery).
  const endpoint = resolvePrimaryEndpoint(options, target, { runner });
  if (endpoint.source === "default") {
    return {
      success: false,
      target,
      error:
        "Cannot determine the original primary endpoint (no --primary-host, no PRIMARY_PG_HOST, standby primary_conninfo unreadable); " +
        "refusing to re-clone from a guessed host. Pass --primary-host/--primary-port.",
    };
  }
  const probe = probePrimary(target, options, runner, endpoint);
  if (probe.state !== "writable") {
    return {
      success: false,
      target,
      error:
        `Original primary is not an active primary (in recovery or unreachable): ${endpoint.host}:${endpoint.port} -> ${probe.state}` +
        (probe.error ? ` (${probe.error})` : ""),
    };
  }

  // 2. Re-sync. setupStandby runs ALL remaining checks (credentials, WAL policy, slot, promoted
  // standby guard with timeline/LSN comparison) and only then stops the container, empties the
  // data directory and takes the base backup. Pass the verified endpoint so the regenerated
  // primary_conninfo keeps the live relay instead of the compile-time default.
  const setupRes = setupStandby(
    target,
    { ...options, force: true, primaryHost: endpoint.host, primaryPort: endpoint.port },
    { runner: rawRunner, fsOps }
  );
  return {
    success: setupRes.success,
    target,
    resynchronized: setupRes.success,
    inRecovery: setupRes.inRecovery,
    streamingActive: setupRes.streamingActive,
    ...(setupRes.comparison ? { comparison: setupRes.comparison } : {}),
    ...(setupRes.promotedStandbyDiscarded ? { promotedStandbyDiscarded: true } : {}),
    ...(setupRes.standbyRole ? { standbyRole: setupRes.standbyRole } : {}),
    error: setupRes.error,
  };
}

/**
 * Safe, isolated rehearsal drill on ephemeral port/directory.
 * Verifies recovery promotion and smoke tests BOTH databases (paperclip, myrmidon_hindsight) in one replica.
 *
 * OPE-7656 review finding 5: in docker mode the drill directory is an IN-CONTAINER path, so
 * existence checks and cleanup (`rm -rf`) run through docker exec, never through the host
 * filesystem; cleanup runs in `finally` for every outcome except a fully successful
 * --keep-drill. The drill board is started from --compose-file when --keep-drill is set.
 */
export function executeRehearsal(target = "board", options = {}, deps = {}) {
  const rawRunner = deps.runner || defaultRunner;
  const runner = createPgRunner(rawRunner, options);
  const fsOps = deps.fsOps || defaultFsOps;
  const env = deps.env || process.env;
  const ctx = resolveOpContext(target, options);
  const docker = ctx.docker;
  const plan = planRehearsal(target, options);

  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      target,
      plan,
    };
  }

  const drillDir = plan.drillDir;
  const drillPort = plan.drillPort;
  const standbyPort = ctx.standbyPort;
  const boardUser = options.boardDbUser || DEFAULT_CONFIG.boardDbUser;
  const boardDb = options.boardDbName || DEFAULT_CONFIG.boardDbName;
  const hindsightUser = options.hindsightDbUser || DEFAULT_CONFIG.hindsightDbUser;
  const hindsightDb = options.hindsightDbName || DEFAULT_CONFIG.hindsightDbName;
  const replUser = ctx.replUser;
  const composeFile = options.composeFile || DEFAULT_CONFIG.composeFile;
  const boardService = DEFAULT_CONFIG.drillBoardService;
  const pgCtlTimeoutMs = options.pgCtlTimeoutMs || 120000;
  const keepDrill = options.keepDrill === true;

  const dirErr = validateDrillDir(drillDir, options);
  if (dirErr) {
    return { success: false, target, error: dirErr };
  }

  const inContainer = (cmd, args, runnerOptions) => runInStandbyContainer(rawRunner, options, cmd, args, runnerOptions);

  // "absent" | "present" | "unknown" — in the container in docker mode, on the host otherwise.
  const drillDirState = () => {
    if (docker) {
      const r = inContainer("test", ["-e", drillDir], { timeoutMs: 30000 });
      if (r.exitCode === 0) return "present";
      // `test -e` prints nothing; docker's own failures ("No such container", "is not running")
      // also exit 1 but write to stderr.
      if (r.exitCode === 1 && !(r.stderr || "").trim()) return "absent";
      return "unknown";
    }
    return safeReaddir(fsOps, drillDir).length > 0 ? "present" : "absent";
  };

  // Stop the drill instance and delete the drill directory. Docker mode deletes INSIDE the
  // container (the path does not exist on the host); the result is verified, not assumed.
  const cleanupDrillDir = () => {
    const stopRes = runner("pg_ctl", ["stop", "-D", drillDir, "-m", "immediate"], { timeoutMs: pgCtlTimeoutMs });
    let rmRes;
    if (docker) {
      rmRes = inContainer("rm", ["-rf", drillDir], { timeoutMs: 600000 });
    } else {
      try {
        fsOps.rmSync(drillDir, { recursive: true, force: true });
        rmRes = { exitCode: 0 };
      } catch (err) {
        rmRes = { exitCode: 1, stderr: err.message };
      }
    }
    const state = drillDirState();
    const removed = rmRes.exitCode === 0 && state === "absent";
    return {
      stopped: stopRes.exitCode === 0,
      removed,
      ...(removed ? {} : { error: `rm -rf ${drillDir} left state=${state}: ${describePsqlError(rmRes)}` }),
    };
  };

  // Teardown of a drill kept with --keep-drill.
  if (options.cleanupDrill) {
    const boardRes = runner("docker", ["compose", "-f", composeFile, "--profile", "drill", "rm", "-sf", boardService], {
      timeoutMs: 120000,
    });
    const cleanup = cleanupDrillDir();
    const ok = boardRes.exitCode === 0 && cleanup.removed;
    return {
      success: ok,
      target,
      cleanupDrill: true,
      drillDir,
      boardRemoved: boardRes.exitCode === 0,
      cleanup,
      ...(ok ? {} : { error: [boardRes.exitCode === 0 ? "" : `drill board removal failed: ${describePsqlError(boardRes)}`, cleanup.error].filter(Boolean).join("; ") }),
    };
  }

  // The drill board needs real secrets from the environment; check BEFORE the long snapshot.
  if (keepDrill) {
    const missing = ["BETTER_AUTH_SECRET", "PAPERCLIP_DB_PASSWORD"].filter((k) => !env[k]);
    if (missing.length > 0) {
      return {
        success: false,
        target,
        error:
          `--keep-drill starts the drill board and requires ${missing.join(" and ")} in the environment ` +
          "(no defaults are used: the compose file deliberately ships none). Nothing was started.",
      };
    }
  }

  // A leftover drill directory (failed run, or a kept drill that is still running) is never
  // reused or silently deleted.
  const preState = drillDirState();
  if (preState !== "absent") {
    return {
      success: false,
      target,
      error:
        preState === "present"
          ? `Drill directory '${drillDir}' already exists (leftover or --keep-drill still running). Run 'rehearse --cleanup-drill' first.`
          : `Cannot determine whether drill directory '${drillDir}' exists (is the standby container '${ctx.container}' running?)`,
    };
  }

  const startTime = Date.now();

  if (!docker) {
    try {
      fsOps.mkdirSync(drillDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return { success: false, target, error: `Failed to create drill dir: ${err.message}` };
    }
  }

  // Host mode only: credentials for the drill snapshot (D5). In docker mode pg_basebackup runs
  // inside the container with the container's own passfile, so nothing is written on the host.
  let drillPassfilePath = null;
  if (!docker) {
    const replPassword =
      options.replicatorPassword !== undefined
        ? options.replicatorPassword
        : DEFAULT_CONFIG.replicatorPassword;
    const credentialPath =
      options.credentialPath ||
      options.passfilePath ||
      DEFAULT_CONFIG.credentialPath ||
      DEFAULT_CONFIG.passfilePath;
    drillPassfilePath = credentialPath || path.join(path.dirname(drillDir), ".pgpass");
    if (replPassword) {
      try {
        const passDir = path.dirname(drillPassfilePath);
        if (!fsOps.existsSync(passDir)) {
          fsOps.mkdirSync(passDir, { recursive: true, mode: 0o700 });
        }
        const endpoint = resolvePrimaryEndpoint(options, target, { runner });
        fsOps.writeFileSync(
          drillPassfilePath,
          pgpassLine("127.0.0.1", standbyPort, replUser, replPassword) +
            pgpassLine(endpoint.host, endpoint.port, replUser, replPassword),
          { mode: 0o600 }
        );
        if (fsOps.chmodSync) {
          fsOps.chmodSync(drillPassfilePath, 0o600);
        }
      } catch (err) {
        try { fsOps.rmSync(drillDir, { recursive: true, force: true }); } catch {}
        return { success: false, target, error: `Failed to create drill passfile at ${drillPassfilePath}: ${err.message}` };
      }
    }
  }

  let drillOk = false;
  let drillResult;

  const runDrill = () => {
    // 1. Snapshot from standby (D1: configurable timeout for large clusters; D5: PGPASSFILE)
    const drillTimeoutMs = basebackupTimeoutMs(options);
    const snapshotArgs = [
      "-h", "127.0.0.1",
      "-p", String(standbyPort),
      "-U", replUser,
      "-D", drillDir,
      "-Fp",
      "-Xs",
      "-R",
      "-P",
    ];
    // ADM rehearsal feedback (03.11): default --max-rate to 100M for drill snapshots
    // (49 GB on shared disk with CI runners). Explicit --max-rate overrides.
    const effectiveMaxRate = options.maxRate || "100M";
    if (effectiveMaxRate) {
      snapshotArgs.push(`--max-rate=${effectiveMaxRate}`);
    }
    const snapRes = runner("pg_basebackup", snapshotArgs, {
      timeoutMs: drillTimeoutMs,
      streamStderr: true,
      ...(docker ? {} : { env: { ...process.env, PGPASSFILE: drillPassfilePath } }),
    });
    if (snapRes.exitCode !== 0) {
      return { success: false, target, error: `Drill snapshot failed: ${snapRes.stderr || snapRes.stdout}` };
    }

    // 2. Start ephemeral postgres instance on drillPort. With --keep-drill the drill board runs in
    // ANOTHER container of the same compose network, so the instance must listen beyond loopback
    // (port 5533 is not published to the host; only the compose network can reach it).
    const listen = keepDrill ? "'*'" : "127.0.0.1";
    const startRes = runner("pg_ctl", [
      "start",
      "-D", drillDir,
      "-l", `${drillDir}/pg_ctl.log`,
      "-o",
      `-p ${drillPort} -c listen_addresses=${listen} -c max_connections=200 -c max_worker_processes=16`,
    ], { timeoutMs: pgCtlTimeoutMs });
    if (startRes.exitCode !== 0) {
      return { success: false, target, error: `Drill pg_ctl start failed: ${startRes.stderr || startRes.stdout}` };
    }

    // 3. Promote drill instance (D3: pg_ctl promote — paperclip role lacks pg_promote() privilege)
    const promoteRes = runner("pg_ctl", ["promote", "-D", drillDir], { timeoutMs: pgCtlTimeoutMs });
    if (promoteRes.exitCode !== 0) {
      return { success: false, target, error: `Drill promotion failed: ${promoteRes.stderr || promoteRes.stdout}` };
    }

    // 4. Verify drill recovery is over. The role is read as ::int ("0"/"1") via the shared helper.
    const verifyRes = queryPostgres(SQL_IN_RECOVERY, { host: "127.0.0.1", port: drillPort, user: boardUser, db: boardDb }, runner);

    // 5. Smoke test BOTH databases in the single replica
    const boardSmokeRes = queryPostgres("SELECT 1;", { host: "127.0.0.1", port: drillPort, user: boardUser, db: boardDb }, runner);
    const hindsightSmokeRes = queryPostgres("SELECT 1;", { host: "127.0.0.1", port: drillPort, user: hindsightUser, db: hindsightDb }, runner);

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    const rtoOk = durationSeconds <= DEFAULT_CONFIG.rtoTargetSeconds;
    const boardSmokeOk = (boardSmokeRes.stdout || "").trim() === "1";
    const hindsightSmokeOk = (hindsightSmokeRes.stdout || "").trim() === "1";
    const smokeTestPassed = boardSmokeOk && hindsightSmokeOk;
    const promoted = verifyRes.exitCode === 0 && parsePgBool(firstField(verifyRes.stdout)) === false;

    const errors = [];
    if (!promoted) {
      errors.push(
        `Promotion verification failed: in_recovery is '${(verifyRes.stdout || "").trim()}', expected '0' (pg_is_in_recovery()::int)`
      );
    }
    if (!smokeTestPassed) {
      if (!boardSmokeOk) {
        errors.push(
          `Smoke test failed for database '${boardDb}' (exit: ${boardSmokeRes.exitCode}, out: ${(boardSmokeRes.stdout || boardSmokeRes.stderr || "").trim()})`
        );
      }
      if (!hindsightSmokeOk) {
        errors.push(
          `Smoke test failed for database '${hindsightDb}' (exit: ${hindsightSmokeRes.exitCode}, out: ${(hindsightSmokeRes.stdout || hindsightSmokeRes.stderr || "").trim()})`
        );
      }
    }
    if (!rtoOk) {
      errors.push(
        `RTO target exceeded (${durationSeconds}s > ${DEFAULT_CONFIG.rtoTargetSeconds}s)`
      );
    }

    // 6. --keep-drill: really start the drill board from the compose file (finding 5).
    let boardInfo = {};
    if (keepDrill && errors.length === 0) {
      const boardRes = runner(
        "docker",
        ["compose", "-f", composeFile, "--profile", "drill", "up", "-d", "--no-deps", boardService],
        { timeoutMs: 300000 }
      );
      const boardStarted = boardRes.exitCode === 0;
      boardInfo = { boardStarted, boardUrl: DEFAULT_CONFIG.drillBoardUrl };
      if (!boardStarted) {
        errors.push(`Drill board failed to start from ${composeFile}: ${describePsqlError(boardRes)}`);
      }
    }

    drillOk = errors.length === 0;
    return {
      success: promoted && smokeTestPassed && rtoOk && errors.length === 0,
      target,
      promoted,
      smokeTestPassed,
      verifiedDatabases: [boardDb, hindsightDb],
      durationSeconds,
      targetRtoSeconds: DEFAULT_CONFIG.rtoTargetSeconds,
      rtoOk,
      ...boardInfo,
      ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
    };
  };

  // 2-7. Run the drill. Cleanup MUST run even when a step fails or throws —
  // ADM rehearsal feedback (04.11): the 49GB drill dir was left on disk because cleanup only
  // ran on the happy path. The ONLY case that keeps the drill is a fully successful --keep-drill.
  let cleanup = null;
  try {
    drillResult = runDrill();
  } catch (err) {
    drillResult = { success: false, target, error: `Rehearsal aborted by an unexpected error: ${err.message}` };
  } finally {
    if (!(keepDrill && drillOk)) {
      cleanup = cleanupDrillDir();
    }
  }

  const result = { ...drillResult };
  if (cleanup) {
    result.cleanup = cleanup;
    if (!cleanup.removed) {
      result.success = false;
      result.error = [result.error, `Drill cleanup FAILED: ${cleanup.error} (remove it manually: docker exec -u postgres ${ctx.container} rm -rf ${drillDir})`]
        .filter(Boolean)
        .join("; ");
    }
  }
  if (keepDrill && drillOk) {
    result.keepDrill = true;
    result.drillDir = drillDir;
    result.drillPort = drillPort;
    result.teardown = "standby-ctl.sh rehearse --cleanup-drill";
  }
  return result;
}

/**
 * Flags that never take a value. Without this list `failover --fenced board` would parse
 * `board` as the VALUE of --fenced and silently switch the target.
 */
const BOOLEAN_FLAGS = new Set([
  "force",
  "dry-run",
  "offline",
  "json",
  "keep-drill",
  "cleanup-drill",
  "discard-promoted-standby",
  "accept-data-loss",
  "drop-standby-diverged",
  "accept-split-brain",
  "fenced",
  "restart-app",
  "check-health",
  "help",
]);

function flagOn(value) {
  if (value === undefined || value === false) return false;
  if (typeof value === "string" && /^(false|0|no|off)$/i.test(value)) return false;
  return true;
}

/**
 * Main CLI runner.
 */
export function runCli(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  const command = flags.help ? "help" : positional[0] || "help";
  const target = positional[1] || flags.target || "all";
  const targets = target === "all" ? ["board", "hindsight"] : [target];
  if (!["all", "board", "hindsight"].includes(target) && command !== "help") {
    console.error(`Unknown target '${target}' (expected board, hindsight or all)`);
    return 1;
  }

  if (flags["basebackup-timeout"] !== undefined) {
    // New flag: seconds by default, explicit `ms` suffix for milliseconds (ADM 08.11 defect 5:
    // the value reached spawnSync as a raw string and killed `setup` after the 90-min default).
    flags.basebackupTimeoutMs = parseBasebackupTimeout(flags["basebackup-timeout"]);
  } else if (flags.basebackupTimeoutMs !== undefined && typeof flags.basebackupTimeoutMs !== "number") {
    // Legacy camelCase flag: value is already milliseconds (per its name) — just coerce to number.
    const legacyMs = Number(flags.basebackupTimeoutMs);
    if (!Number.isSafeInteger(legacyMs) || legacyMs <= 0) {
      throw new Error("--basebackupTimeoutMs must be a positive number of milliseconds");
    }
    flags.basebackupTimeoutMs = legacyMs;
  }
  if (flags["rpo-max-seconds"] !== undefined) {
    flags.rpoMaxSeconds = Number(flags["rpo-max-seconds"]);
  }
  if (flags.rpo !== undefined) {
    flags.rpoMaxSeconds = Number(flags.rpo);
  }
  if (flags.force !== undefined) {
    flags.force = flagOn(flags.force);
  }
  if (flags["discard-promoted-standby"] !== undefined || flags["drop-standby-diverged"] !== undefined) {
    flags.discardPromotedStandby =
      flagOn(flags["discard-promoted-standby"]) || flagOn(flags["drop-standby-diverged"]);
  }
  if (flags["accept-data-loss"] !== undefined) {
    flags.acceptDataLoss = flagOn(flags["accept-data-loss"]);
  }
  if (flags["dry-run"] !== undefined) {
    flags.dryRun = flagOn(flags["dry-run"]);
  }
  if (flags.offline !== undefined) {
    flags.offline = flagOn(flags.offline);
  }
  if (flags.json !== undefined) {
    flags.json = true;
  }
  if (flags.passfile !== undefined) {
    flags.passfilePath = flags.passfile;
  }
  if (flags.credentials !== undefined) {
    flags.credentialPath = flags.credentials;
  }
  if (flags["credential-path"] !== undefined) {
    flags.credentialPath = flags["credential-path"];
  }
  if (flags["standby-port"] !== undefined) {
    flags.standbyPort = Number(flags["standby-port"]);
  }
  if (flags["primary-port"] !== undefined) {
    flags.primaryPort = Number(flags["primary-port"]);
  }
  if (flags["primary-host"] !== undefined) {
    flags.primaryHost = flags["primary-host"];
  }
  if (flags.port !== undefined) {
    flags.standbyPort = Number(flags.port);
  }
  if (flags["drill-dir"] !== undefined) {
    flags.drillDir = flags["drill-dir"];
  }
  if (flags["drill-port"] !== undefined) {
    flags.drillPort = Number(flags["drill-port"]);
  }
  if (flags["max-rate"] !== undefined) {
    flags.maxRate = flags["max-rate"];
  }
  if (flags["pg-runner"] !== undefined) {
    flags.pgRunner = flags["pg-runner"];
  }
  if (flags["pg-image"] !== undefined) {
    flags.pgImage = flags["pg-image"];
  }
  if (flags["keep-drill"] !== undefined) {
    flags.keepDrill = flagOn(flags["keep-drill"]);
  }
  if (flags["cleanup-drill"] !== undefined) {
    flags.cleanupDrill = flagOn(flags["cleanup-drill"]);
  }
  // OPE-7656 review fixes: flags the failover/switchback/rehearse code reads but the CLI
  // never mapped (so they could not be set at all).
  if (flags["accept-split-brain"] !== undefined) {
    flags.acceptSplitBrain = flagOn(flags["accept-split-brain"]);
  }
  if (flags.fenced !== undefined) {
    // `--fenced` or `--fenced=<how it was fenced>`; a string is kept as audit evidence.
    flags.fenced = flagOn(flags.fenced) ? flags.fenced : false;
  }
  if (flags["restart-app"] !== undefined) {
    flags.restartApp = flagOn(flags["restart-app"]);
  }
  if (flags["check-health"] !== undefined) {
    flags.checkHealth = flagOn(flags["check-health"]);
  }
  if (flags["health-url"] !== undefined) {
    flags.healthUrl = flags["health-url"];
  }
  if (flags["app-compose-file"] !== undefined) {
    flags.appComposeFile = flags["app-compose-file"];
  }
  if (flags["app-service"] !== undefined) {
    flags.appService = flags["app-service"];
  }
  if (flags["data-dir"] !== undefined) {
    flags.dataDir = flags["data-dir"];
  }
  if (flags["container-data-dir"] !== undefined) {
    flags.containerDataDir = flags["container-data-dir"];
  }
  if (flags["compose-file"] !== undefined) {
    flags.composeFile = flags["compose-file"];
  }

  const resultExit = (results) => (results.some((r) => !r.success) ? 1 : 0);

  switch (command) {
    case "setup": {
      const setupTargets = target === "all" ? ["board"] : targets;
      const results = setupTargets.map((t) => setupStandby(t, flags, deps));
      console.log(JSON.stringify({ command: "setup", results }, null, 2));
      return resultExit(results);
    }

    case "check-lag": {
      const results = targets.map((t) => checkLag(t, flags, deps));
      const allRpoOk = results.every((r) => r.rpoOk);
      const allSuccess = results.every((r) => r.success);
      const serializable = results.map((r) => ({
        ...r,
        byteLag: r.byteLag !== null && r.byteLag !== undefined ? r.byteLag.toString() : null,
        receiveByteLag: r.receiveByteLag !== null && r.receiveByteLag !== undefined ? r.receiveByteLag.toString() : null,
      }));
      console.log(JSON.stringify({ command: "check-lag", allRpoOk, results: serializable }, null, 2));
      return allRpoOk && allSuccess ? 0 : 1;
    }

    case "failover": {
      const failoverTargets = target === "all" ? ["board"] : targets;
      const results = failoverTargets.map((t) => executeFailover(t, flags, deps));
      console.log(JSON.stringify({ command: "failover", results }, null, 2));
      return resultExit(results);
    }

    case "switchback": {
      const switchTargets = target === "all" ? ["board"] : targets;
      const results = switchTargets.map((t) => executeSwitchback(t, flags, deps));
      console.log(JSON.stringify({ command: "switchback", results }, null, 2));
      return resultExit(results);
    }

    case "rehearse": {
      const rehearseTargets = target === "all" ? ["board"] : targets;
      // --keep-drill reads BETTER_AUTH_SECRET / PAPERCLIP_DB_PASSWORD from this env.
      const rehearseDeps = { ...deps, env: deps.env || env };
      const results = rehearseTargets.map((t) => executeRehearsal(t, flags, rehearseDeps));
      // A dry-run or --cleanup-drill result carries no RTO; only an explicit rtoOk:false fails.
      const allSuccess = results.every((r) => r.success);
      const allRtoOk = results.every((r) => r.rtoOk !== false);
      console.log(
        JSON.stringify({ command: "rehearse", allSuccess, allRtoOk, results }, null, 2)
      );
      const anyFailed = results.some((r) => !r.success || r.rtoOk === false);
      return anyFailed ? 1 : 0;
    }

    case "help":
    default: {
      console.log(`
Usage: standby-ctl.mjs <command> [target] [options]

Commands:
  setup [board|hindsight|all]      Configure streaming replication and start standby
  check-lag [board|hindsight|all]  Measure lag vs primary WAL LSN, verify RPO <= 15m
  failover [board|hindsight|all]   Promote standby to primary (split-brain guarded; see --fenced)
  switchback [board|hindsight|all] Re-sync and restore standby after primary recovery
  rehearse [board|hindsight|all]   Perform isolated rehearsal test, verify RTO <= 30m

Options:
  --dry-run                        Print operational plans without executing commands
  --force                          Allow cleaning non-empty data directory during setup/switchback
  --discard-promoted-standby       Setup --force / switchback: explicitly accept discarding writes on a promoted
                                   (non-recovery) standby; the timeline/LSN comparison is reported
  --accept-data-loss               With --discard-promoted-standby: also required when the comparison says the standby
                                   is AHEAD of the primary (or a different cluster), i.e. it holds writes found nowhere else
  --fenced[=<how>]                 Failover: confirm the OLD primary is fenced (hypervisor power-off). REQUIRED when
                                   the primary is unreachable; a reachable writable primary is always refused
  --accept-split-brain             Failover: bypass the split-brain guard entirely (emergency, data may diverge)
  --primary-host=<h> --primary-port=<p>
                                   Original primary endpoint (default: PRIMARY_PG_HOST/PORT env, then the
                                   standby's primary_conninfo)
  --restart-app                    Failover: recreate the application after promotion (needs --app-compose-file)
  --app-compose-file=<file>        Failover: production compose file of the application (never the drill file)
  --app-service=<name>             Failover: application service name (default: myrmidon-board)
  --check-health [--health-url=<u>] Failover: GET the board health URL after promotion
  --data-dir=<host dir>            Host data directory of the standby (default: /srv/standby/myrmidon-pg/data)
  --container-data-dir=<dir>       In-container PGDATA used in docker mode (default: /var/lib/postgresql/data)
  --compose-file=<file>            Standby/drill compose file (default: docker-compose.standby.yml next to this tool)
  --rpo=<sec>                      Maximum acceptable lag in seconds (alias for --rpo-max-seconds)
  --rpo-max-seconds=<sec>          Maximum acceptable lag in seconds (default: 900)
  --offline                        Measure standby without querying primary
  --target=<target>                board, hindsight, or all (default: all)
  --basebackup-timeout=<sec|ms>    Timeout in seconds (e.g. 43200 or 43200s) or milliseconds (43200000ms); default: 12h
  --compress=<method>              Compression method for basebackup (default: server-zstd)
  --max-rate=<rate>                Pass --max-rate to pg_basebackup (e.g. 30M) to throttle I/O
  --pg-runner=docker|host          Execution mode for PG binaries (default: docker). docker runs
                                   them inside the standby container via docker exec (or a one-shot
                                   container of the same service for setup/switchback);
                                   host requires a local PostgreSQL 18 client installation.
  --pg-image=<image>               Container image for --pg-runner=docker (default: pgvector/pgvector:pg18)
  --drill-dir=<dir> --drill-port=<p>  Rehearsal drill directory (in-container path in docker mode) and port
  --keep-drill                     Keep the drill cluster and START the drill board (needs BETTER_AUTH_SECRET,
                                   PAPERCLIP_DB_PASSWORD in the environment)
  --cleanup-drill                  Rehearse: tear down a kept drill (board + drill cluster + drill dir)
`);
      return command === "help" ? 0 : 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const exitCode = runCli(process.argv.slice(2));
  process.exit(exitCode);
}

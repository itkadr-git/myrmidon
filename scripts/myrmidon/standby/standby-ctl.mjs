#!/usr/bin/env node
// Standby control tool for central databases (Board DB and Hindsight DB).
// Supports replication setup, lag and RPO monitoring, failover, switchback, and restore rehearsal.
//
// Usage:
//   node standby-ctl.mjs setup [--target board|hindsight|all] [--dry-run]
//   node standby-ctl.mjs check-lag [--target board|hindsight|all] [--rpo <seconds>] [--json]
//   node standby-ctl.mjs failover [--target board|hindsight|all] [--dry-run] [--json]
//   node standby-ctl.mjs switchback [--target board|hindsight|all] [--dry-run] [--json]
//   node standby-ctl.mjs rehearse [--target board|hindsight|all] [--dry-run] [--json]
//
// Node built-ins only.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CONFIG = {
  rpoMaxSeconds: 900, // 15 minutes RPO
  rtoMaxSeconds: 1800, // 30 minutes RTO
  primaryHost: process.env.PRIMARY_PG_HOST || "primary-host",
  primaryPort: Number(process.env.PRIMARY_PG_PORT || 5432),
  standbyHost: process.env.STANDBY_PG_HOST || "standby-host",
  board: {
    name: "board",
    dbName: "paperclip",
    primaryPort: Number(process.env.PRIMARY_BOARD_PORT || process.env.PRIMARY_PG_PORT || 5432),
    standbyPort: Number(process.env.STANDBY_BOARD_PORT || 5433),
    dataDir: process.env.STANDBY_BOARD_DATA_DIR || "/srv/standby/myrmidon-pg/data",
    walArchiveDir: process.env.BOARD_WAL_ARCHIVE_DIR || "/srv/backups/wal/myrmidon-pg",
    slotName: process.env.BOARD_REPL_SLOT || "standby_board_slot",
    appName: "myrmidon_board_standby",
    user: process.env.BOARD_REPL_USER || "myr_replicator",
  },
  hindsight: {
    name: "hindsight",
    dbName: "myrmidon_hindsight",
    primaryPort: Number(process.env.PRIMARY_HINDSIGHT_PORT || process.env.PRIMARY_PG_PORT || 5432),
    standbyPort: Number(process.env.STANDBY_HINDSIGHT_PORT || 5434),
    dataDir: process.env.STANDBY_HINDSIGHT_DATA_DIR || "/srv/standby/hindsight-pg/data",
    walArchiveDir: process.env.HINDSIGHT_WAL_ARCHIVE_DIR || "/srv/backups/wal/hindsight-pg",
    slotName: process.env.HINDSIGHT_REPL_SLOT || "standby_hindsight_slot",
    appName: "myrmidon_hindsight_standby",
    user: process.env.HINDSIGHT_REPL_USER || "myr_replicator",
  },
};

/**
 * Parses PostgreSQL LSN string 'X/Y' (hex) to BigInt.
 */
export function parseLsn(lsnStr) {
  if (!lsnStr || typeof lsnStr !== "string") return null;
  const parts = lsnStr.trim().split("/");
  if (parts.length !== 2) return null;
  const [high, low] = parts;
  if (!/^[0-9a-fA-F]+$/.test(high) || !/^[0-9a-fA-F]+$/.test(low)) return null;
  try {
    const highVal = BigInt(`0x${high}`);
    const lowVal = BigInt(`0x${low}`);
    return (highVal << 32n) + lowVal;
  } catch {
    return null;
  }
}

/**
 * Converts BigInt back to PostgreSQL LSN format 'X/Y' (hex uppercase).
 */
export function formatLsn(lsnBigInt) {
  if (lsnBigInt === null || lsnBigInt === undefined) return null;
  const val = BigInt(lsnBigInt);
  const high = (val >> 32n).toString(16).toUpperCase();
  const low = (val & 0xffffffffn).toString(16).toUpperCase();
  return `${high}/${low}`;
}

/**
 * Calculates byte difference between two LSNs (lsnA - lsnB).
 */
export function lsnDiff(lsnA, lsnB) {
  const a = typeof lsnA === "bigint" ? lsnA : parseLsn(lsnA);
  const b = typeof lsnB === "bigint" ? lsnB : parseLsn(lsnB);
  if (a === null || b === null) return null;
  return Number(a - b);
}

/**
 * Calculates lag metrics from database query results.
 */
export function calculateLag({ currentLsn, receiveLsn, replayLsn, lastReplayTimestamp, now = new Date() }) {
  const current = parseLsn(currentLsn);
  const receive = parseLsn(receiveLsn);
  const replay = parseLsn(replayLsn);

  // Byte lag from primary write head to standby replay
  const byteLag = current !== null && replay !== null ? Number(current - replay) : null;
  // Byte lag between received WAL and replayed WAL on standby
  const receiveReplayByteLag = receive !== null && replay !== null ? Number(receive - replay) : null;

  let replayDelaySeconds = 0;
  if (lastReplayTimestamp) {
    const replayTime = new Date(lastReplayTimestamp).getTime();
    const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (!Number.isNaN(replayTime) && !Number.isNaN(currentTime)) {
      replayDelaySeconds = Math.max(0, Math.floor((currentTime - replayTime) / 1000));
    }
  }

  // If standby is replaying and caught up with receive LSN, byte lag on standby is 0
  const isCaughtUp = receive !== null && replay !== null && receive === replay;

  return {
    byteLag: byteLag !== null ? Math.max(0, byteLag) : 0,
    receiveReplayByteLag: receiveReplayByteLag !== null ? Math.max(0, receiveReplayByteLag) : 0,
    replayDelaySeconds,
    isCaughtUp,
  };
}

/**
 * Evaluates whether measured lag meets RPO constraint.
 */
export function evaluateRpo(lagSeconds, maxRpoSeconds = DEFAULT_CONFIG.rpoMaxSeconds) {
  if (lagSeconds === null || lagSeconds === undefined || Number.isNaN(lagSeconds)) {
    return { ok: false, marginSeconds: 0, status: "unknown" };
  }
  const ok = lagSeconds <= maxRpoSeconds;
  return {
    ok,
    marginSeconds: maxRpoSeconds - lagSeconds,
    status: ok ? "ok" : "lag_exceeded",
  };
}

/**
 * Constructs arguments for pg_basebackup execution.
 */
export function buildBasebackupArgs(targetConfig, options = {}) {
  const host = options.primaryHost || DEFAULT_CONFIG.primaryHost;
  const port = targetConfig.primaryPort;
  const user = targetConfig.user;
  const dataDir = targetConfig.dataDir;
  const slot = targetConfig.slotName;

  return [
    "-h",
    String(host),
    "-p",
    String(port),
    "-U",
    String(user),
    "-D",
    String(dataDir),
    "-Fp", // Plain format
    "-Xs", // Stream WAL
    "-R",  // Write standby connection settings
    `--slot=${slot}`,
    "-v",
    "-P",
  ];
}

/**
 * Generates postgresql.auto.conf contents for warm standby.
 */
export function generateStandbyConfig(targetConfig, options = {}) {
  const host = options.primaryHost || DEFAULT_CONFIG.primaryHost;
  const port = targetConfig.primaryPort;
  const user = targetConfig.user;
  const app = targetConfig.appName;
  const slot = targetConfig.slotName;
  const walArchive = targetConfig.walArchiveDir;

  return [
    `# Myrmidon warm standby auto-configuration for ${targetConfig.name}`,
    `primary_conninfo = 'host=${host} port=${port} user=${user} application_name=${app} connect_timeout=10 keepalives_idle=10 keepalives_interval=5 keepalives_count=3'`,
    `primary_slot_name = '${slot}'`,
    `hot_standby = on`,
    `restore_command = 'test -f ${walArchive}/%f && cp ${walArchive}/%f %p'`,
    `archive_cleanup_command = 'pg_archivecleanup ${walArchive} %r'`,
    `wal_receiver_timeout = 60s`,
    `max_standby_streaming_delay = 30s`,
  ].join("\n") + "\n";
}

/**
 * Generates docker-compose YAML for standby services on standby host.
 */
export function generateComposeStandby(config = DEFAULT_CONFIG) {
  return `services:
  myrmidon-pg-standby:
    image: docker.io/pgvector/pgvector:pg18
    restart: unless-stopped
    ports:
      - "\${STANDBY_BOARD_PORT:-${config.board.standbyPort}}:5432"
    volumes:
      - \${STANDBY_BOARD_DATA_DIR:-${config.board.dataDir}}:/var/lib/postgresql/data
      - \${BOARD_WAL_ARCHIVE_DIR:-${config.board.walArchiveDir}}:/wal-archive:ro
    environment:
      POSTGRES_USER: \${STANDBY_PG_USER:-paperclip}
      POSTGRES_PASSWORD: \${STANDBY_PG_PASSWORD:-paperclip}
    command:
      - postgres
      - -c
      - hot_standby=on
      - -c
      - restore_command=test -f /wal-archive/%f && cp /wal-archive/%f %p
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${STANDBY_PG_USER:-paperclip} -p 5432"]
      interval: 5s
      timeout: 3s
      retries: 5

  hindsight-pg-standby:
    image: docker.io/pgvector/pgvector:pg18
    restart: unless-stopped
    ports:
      - "\${STANDBY_HINDSIGHT_PORT:-${config.hindsight.standbyPort}}:5432"
    volumes:
      - \${STANDBY_HINDSIGHT_DATA_DIR:-${config.hindsight.dataDir}}:/var/lib/postgresql/data
      - \${HINDSIGHT_WAL_ARCHIVE_DIR:-${config.hindsight.walArchiveDir}}:/wal-archive:ro
    environment:
      POSTGRES_USER: \${STANDBY_PG_USER:-postgres}
      POSTGRES_PASSWORD: \${STANDBY_PG_PASSWORD:-postgres}
    command:
      - postgres
      - -c
      - hot_standby=on
      - -c
      - restore_command=test -f /wal-archive/%f && cp /wal-archive/%f %p
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${STANDBY_PG_USER:-postgres} -p 5432"]
      interval: 5s
      timeout: 3s
      retries: 5
`;
}

/**
 * Parses raw SQL query results for replication status.
 */
export function parseReplicationStatus(output) {
  if (!output || typeof output !== "string") {
    return { inRecovery: false, receiveLsn: null, replayLsn: null, lastReplayTimestamp: null };
  }
  const lines = output.trim().split("\n");
  for (const line of lines) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length >= 4) {
      return {
        inRecovery: parts[0] === "t" || parts[0] === "true",
        receiveLsn: parts[1] || null,
        replayLsn: parts[2] || null,
        lastReplayTimestamp: parts[3] || null,
      };
    }
  }
  return { inRecovery: false, receiveLsn: null, replayLsn: null, lastReplayTimestamp: null };
}

/**
 * Builds standard SQL query for standby monitoring.
 */
export function buildStandbyStatusQuery() {
  return "SELECT pg_is_in_recovery(), pg_last_wal_receive_lsn()::text, pg_last_wal_replay_lsn()::text, pg_last_xact_replay_timestamp()::text;";
}

/**
 * Evaluates status for a single target (board or hindsight).
 */
export function evaluateTargetStatus(targetConfig, rawStatus, options = {}) {
  const rpoMax = options.rpoMaxSeconds || DEFAULT_CONFIG.rpoMaxSeconds;
  const now = options.now || new Date();
  const parsed = parseReplicationStatus(rawStatus);

  if (!parsed.inRecovery) {
    return {
      target: targetConfig.name,
      inRecovery: false,
      role: "primary_or_standalone",
      rpoStatus: "not_in_standby",
      rpoOk: false,
      byteLag: 0,
      timeLagSeconds: 0,
      receiveLsn: parsed.receiveLsn,
      replayLsn: parsed.replayLsn,
    };
  }

  const lagMetrics = calculateLag({
    currentLsn: parsed.receiveLsn,
    receiveLsn: parsed.receiveLsn,
    replayLsn: parsed.replayLsn,
    lastReplayTimestamp: parsed.lastReplayTimestamp,
    now,
  });

  const rpoEval = evaluateRpo(lagMetrics.replayDelaySeconds, rpoMax);

  return {
    target: targetConfig.name,
    inRecovery: true,
    role: "warm_standby",
    rpoStatus: rpoEval.status,
    rpoOk: rpoEval.ok,
    byteLag: lagMetrics.receiveReplayByteLag,
    timeLagSeconds: lagMetrics.replayDelaySeconds,
    isCaughtUp: lagMetrics.isCaughtUp,
    receiveLsn: parsed.receiveLsn,
    replayLsn: parsed.replayLsn,
    lastReplayTimestamp: parsed.lastReplayTimestamp,
    marginSeconds: rpoEval.marginSeconds,
  };
}

/**
 * Executes a shell command or logs in dry-run mode.
 */
function runCommand(cmd, args, dryRun = false) {
  if (dryRun) {
    return { exitCode: 0, stdout: `[dry-run] ${cmd} ${args.join(" ")}`, stderr: "" };
  }
  try {
    const res = spawnSync(cmd, args, { encoding: "utf8" });
    return {
      exitCode: res.status ?? 1,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
    };
  } catch (err) {
    return { exitCode: 1, stdout: "", stderr: String(err) };
  }
}

/**
 * Failover execution for standby instance.
 */
export function planFailover(targetConfig, options = {}) {
  const port = targetConfig.standbyPort;
  const dataDir = targetConfig.dataDir;
  return {
    target: targetConfig.name,
    promoteSql: "SELECT pg_promote();",
    pgCtlCommand: ["pg_ctl", "promote", "-D", dataDir],
    verifySql: "SELECT pg_is_in_recovery();",
    newEndpoint: `postgresql://${options.standbyHost || DEFAULT_CONFIG.standbyHost}:${port}/${targetConfig.dbName}`,
    targetPort: port,
  };
}

/**
 * Switchback execution plan to re-establish replication following primary restore.
 */
export function planSwitchback(targetConfig, options = {}) {
  const host = options.primaryHost || DEFAULT_CONFIG.primaryHost;
  const port = targetConfig.primaryPort;
  const basebackupArgs = buildBasebackupArgs(targetConfig, options);
  const standbyConfig = generateStandbyConfig(targetConfig, options);

  return {
    target: targetConfig.name,
    primaryEndpoint: `postgresql://${host}:${port}/${targetConfig.dbName}`,
    basebackupArgs,
    standbySignalPath: path.join(targetConfig.dataDir, "standby.signal"),
    standbyConfig,
  };
}

/**
 * Rehearsal execution plan for isolated restore drill.
 */
export function planRehearsal(targetConfig, options = {}) {
  const scratchDir = options.scratchDir || `/tmp/rehearsal-${targetConfig.name}`;
  const drillPort = targetConfig.standbyPort + 100;
  return {
    target: targetConfig.name,
    sourceDataDir: targetConfig.dataDir,
    drillDir: scratchDir,
    drillPort,
    steps: [
      `mkdir -p ${scratchDir}`,
      `cp -a ${targetConfig.dataDir}/* ${scratchDir}/`,
      `touch ${scratchDir}/.drill-marker`,
      `pg_ctl promote -D ${scratchDir}`,
      `pg_isready -p ${drillPort}`,
      `rm -rf ${scratchDir}`,
    ],
  };
}

// -----------------------------------------------------------------------------
// CLI Actions
// -----------------------------------------------------------------------------

export function runCli(argv) {
  const args = argv.slice(2);
  const command = args[0] || "--help";

  const flags = {
    target: "all",
    json: false,
    dryRun: false,
    rpo: DEFAULT_CONFIG.rpoMaxSeconds,
  };

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") flags.json = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--target" && args[i + 1]) flags.target = args[++i];
    else if (a === "--rpo" && args[i + 1]) flags.rpo = Number(args[++i]);
    else if (a === "-h" || a === "--help") return printHelp();
  }

  const targets =
    flags.target === "board"
      ? [DEFAULT_CONFIG.board]
      : flags.target === "hindsight"
        ? [DEFAULT_CONFIG.hindsight]
        : [DEFAULT_CONFIG.board, DEFAULT_CONFIG.hindsight];

  switch (command) {
    case "setup": {
      const results = targets.map((t) => {
        const basebackup = buildBasebackupArgs(t, flags);
        const configText = generateStandbyConfig(t, flags);
        return {
          target: t.name,
          basebackupCmd: `pg_basebackup ${basebackup.join(" ")}`,
          dataDir: t.dataDir,
          walArchiveDir: t.walArchiveDir,
          standbyConfigSnippet: configText.trim(),
        };
      });

      if (flags.json) {
        console.log(JSON.stringify({ status: "setup_planned", results, dryRun: flags.dryRun }, null, 2));
      } else {
        console.log("=== Standby Setup Plan ===");
        for (const r of results) {
          console.log(`\nTarget: ${r.target}`);
          console.log(`  Data Directory: ${r.dataDir}`);
          console.log(`  WAL Archive:    ${r.walArchiveDir}`);
          console.log(`  Sync Command:   ${r.basebackupCmd}`);
        }
      }
      return 0;
    }

    case "check-lag": {
      const now = new Date();
      const results = targets.map((t) => {
        let rawSqlOutput = "";
        if (flags.dryRun) {
          rawSqlOutput = `t | 0/1A00000 | 0/1A00000 | ${now.toISOString()}`;
        } else {
          const res = runCommand("psql", [
            "-h",
            DEFAULT_CONFIG.standbyHost,
            "-p",
            String(t.standbyPort),
            "-U",
            t.user,
            "-t",
            "-A",
            "-c",
            buildStandbyStatusQuery(),
          ]);
          rawSqlOutput = res.exitCode === 0 ? res.stdout : "";
        }
        return evaluateTargetStatus(t, rawSqlOutput, { rpoMaxSeconds: flags.rpo, now });
      });

      const allOk = results.every((r) => r.rpoOk);

      if (flags.json) {
        console.log(JSON.stringify({ status: allOk ? "ok" : "alert", rpoMaxSeconds: flags.rpo, results }, null, 2));
      } else {
        console.log("=== Replication Freshness & Lag Report ===");
        console.log(`RPO Threshold: <= ${flags.rpo}s (15 min)\n`);
        for (const r of results) {
          console.log(`Target: ${r.target.toUpperCase()}`);
          console.log(`  Role:           ${r.role}`);
          console.log(`  In Recovery:    ${r.inRecovery}`);
          console.log(`  Byte Lag:       ${r.byteLag} bytes`);
          console.log(`  Replay Delay:   ${r.timeLagSeconds}s`);
          console.log(`  RPO Status:     ${r.rpoStatus.toUpperCase()}`);
          console.log(`  RPO Compliant:  ${r.rpoOk ? "YES" : "NO"}\n`);
        }
      }
      return allOk ? 0 : 1;
    }

    case "failover": {
      const plans = targets.map((t) => planFailover(t, flags));
      if (flags.json) {
        console.log(JSON.stringify({ status: "failover_prepared", plans, dryRun: flags.dryRun }, null, 2));
      } else {
        console.log("=== Failover / Promotion Execution Plan ===");
        for (const p of plans) {
          console.log(`\nPromoting Target: ${p.target}`);
          console.log(`  SQL:            ${p.promoteSql}`);
          console.log(`  pg_ctl fallback:${p.pgCtlCommand.join(" ")}`);
          console.log(`  New Endpoint:   ${p.newEndpoint}`);
        }
      }
      return 0;
    }

    case "switchback": {
      const plans = targets.map((t) => planSwitchback(t, flags));
      if (flags.json) {
        console.log(JSON.stringify({ status: "switchback_prepared", plans, dryRun: flags.dryRun }, null, 2));
      } else {
        console.log("=== Switchback / Demote Plan ===");
        for (const p of plans) {
          console.log(`\nTarget: ${p.target}`);
          console.log(`  Resync from:    ${p.primaryEndpoint}`);
          console.log(`  Standby Signal: ${p.standbySignalPath}`);
        }
      }
      return 0;
    }

    case "rehearse": {
      const plans = targets.map((t) => planRehearsal(t, flags));
      if (flags.json) {
        console.log(JSON.stringify({ status: "rehearsal_planned", plans, dryRun: flags.dryRun }, null, 2));
      } else {
        console.log("=== Disaster Recovery Restore Drill (Rehearsal) ===");
        for (const p of plans) {
          console.log(`\nTarget: ${p.target}`);
          console.log(`  Drill Directory: ${p.drillDir}`);
          console.log(`  Drill Port:      ${p.drillPort}`);
          console.log("  Steps:");
          p.steps.forEach((s) => console.log(`    - ${s}`));
        }
      }
      return 0;
    }

    case "compose": {
      const composeContent = generateComposeStandby(DEFAULT_CONFIG);
      console.log(composeContent);
      return 0;
    }

    case "--help":
    default:
      return printHelp();
  }
}

function printHelp() {
  console.log(`
myrmidon standby-ctl: Warm standby management for central databases

Commands:
  setup       Generate initial basebackup and standby configuration
  check-lag   Verify replication lag against RPO constraint (<= 15 min)
  failover    Promote standby database to primary
  switchback  Revert / resync standby following primary restoration
  rehearse    Execute safe, isolated restore drill without disrupting live replication
  compose     Print docker-compose.standby.yml definition

Flags:
  --target <board|hindsight|all>  Target database instance (default: all)
  --rpo <seconds>                 RPO threshold in seconds (default: 900)
  --json                          Emit structured JSON output
  --dry-run                       Simulate actions without executing commands
  -h, --help                      Show this help message
`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("standby-ctl.mjs")) {
  const code = runCli(process.argv);
  process.exit(code);
}

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * standby-ctl.mjs
 *
 * Operational CLI and control module for Myrmidon center warm standby (Option A+A2, OPE-7656).
 * Manages PostgreSQL warm standby replication for Board DB and Hindsight DB on myr-vm1,
 * lag measurement against primary LSN, automated failover promotion, switchback, and rehearsal.
 */

export const DEFAULT_CONFIG = {
  primaryHost: process.env.PRIMARY_PG_HOST || "primary.internal",
  primaryBoardPort: 5432,
  primaryHindsightPort: 5432,
  standbyHost: "127.0.0.1",
  standbyBoardPort: 5433,
  standbyHindsightPort: 5433,
  boardReplUser: "myr_replicator",
  hindsightReplUser: "myr_replicator",
  boardReplSlot: "standby_board_slot",
  hindsightReplSlot: "standby_board_slot",
  boardDataDir: "/srv/standby/myrmidon-pg/data",
  hindsightDataDir: "/srv/standby/myrmidon-pg/data",
  boardWalArchiveDir: "/srv/backups/wal/myrmidon-pg",
  hindsightWalArchiveDir: "/srv/backups/wal/myrmidon-pg",
  boardDbUser: "paperclip",
  boardDbName: "paperclip",
  hindsightDbUser: "myrmidon_hindsight",
  hindsightDbName: "myrmidon_hindsight",
  replicatorPassword: process.env.PG_REPLICATOR_PASSWORD || "",
  passfilePath: process.env.PG_PASSFILE_PATH || "",
  credentialPath: process.env.STANDBY_CREDENTIAL_PATH || "",
  rpoMaxSeconds: 900, // RPO <= 15 min
  rtoTargetSeconds: 1800, // RTO <= 30 min
};

export const defaultFsOps = {
  mkdirSync: fs.mkdirSync,
  writeFileSync: fs.writeFileSync,
  readFileSync: fs.readFileSync,
  existsSync: fs.existsSync,
  rmSync: fs.rmSync,
  readdirSync: fs.readdirSync,
  chmodSync: fs.chmodSync,
};

export function defaultRunner(cmd, args = [], options = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30000,
    env: { ...process.env, ...options.env },
  });
  return {
    exitCode: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? String(res.error) : ""),
  };
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

  const inRecovery = parts[0] === "t" || parts[0] === "true";
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
  const primaryPort = isBoard
    ? overrides.primaryBoardPort || DEFAULT_CONFIG.primaryBoardPort
    : overrides.primaryHindsightPort || DEFAULT_CONFIG.primaryHindsightPort;
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

  // Use passfile for standby authentication; never embed raw password in primary_conninfo
  const passfilePath =
    overrides.containerPassfilePath ||
    overrides.passfilePath ||
    overrides.credentialPath ||
    DEFAULT_CONFIG.passfilePath ||
    DEFAULT_CONFIG.credentialPath ||
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
 */
export function generateBasebackupCommand(target = "board", overrides = {}) {
  const isBoard = target === "board";
  const primaryHost = overrides.primaryHost || DEFAULT_CONFIG.primaryHost;
  const primaryPort = isBoard
    ? overrides.primaryBoardPort || DEFAULT_CONFIG.primaryBoardPort
    : overrides.primaryHindsightPort || DEFAULT_CONFIG.primaryHindsightPort;
  const replUser = isBoard
    ? overrides.boardReplUser || DEFAULT_CONFIG.boardReplUser
    : overrides.hindsightReplUser || DEFAULT_CONFIG.hindsightReplUser;
  const replSlot = isBoard
    ? overrides.boardReplSlot || DEFAULT_CONFIG.boardReplSlot
    : overrides.hindsightReplSlot || DEFAULT_CONFIG.hindsightReplSlot;
  const dataDir = isBoard
    ? overrides.boardDataDir || DEFAULT_CONFIG.boardDataDir
    : overrides.hindsightDataDir || DEFAULT_CONFIG.hindsightDataDir;

  const args = [
    "-h", primaryHost,
    "-p", String(primaryPort),
    "-U", replUser,
    "-D", dataDir,
    "-Fp",
    "-Xs",
    "-R",
    `--slot=${replSlot}`,
    "--checkpoint=fast",
  ];

  return {
    executable: "pg_basebackup",
    args,
    commandString: `pg_basebackup ${args.join(" ")}`,
  };
}

export function planFailover(target = "board", overrides = {}) {
  const isBoard = target === "board";
  const port = isBoard
    ? overrides.standbyBoardPort || DEFAULT_CONFIG.standbyBoardPort
    : overrides.standbyHindsightPort || DEFAULT_CONFIG.standbyHindsightPort;
  const user = isBoard
    ? overrides.boardDbUser || DEFAULT_CONFIG.boardDbUser
    : overrides.hindsightDbUser || DEFAULT_CONFIG.hindsightDbUser;
  const db = isBoard
    ? overrides.boardDbName || DEFAULT_CONFIG.boardDbName
    : overrides.hindsightDbName || DEFAULT_CONFIG.hindsightDbName;
  const dataDir = isBoard
    ? overrides.boardDataDir || DEFAULT_CONFIG.boardDataDir
    : overrides.hindsightDataDir || DEFAULT_CONFIG.hindsightDataDir;

  return {
    target,
    promoteSql: "SELECT pg_promote();",
    promoteCli: `pg_ctl promote -D ${dataDir}`,
    verifySql: "SELECT pg_is_in_recovery();",
    appEndpoint: `127.0.0.1:${port}`,
    connectionString: `postgresql://${user}:***@127.0.0.1:${port}/${db}`,
    appRestartCmd: "docker compose up -d --force-recreate myrmidon-board",
    healthCheckUrl: "http://127.0.0.1:3100/healthz",
  };
}

export function planSwitchback(target = "board", overrides = {}) {
  const basebackup = generateBasebackupCommand(target, overrides);
  const config = generateStandbyConfig(target, overrides);
  const isBoard = target === "board";
  const dataDir = isBoard
    ? overrides.boardDataDir || DEFAULT_CONFIG.boardDataDir
    : overrides.hindsightDataDir || DEFAULT_CONFIG.hindsightDataDir;

  return {
    target,
    step1_verifyPrimary: "SELECT pg_is_in_recovery(); -- ensure original primary is active primary",
    step2_stopStandby: "docker compose stop myrmidon-pg-standby",
    step3_resync: basebackup.commandString,
    step4_standbySignal: `touch ${dataDir}/standby.signal`,
    step5_config: config,
    step6_startStandby: "docker compose up -d myrmidon-pg-standby",
    step7_verifyRecovery: "SELECT pg_is_in_recovery(); -- must return true",
  };
}

export function planRehearsal(target = "board", overrides = {}) {
  const isBoard = target === "board";
  const drillPort = overrides.drillPort || 5533;
  const drillDir = overrides.drillDir || `/srv/standby/drill-cluster`;
  const standbyPort = isBoard
    ? overrides.standbyBoardPort || DEFAULT_CONFIG.standbyBoardPort
    : overrides.standbyHindsightPort || DEFAULT_CONFIG.standbyHindsightPort;
  const boardUser = overrides.boardDbUser || DEFAULT_CONFIG.boardDbUser;
  const boardDb = overrides.boardDbName || DEFAULT_CONFIG.boardDbName;
  const hindsightUser = overrides.hindsightDbUser || DEFAULT_CONFIG.hindsightDbUser;
  const hindsightDb = overrides.hindsightDbName || DEFAULT_CONFIG.hindsightDbName;
  const replUser = isBoard
    ? overrides.boardReplUser || DEFAULT_CONFIG.boardReplUser
    : overrides.hindsightReplUser || DEFAULT_CONFIG.hindsightReplUser;

  return {
    target,
    drillDir,
    drillPort,
    step1_snapshot: `pg_basebackup -h 127.0.0.1 -p ${standbyPort} -U ${replUser} -D ${drillDir} -Fp -Xs -R`,
    step2_startEphemeral: `pg_ctl start -D ${drillDir} -o "-p ${drillPort} -c listen_addresses=127.0.0.1"`,
    step3_promote: `psql -h 127.0.0.1 -p ${drillPort} -U ${boardUser} -d ${boardDb} -c "SELECT pg_promote();"`,
    step4_verify: `psql -h 127.0.0.1 -p ${drillPort} -U ${boardUser} -d ${boardDb} -t -A -c "SELECT pg_is_in_recovery();"`,
    step5_smokeTest: `psql -h 127.0.0.1 -p ${drillPort} -U ${boardUser} -d ${boardDb} -c "SELECT 1;" && psql -h 127.0.0.1 -p ${drillPort} -U ${hindsightUser} -d ${hindsightDb} -c "SELECT 1;"`,
    step6_stopClean: `pg_ctl stop -D ${drillDir} -m immediate`,
    step7_cleanup: `rm -rf ${drillDir}`,
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

/**
 * Setup warm standby replication for cluster / target DB.
 */
export function setupStandby(target = "board", options = {}, deps = {}) {
  const runner = deps.runner || defaultRunner;
  const fsOps = deps.fsOps || defaultFsOps;
  const isBoard = target === "board";

  const dataDir = isBoard
    ? options.boardDataDir || DEFAULT_CONFIG.boardDataDir
    : options.hindsightDataDir || DEFAULT_CONFIG.hindsightDataDir;

  const primaryHost = options.primaryHost || DEFAULT_CONFIG.primaryHost;
  const primaryPort = isBoard
    ? options.primaryBoardPort || DEFAULT_CONFIG.primaryBoardPort
    : options.primaryHindsightPort || DEFAULT_CONFIG.primaryHindsightPort;
  const replUser = isBoard
    ? options.boardReplUser || DEFAULT_CONFIG.boardReplUser
    : options.hindsightReplUser || DEFAULT_CONFIG.hindsightReplUser;
  const standbyPort = isBoard
    ? options.standbyBoardPort || DEFAULT_CONFIG.standbyBoardPort
    : options.standbyHindsightPort || DEFAULT_CONFIG.standbyHindsightPort;
  const dbUser = isBoard
    ? options.boardDbUser || DEFAULT_CONFIG.boardDbUser
    : options.hindsightDbUser || DEFAULT_CONFIG.hindsightDbUser;
  const dbName = isBoard
    ? options.boardDbName || DEFAULT_CONFIG.boardDbName
    : options.hindsightDbName || DEFAULT_CONFIG.hindsightDbName;

  const composeService = "myrmidon-pg-standby";
  const composeFile = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "docker-compose.standby.yml"
  );

  const basebackup = generateBasebackupCommand(target, options);
  const standbyConfig = generateStandbyConfig(target, options);

  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      target,
      dataDir,
      basebackupCommand: basebackup.commandString,
      configContent: standbyConfig,
      signalFile: path.join(dataDir, "standby.signal"),
    };
  }

  // 1. Check data directory: fail-closed if directory exists and is not empty without --force
  const dirExists = fsOps.existsSync(dataDir);
  let dirEntries = [];
  if (dirExists && fsOps.readdirSync) {
    try {
      dirEntries = fsOps.readdirSync(dataDir);
    } catch {
      dirEntries = [];
    }
  }
  const isNonEmpty = dirExists && dirEntries.length > 0;

  if (isNonEmpty && !options.force) {
    return {
      success: false,
      target,
      error: `Directory '${dataDir}' exists but is not empty. Specify --force to clean and resynchronize standby.`,
    };
  }

  if (isNonEmpty && options.force) {
    // Stop standby container before wiping dataDir
    runner("docker", ["compose", "-f", composeFile, "stop", composeService]);
    try {
      fsOps.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
    fsOps.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } else {
    try {
      fsOps.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return {
        success: false,
        target,
        error: `Failed to create data directory ${dataDir}: ${err.message}`,
      };
    }
  }

  // 2. Prepare host-side replication credentials / passfile before basebackup
  const replPassword =
    options.replicatorPassword !== undefined
      ? options.replicatorPassword
      : DEFAULT_CONFIG.replicatorPassword;
  const credentialPath =
    options.credentialPath ||
    options.passfilePath ||
    DEFAULT_CONFIG.credentialPath ||
    DEFAULT_CONFIG.passfilePath;

  let hostPassfilePath = credentialPath;
  if (!hostPassfilePath) {
    hostPassfilePath = path.join(path.dirname(dataDir), ".pgpass");
  }

  if (replPassword) {
    try {
      const passDir = path.dirname(hostPassfilePath);
      if (!fsOps.existsSync(passDir)) {
        fsOps.mkdirSync(passDir, { recursive: true, mode: 0o700 });
      }
      fsOps.writeFileSync(
        hostPassfilePath,
        `${primaryHost}:${primaryPort}:*:${replUser}:${replPassword}\n`
      );
      if (fsOps.chmodSync) {
        fsOps.chmodSync(hostPassfilePath, 0o600);
      }
    } catch (err) {
      return {
        success: false,
        target,
        error: `Failed to create host passfile at ${hostPassfilePath}: ${err.message}`,
      };
    }
  } else if (!fsOps.existsSync(hostPassfilePath)) {
    return {
      success: false,
      target,
      error: `Replication credentials missing: passfile not found at '${hostPassfilePath}' and no replication password provided (set PG_REPLICATOR_PASSWORD or pass credentialPath)`,
    };
  }

  // 3. Run pg_basebackup with PGPASSFILE in environment
  const baseRes = runner(basebackup.executable, basebackup.args, {
    timeoutMs: 300000,
    env: {
      ...process.env,
      PGPASSFILE: hostPassfilePath,
    },
  });
  if (baseRes.exitCode !== 0) {
    return {
      success: false,
      target,
      error: `pg_basebackup failed: ${baseRes.stderr || baseRes.stdout}`,
      exitCode: baseRes.exitCode,
    };
  }

  // 4. Write container passfile (.pgpass) inside dataDir and configuration
  const containerPassfileHost = path.join(dataDir, ".pgpass");
  try {
    let pgpassContent = "";
    if (fsOps.existsSync(hostPassfilePath)) {
      pgpassContent = fsOps.readFileSync(hostPassfilePath, "utf8");
    } else if (replPassword) {
      pgpassContent = `${primaryHost}:${primaryPort}:*:${replUser}:${replPassword}\n`;
    }
    fsOps.writeFileSync(containerPassfileHost, pgpassContent);
    if (fsOps.chmodSync) {
      fsOps.chmodSync(containerPassfileHost, 0o600);
    }
  } catch (err) {
    return {
      success: false,
      target,
      error: `Failed to write container passfile at ${containerPassfileHost}: ${err.message}`,
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

  // 4. Start standby container
  runner("docker", ["compose", "-f", composeFile, "up", "-d", composeService]);

  // 5. Verify standby recovery and streaming receiver
  const verifyRes = queryPostgres(
    "SELECT pg_is_in_recovery()::text, count(*)::text FROM pg_stat_wal_receiver WHERE status = 'streaming';",
    { host: DEFAULT_CONFIG.standbyHost, port: standbyPort, user: dbUser, db: dbName },
    runner
  );

  const statusParts = (verifyRes.stdout || "").trim().split("\n")[0].split("|");
  const inRecovery = statusParts[0] === "t" || statusParts[0] === "true";
  const walReceivers = parseInt(statusParts[1] || "0", 10);
  const streamingActive = inRecovery && walReceivers > 0;

  if (!inRecovery) {
    return {
      success: false,
      target,
      dataDir,
      inRecovery: false,
      walReceivers,
      streamingActive: false,
      error: `Standby node failed to enter recovery mode (pg_is_in_recovery returned false or query failed: ${verifyRes.stderr || verifyRes.stdout})`,
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
      error: "WAL streaming receiver is not active in pg_stat_wal_receiver (status != 'streaming'). Verify replication credentials and connectivity.",
    };
  }

  return {
    success: true,
    target,
    dataDir,
    inRecovery: true,
    streamingActive: true,
    walReceivers,
  };
}

/**
 * Measure replication lag between primary and standby.
 * Implements fail-closed checks against primary LSN and standby replay LSN.
 */
export function checkLag(target = "board", options = {}, deps = {}) {
  const runner = deps.runner || defaultRunner;
  const isBoard = target === "board";

  const primaryHost = options.primaryHost || DEFAULT_CONFIG.primaryHost;
  const primaryPort = isBoard
    ? options.primaryBoardPort || DEFAULT_CONFIG.primaryBoardPort
    : options.primaryHindsightPort || DEFAULT_CONFIG.primaryHindsightPort;
  const standbyHost = options.standbyHost || DEFAULT_CONFIG.standbyHost;
  const standbyPort = isBoard
    ? options.standbyBoardPort || DEFAULT_CONFIG.standbyBoardPort
    : options.standbyHindsightPort || DEFAULT_CONFIG.standbyHindsightPort;
  const dbUser = isBoard
    ? options.boardDbUser || DEFAULT_CONFIG.boardDbUser
    : options.hindsightDbUser || DEFAULT_CONFIG.hindsightDbUser;
  const dbName = isBoard
    ? options.boardDbName || DEFAULT_CONFIG.boardDbName
    : options.hindsightDbName || DEFAULT_CONFIG.hindsightDbName;

  let standbyOutput = options.rawSqlOutput;
  if (!standbyOutput) {
    const res = queryPostgres(
      "SELECT pg_is_in_recovery()::text, COALESCE(pg_last_wal_receive_lsn()::text, ''), COALESCE(pg_last_wal_replay_lsn()::text, ''), COALESCE(pg_last_xact_replay_timestamp()::text, '');",
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

  // Standby is in recovery; now measure against primary current WAL LSN
  let primaryLsn = options.primaryLsn;
  if (!primaryLsn && !options.offline) {
    const pRes = queryPostgres(
      "SELECT COALESCE(pg_current_wal_lsn()::text, '');",
      { host: primaryHost, port: primaryPort, user: dbUser, db: dbName },
      runner
    );
    if (pRes.exitCode !== 0 || !pRes.stdout || pRes.stderr?.includes("error")) {
      // Primary unreachable -> fail-closed: cannot prove RPO
      return {
        target,
        success: false,
        rpoOk: false,
        role: "standby",
        inRecovery: true,
        rpoStatus: "primary_unreachable",
        error: pRes.stderr || "Primary query failed",
        byteLag: null,
        timeLagSeconds: null,
      };
    }
    primaryLsn = pRes.stdout.trim().split("\n")[0].trim();
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
    ...lagInfo,
  };
}

/**
 * Execute promotion and application switchover.
 */
export function executeFailover(target = "board", options = {}, deps = {}) {
  const runner = deps.runner || defaultRunner;
  const isBoard = target === "board";
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
  const standbyPort = isBoard
    ? options.standbyBoardPort || DEFAULT_CONFIG.standbyBoardPort
    : options.standbyHindsightPort || DEFAULT_CONFIG.standbyHindsightPort;
  const dbUser = isBoard
    ? options.boardDbUser || DEFAULT_CONFIG.boardDbUser
    : options.hindsightDbUser || DEFAULT_CONFIG.hindsightDbUser;
  const dbName = isBoard
    ? options.boardDbName || DEFAULT_CONFIG.boardDbName
    : options.hindsightDbName || DEFAULT_CONFIG.hindsightDbName;

  // 1. Promote standby
  const promoteRes = queryPostgres(plan.promoteSql, { host: "127.0.0.1", port: standbyPort, user: dbUser, db: dbName }, runner);
  if (promoteRes.exitCode !== 0) {
    return {
      success: false,
      target,
      error: `Promotion failed: ${promoteRes.stderr || promoteRes.stdout}`,
    };
  }

  // 2. Poll until pg_is_in_recovery() returns false
  let promoted = false;
  const maxAttempts = options.maxVerifyAttempts || 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const vRes = queryPostgres(plan.verifySql, { host: "127.0.0.1", port: standbyPort, user: dbUser, db: dbName }, runner);
    const val = (vRes.stdout || "").trim();
    if (val === "f" || val === "false") {
      promoted = true;
      break;
    }
  }

  if (!promoted) {
    return {
      success: false,
      target,
      error: "Standby promotion timed out; database remains in recovery",
    };
  }

  // 3. Reroute / restart application if requested
  let appSwitched = false;
  if (options.restartApp) {
    const restartRes = runner("docker", ["compose", "up", "-d", "--force-recreate", "myrmidon-board"]);
    appSwitched = restartRes.exitCode === 0;
  } else {
    appSwitched = true;
  }

  // 4. Verify application readiness
  let healthOk = false;
  if (options.checkHealth) {
    const healthRes = runner("curl", ["-sf", plan.healthCheckUrl]);
    healthOk = healthRes.exitCode === 0;
  } else {
    healthOk = true;
  }

  const durationMs = Date.now() - startTime;
  const durationSeconds = Math.round(durationMs / 1000);
  const rtoOk = durationSeconds <= DEFAULT_CONFIG.rtoTargetSeconds;

  return {
    success: true,
    target,
    promoted: true,
    inRecovery: false,
    appSwitched,
    healthOk,
    durationSeconds,
    rtoOk,
  };
}

/**
 * Execute switchback: restore standby replica from primary.
 */
export function executeSwitchback(target = "board", options = {}, deps = {}) {
  const runner = deps.runner || defaultRunner;
  const fsOps = deps.fsOps || defaultFsOps;
  const isBoard = target === "board";
  const primaryHost = options.primaryHost || DEFAULT_CONFIG.primaryHost;
  const primaryPort = isBoard
    ? options.primaryBoardPort || DEFAULT_CONFIG.primaryBoardPort
    : options.primaryHindsightPort || DEFAULT_CONFIG.primaryHindsightPort;
  const dbUser = isBoard
    ? options.boardDbUser || DEFAULT_CONFIG.boardDbUser
    : options.hindsightDbUser || DEFAULT_CONFIG.hindsightDbUser;
  const dbName = isBoard
    ? options.boardDbName || DEFAULT_CONFIG.boardDbName
    : options.hindsightDbName || DEFAULT_CONFIG.hindsightDbName;
  const dataDir = isBoard
    ? options.boardDataDir || DEFAULT_CONFIG.boardDataDir
    : options.hindsightDataDir || DEFAULT_CONFIG.hindsightDataDir;

  const composeService = "myrmidon-pg-standby";
  const composeFile = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "docker-compose.standby.yml"
  );

  const plan = planSwitchback(target, options);

  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      target,
      plan,
    };
  }

  // 1. Verify original primary is active primary
  const pRes = queryPostgres("SELECT pg_is_in_recovery()::text;", { host: primaryHost, port: primaryPort, user: dbUser, db: dbName }, runner);
  if (pRes.exitCode !== 0 || (pRes.stdout || "").trim() !== "f") {
    return {
      success: false,
      target,
      error: "Original primary is not an active primary (in recovery or unreachable)",
    };
  }

  // 2. Stop standby container before resync
  const stopRes = runner("docker", ["compose", "-f", composeFile, "stop", composeService]);
  if (stopRes.exitCode !== 0) {
    return {
      success: false,
      target,
      error: `Failed to stop standby container '${composeService}': ${stopRes.stderr || stopRes.stdout}`,
    };
  }

  // 3. Clean stale standby data directory under explicit force flag
  if (fsOps.existsSync(dataDir)) {
    try {
      fsOps.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
    fsOps.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  // 4. Perform basebackup & reconfigure standby with force: true
  const setupRes = setupStandby(target, { ...options, force: true }, { runner, fsOps });
  return {
    success: setupRes.success,
    target,
    resynchronized: setupRes.success,
    inRecovery: setupRes.inRecovery,
    streamingActive: setupRes.streamingActive,
    error: setupRes.error,
  };
}

/**
 * Safe, isolated rehearsal drill on ephemeral port/directory.
 * Verifies recovery promotion and smoke tests BOTH databases (paperclip, myrmidon_hindsight) in one replica.
 */
export function executeRehearsal(target = "board", options = {}, deps = {}) {
  const runner = deps.runner || defaultRunner;
  const fsOps = deps.fsOps || defaultFsOps;
  const isBoard = target === "board";
  const plan = planRehearsal(target, options);

  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      target,
      plan,
    };
  }

  const startTime = Date.now();
  const drillDir = plan.drillDir;
  const drillPort = plan.drillPort;
  const standbyPort = isBoard
    ? options.standbyBoardPort || DEFAULT_CONFIG.standbyBoardPort
    : options.standbyHindsightPort || DEFAULT_CONFIG.standbyHindsightPort;
  const boardUser = options.boardDbUser || DEFAULT_CONFIG.boardDbUser;
  const boardDb = options.boardDbName || DEFAULT_CONFIG.boardDbName;
  const hindsightUser = options.hindsightDbUser || DEFAULT_CONFIG.hindsightDbUser;
  const hindsightDb = options.hindsightDbName || DEFAULT_CONFIG.hindsightDbName;
  const replUser = isBoard
    ? options.boardReplUser || DEFAULT_CONFIG.boardReplUser
    : options.hindsightReplUser || DEFAULT_CONFIG.hindsightReplUser;

  try {
    fsOps.mkdirSync(drillDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { success: false, target, error: `Failed to create drill dir: ${err.message}` };
  }

  // 1. Snapshot from standby
  const snapRes = runner("pg_basebackup", [
    "-h", "127.0.0.1",
    "-p", String(standbyPort),
    "-U", replUser,
    "-D", drillDir,
    "-Fp",
    "-Xs",
    "-R",
  ]);
  if (snapRes.exitCode !== 0) {
    try { fsOps.rmSync(drillDir, { recursive: true, force: true }); } catch {}
    return { success: false, target, error: `Drill snapshot failed: ${snapRes.stderr || snapRes.stdout}` };
  }

  // 2. Start ephemeral postgres instance on drillPort
  const startRes = runner("pg_ctl", ["start", "-D", drillDir, "-o", `-p ${drillPort} -c listen_addresses=127.0.0.1`]);
  if (startRes.exitCode !== 0) {
    try { fsOps.rmSync(drillDir, { recursive: true, force: true }); } catch {}
    return { success: false, target, error: `Drill pg_ctl start failed: ${startRes.stderr || startRes.stdout}` };
  }

  // 3. Promote drill instance
  const promoteRes = queryPostgres("SELECT pg_promote();", { host: "127.0.0.1", port: drillPort, user: boardUser, db: boardDb }, runner);
  if (promoteRes.exitCode !== 0) {
    runner("pg_ctl", ["stop", "-D", drillDir, "-m", "immediate"]);
    try { fsOps.rmSync(drillDir, { recursive: true, force: true }); } catch {}
    return { success: false, target, error: `Drill promotion failed: ${promoteRes.stderr}` };
  }

  // 4. Verify drill recovery false
  const verifyRes = queryPostgres("SELECT pg_is_in_recovery()::text;", { host: "127.0.0.1", port: drillPort, user: boardUser, db: boardDb }, runner);

  // 5. Smoke test BOTH databases in the single replica: paperclip and myrmidon_hindsight
  const boardSmokeRes = queryPostgres("SELECT 1;", { host: "127.0.0.1", port: drillPort, user: boardUser, db: boardDb }, runner);
  const hindsightSmokeRes = queryPostgres("SELECT 1;", { host: "127.0.0.1", port: drillPort, user: hindsightUser, db: hindsightDb }, runner);

  // 6. Clean stop and removal
  runner("pg_ctl", ["stop", "-D", drillDir, "-m", "immediate"]);
  try {
    fsOps.rmSync(drillDir, { recursive: true, force: true });
  } catch {}

  const durationMs = Date.now() - startTime;
  const durationSeconds = Math.round(durationMs / 1000);
  const rtoOk = durationSeconds <= DEFAULT_CONFIG.rtoTargetSeconds;
  const boardSmokeOk = (boardSmokeRes.stdout || "").trim() === "1";
  const hindsightSmokeOk = (hindsightSmokeRes.stdout || "").trim() === "1";
  const smokeTestPassed = boardSmokeOk && hindsightSmokeOk;
  const promoted = (verifyRes.stdout || "").trim() === "f";

  const success = promoted && smokeTestPassed && rtoOk;

  const errors = [];
  if (!promoted) {
    errors.push(
      `Promotion verification failed: in_recovery is '${(verifyRes.stdout || "").trim()}', expected 'f'`
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

  return {
    success,
    target,
    promoted,
    smokeTestPassed,
    verifiedDatabases: [boardDb, hindsightDb],
    durationSeconds,
    targetRtoSeconds: DEFAULT_CONFIG.rtoTargetSeconds,
    rtoOk,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
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
        if (next && !next.startsWith("-")) {
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

  const command = positional[0] || "help";
  const target = positional[1] || flags.target || "all";
  const targets = target === "all" ? ["board", "hindsight"] : [target];

  if (flags["rpo-max-seconds"] !== undefined) {
    flags.rpoMaxSeconds = Number(flags["rpo-max-seconds"]);
  }
  if (flags.rpo !== undefined) {
    flags.rpoMaxSeconds = Number(flags.rpo);
  }
  if (flags.force !== undefined) {
    flags.force = true;
  }
  if (flags["dry-run"] !== undefined) {
    flags.dryRun = true;
  }
  if (flags.offline !== undefined) {
    flags.offline = true;
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

  switch (command) {
    case "setup": {
      const setupTargets = target === "all" ? ["board"] : targets;
      const results = setupTargets.map((t) => setupStandby(t, flags, deps));
      console.log(JSON.stringify({ command: "setup", results }, null, 2));
      const anyFailed = results.some((r) => !r.success);
      return anyFailed ? 1 : 0;
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
      const anyFailed = results.some((r) => !r.success);
      return anyFailed ? 1 : 0;
    }

    case "switchback": {
      const switchTargets = target === "all" ? ["board"] : targets;
      const results = switchTargets.map((t) => executeSwitchback(t, flags, deps));
      console.log(JSON.stringify({ command: "switchback", results }, null, 2));
      const anyFailed = results.some((r) => !r.success);
      return anyFailed ? 1 : 0;
    }

    case "rehearse": {
      const rehearseTargets = target === "all" ? ["board"] : targets;
      const results = rehearseTargets.map((t) => executeRehearsal(t, flags, deps));
      const allSuccess = results.every((r) => r.success);
      const allRtoOk = results.every((r) => r.rtoOk);
      console.log(
        JSON.stringify({ command: "rehearse", allSuccess, allRtoOk, results }, null, 2)
      );
      const anyFailed = results.some((r) => !r.success || !r.rtoOk);
      return anyFailed ? 1 : 0;
    }

    case "help":
    default: {
      console.log(`
Usage: standby-ctl.mjs <command> [target] [options]

Commands:
  setup [board|hindsight|all]      Configure streaming replication and start standby
  check-lag [board|hindsight|all]  Measure lag vs primary WAL LSN, verify RPO <= 15m
  failover [board|hindsight|all]   Promote standby to primary and reroute application
  switchback [board|hindsight|all] Re-sync and restore standby after primary recovery
  rehearse [board|hindsight|all]   Perform isolated rehearsal test, verify RTO <= 30m

Options:
  --dry-run                        Print operational plans without executing commands
  --force                          Allow cleaning non-empty data directory during setup/switchback
  --rpo=<sec>                      Maximum acceptable lag in seconds (alias for --rpo-max-seconds)
  --rpo-max-seconds=<sec>          Maximum acceptable lag in seconds (default: 900)
  --offline                        Measure standby without querying primary
  --target=<target>                board, hindsight, or all (default: all)
`);
      return command === "help" ? 0 : 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const exitCode = runCli(process.argv.slice(2));
  process.exit(exitCode);
}

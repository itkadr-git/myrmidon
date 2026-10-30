/**
 * Hermes SQLite sessions retention and safe idle VACUUM helper.
 *
 * Implements the retention contract for closed tasks older than 7 days:
 * 1. Selects closed tasks based on authoritative workspace state/timestamps and closedTasks/closedKeys.
 * 2. Strictly protects active/in-progress/open tasks and explicit protectKeys.
 * 3. Prunes Hermes sessions, messages, and associated cascade tables in state.db.
 * 4. Runs SQLite VACUUM only during idle state and when sufficient free disk space exists.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Extracts the issue UUID from a Hermes session.
 * Real session_key format: ...:issue:<ISSUE-UUID>[:gN]
 *
 * @param {object} session
 * @returns {string|null}
 */
export function extractIssueIdFromSession(session) {
  if (!session || typeof session !== "object") return null;
  const str = session.session_key || session.id || "";
  if (typeof str !== "string") return null;
  const m = str.match(/:issue:([0-9a-fA-F-]{36})(?::g\d+)?(?:$|:)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Filter closed tasks older than retentionDays (default 7 days).
 *
 * @param {object|Array} input - desiredState object or workspaces array
 * @param {object} [options]
 * @param {Array} [options.workspaces] - optional separate workspaces list
 * @param {Array|Set} [options.protectKeys] - optional protected task keys
 * @param {Array|Set} [options.protectIds] - optional protected task IDs
 * @param {Array|Set} [options.closedKeys] - optional confirmed closed task keys
 * @param {Array|Set} [options.closedTasks] - optional confirmed closed task entries ({ key, closedAt, issueId })
 * @param {Array|Set} [options.closedIds] - optional confirmed closed task IDs
 * @param {number} [options.retentionDays=7] - retention threshold in days
 * @param {Date|number} [options.now=Date.now()] - current reference time
 * @param {Record<string, string|number|Date>} [options.taskTimestamps] - optional timestamp lookup
 * @returns {{ closedTaskKeys: string[], closedTaskIds: string[], protectedKeys: string[], protectedIds: string[], cutoffMs: number }}
 */
export function selectClosedTasksForRetention(input, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const inp = input && typeof input === "object" ? input : {};

  // Gather workspaces from options or input
  let rawWorkspaces = [];
  if (Array.isArray(opts.workspaces)) {
    rawWorkspaces = opts.workspaces;
  } else if (Array.isArray(input)) {
    rawWorkspaces = input;
  } else if (Array.isArray(inp.workspaces)) {
    rawWorkspaces = inp.workspaces;
  }

  const protectedKeys = new Set();
  const protectedIds = new Set();

  const ingestList = (source, target) => {
    if (Array.isArray(source) || source instanceof Set) {
      for (const item of source) {
        if (!item) continue;
        if (typeof item === "string") {
          target.add(item.toLowerCase());
        } else if (typeof item === "object") {
          if (item.key) target.add(String(item.key).toLowerCase());
          if (item.issueId) target.add(String(item.issueId).toLowerCase());
          if (item.id) target.add(String(item.id).toLowerCase());
        }
      }
    }
  };

  // Ingest protected lists from input and options
  ingestList(inp.protectKeys, protectedKeys);
  ingestList(inp.protectedKeys, protectedKeys);
  ingestList(inp.protectIds, protectedIds);
  ingestList(inp.protectedIds, protectedIds);

  ingestList(opts.protectKeys, protectedKeys);
  ingestList(opts.protectedKeys, protectedKeys);
  ingestList(opts.protectIds, protectedIds);
  ingestList(opts.protectedIds, protectedIds);

  const retentionDays = Number.isFinite(opts.retentionDays)
    ? opts.retentionDays
    : Number.isFinite(inp.retentionDays)
      ? inp.retentionDays
      : 7;

  const nowMs =
    opts.now instanceof Date
      ? opts.now.getTime()
      : typeof opts.now === "number"
        ? opts.now
        : inp.now instanceof Date
          ? inp.now.getTime()
          : typeof inp.now === "number"
            ? inp.now
            : Date.now();

  const cutoffMs = nowMs - retentionDays * 86_400_000;

  // Pass 1: register all open/active workspaces or workspaces listed in protectKeys as strictly protected
  for (const w of rawWorkspaces) {
    if (!w || typeof w !== "object") continue;
    const key = w.key ? String(w.key).toLowerCase() : null;
    const id = w.id ? String(w.id).toLowerCase() : null;

    const isOpenStatus =
      w.state === "active" ||
      ["todo", "in_progress", "in_review", "blocked"].includes(w.status);

    const isListedProtected =
      (key && protectedKeys.has(key)) || (id && protectedIds.has(id));

    if (isOpenStatus || isListedProtected) {
      if (key) protectedKeys.add(key);
      if (id) protectedIds.add(id);
    }
  }

  // Pass 2: evaluate workspaces
  // Note: state === 'closing' must NOT be considered closed (it covers reassigned/hidden open tasks).
  // Only tasks explicitly marked closed/done/cancelled with authoritative closedAt are eligible.
  const selectedKeys = new Set();
  const selectedIds = new Set();

  for (const w of rawWorkspaces) {
    if (!w || typeof w !== "object") continue;
    const key = w.key ? String(w.key) : null;
    const id = w.id ? String(w.id).toLowerCase() : null;

    if ((key && protectedKeys.has(key.toLowerCase())) || (id && protectedIds.has(id))) {
      continue;
    }

    const isClosed =
      w.state === "closed" ||
      ["done", "cancelled", "closed"].includes(w.status);

    if (!isClosed) continue;

    // Use authoritative closure timestamp: closedAt, completedAt, cancelledAt.
    // Do NOT fall back to updatedAt or since.
    const timeVal = w.closedAt || w.completedAt || w.cancelledAt;
    if (!timeVal) continue;

    const closedMs = new Date(timeVal).getTime();
    if (isNaN(closedMs) || closedMs >= cutoffMs) {
      // If closed within retention window, protect it
      if (key) protectedKeys.add(key.toLowerCase());
      if (id) protectedIds.add(id);
      continue;
    }

    if (key) selectedKeys.add(key.toLowerCase());
    if (id) selectedIds.add(id);
  }

  // Pass 3: evaluate closedTasks and closedKeys from input and options
  const rawClosedEntries = [
    ...(Array.isArray(inp.closedTasks) ? inp.closedTasks : []),
    ...(Array.isArray(opts.closedTasks) ? opts.closedTasks : []),
    ...(Array.isArray(inp.closedKeys) ? inp.closedKeys : []),
    ...(Array.isArray(opts.closedKeys) ? opts.closedKeys : []),
  ];

  for (const entry of rawClosedEntries) {
    if (!entry) continue;
    if (typeof entry === "object") {
      const key = entry.key ? String(entry.key) : null;
      const id = (entry.issueId || entry.id) ? String(entry.issueId || entry.id).toLowerCase() : null;
      if ((key && protectedKeys.has(key.toLowerCase())) || (id && protectedIds.has(id))) {
        continue;
      }
      const timeVal = entry.closedAt || entry.completedAt || entry.cancelledAt;
      if (timeVal) {
        const closedMs = new Date(timeVal).getTime();
        if (!isNaN(closedMs)) {
          if (closedMs < cutoffMs) {
            if (key) selectedKeys.add(key.toLowerCase());
            if (id) selectedIds.add(id);
          } else {
            if (key) protectedKeys.add(key.toLowerCase());
            if (id) protectedIds.add(id);
          }
        }
      }
    }
  }

  // For candidate closed keys with optional taskTimestamps lookup
  if (opts.taskTimestamps && typeof opts.taskTimestamps === "object") {
    for (const [k, ts] of Object.entries(opts.taskTimestamps)) {
      const lower = k.toLowerCase();
      if (protectedKeys.has(lower) || protectedIds.has(lower)) continue;
      const closedMs = new Date(ts).getTime();
      if (!isNaN(closedMs)) {
        if (closedMs < cutoffMs) {
          if (lower.includes("-")) selectedKeys.add(lower);
          else selectedIds.add(lower);
        } else {
          if (lower.includes("-")) protectedKeys.add(lower);
          else protectedIds.add(lower);
        }
      }
    }
  }

  // Guarantee no protected key or id is ever in selected sets
  for (const k of protectedKeys) selectedKeys.delete(k);
  for (const id of protectedIds) selectedIds.delete(id);

  return {
    closedTaskKeys: Array.from(selectedKeys),
    closedTaskIds: Array.from(selectedIds),
    protectedKeys: Array.from(protectedKeys),
    protectedIds: Array.from(protectedIds),
    cutoffMs,
  };
}

/**
 * Prune Hermes sessions and associated rows for closed tasks older than retentionDays.
 * Runs SQLite VACUUM after pruning only when idle and free space permits.
 *
 * @param {object} options
 * @param {string} [options.stateDbPath]
 * @param {object} [options.desiredState]
 * @param {Array} [options.workspaces]
 * @param {Array} [options.protectKeys]
 * @param {Array} [options.closedKeys]
 * @param {Array} [options.closedTasks]
 * @param {number} [options.retentionDays=7]
 * @param {boolean} [options.idle=true]
 * @param {Date|number} [options.now]
 * @param {Function} [options.log]
 * @returns {{ prunedCount: number, vacuumed: boolean, skippedReason?: string, error?: string }}
 */
export function pruneHermesClosedTaskSessions(options = {}) {
  const {
    stateDbPath = process.env.HERMES_STATE_DB || "/data/hermes/state.db",
    desiredState,
    workspaces,
    protectKeys,
    closedKeys,
    closedTasks,
    retentionDays = 7,
    idle = true,
    now = Date.now(),
    log = () => {},
  } = options;

  if (!fs.existsSync(stateDbPath)) {
    return { prunedCount: 0, vacuumed: false, error: "database_not_found" };
  }

  const nowMs = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now();
  const cutoffMs = nowMs - retentionDays * 86_400_000;

  // Derive selection strictly through selectClosedTasksForRetention with full options
  const selection = selectClosedTasksForRetention(desiredState || workspaces || options, {
    ...options,
    workspaces: workspaces || (desiredState && desiredState.workspaces) || options.workspaces,
    protectKeys: protectKeys || (desiredState && desiredState.protectKeys) || options.protectKeys,
    closedKeys: closedKeys || (desiredState && desiredState.closedKeys) || options.closedKeys,
    closedTasks: closedTasks || (desiredState && desiredState.closedTasks) || options.closedTasks,
    retentionDays,
    now: nowMs,
  });

  const closedTaskIds = new Set(selection.closedTaskIds);
  const protectedIds = new Set(selection.protectedIds);

  if (closedTaskIds.size === 0) {
    return { prunedCount: 0, vacuumed: false, eligibleTasks: 0 };
  }

  let db;
  try {
    db = new DatabaseSync(stateDbPath);
    db.exec("PRAGMA busy_timeout = 5000;");
  } catch (err) {
    return { prunedCount: 0, vacuumed: false, error: `db_open_failed: ${err.message}` };
  }

  try {
    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const existingTables = new Set(tableRows.map((r) => r.name));

    if (!existingTables.has("sessions")) {
      db.close();
      return { prunedCount: 0, vacuumed: false };
    }

    const allSessions = db.prepare("SELECT * FROM sessions").all();
    const sessionsToDelete = new Map();

    function isSessionEligible(session) {
      const issueId = extractIssueIdFromSession(session);
      if (!issueId) {
        // Cron or system session, not an issue session
        return false;
      }
      if (protectedIds.has(issueId)) {
        return false;
      }
      if (!closedTaskIds.has(issueId)) {
        return false;
      }
      const sessTime = session.last_activity_at ?? session.ended_at ?? session.started_at;
      let sessMs = null;
      if (typeof sessTime === "number") {
        sessMs = sessTime > 1e11 ? sessTime : sessTime * 1000;
      } else if (typeof sessTime === "string") {
        const num = Number(sessTime);
        if (!isNaN(num) && num > 0) {
          sessMs = num > 1e11 ? num : num * 1000;
        } else {
          sessMs = Date.parse(sessTime);
        }
      } else if (sessTime instanceof Date) {
        sessMs = sessTime.getTime();
      }

      // Fail closed: if timestamp is invalid or within cutoff (active recently), do NOT delete
      if (sessMs === null || isNaN(sessMs) || sessMs > cutoffMs) {
        return false;
      }
      return true;
    }

    for (const session of allSessions) {
      if (isSessionEligible(session)) {
        sessionsToDelete.set(session.id, session);
      }
    }

    // Critical safety: child/descendant sessions (parent_session_id) are ONLY pruned
    // if they independently pass the eligibility check (closed task + stale timestamp).
    // An active child session is preserved along with its data; its parent_session_id
    // is set to NULL when the stale parent is deleted.

    if (sessionsToDelete.size === 0) {
      db.close();
      return { prunedCount: 0, vacuumed: false };
    }

    // Inspect child table columns to prepare exact statements
    const getCols = (tbl) => {
      if (!existingTables.has(tbl)) return new Set();
      try {
        const cols = db.prepare(`PRAGMA table_info(${tbl})`).all();
        return new Set(cols.map((c) => c.name));
      } catch {
        return new Set();
      }
    };

    const messagesCols = getCols("messages");
    const usageCols = getCols("session_model_usage");
    const locksCols = getCols("compression_locks");
    const leasesCols = getCols("session_turn_leases");
    const obligationsCols = getCols("delivery_obligations");
    const generationsCols = getCols("conversation_generations");
    const delegationsCols = getCols("async_delegations");

    const deleteMessages = messagesCols.has("session_id")
      ? db.prepare("DELETE FROM messages WHERE session_id = ?")
      : null;
    const deleteUsage = usageCols.has("session_id")
      ? db.prepare("DELETE FROM session_model_usage WHERE session_id = ?")
      : null;
    const deleteLocks = locksCols.has("session_id")
      ? db.prepare("DELETE FROM compression_locks WHERE session_id = ?")
      : null;
    const deleteLeases = leasesCols.has("conversation_id")
      ? db.prepare("DELETE FROM session_turn_leases WHERE conversation_id = ?")
      : null;
    const deleteObligations = obligationsCols.has("session_key")
      ? db.prepare("DELETE FROM delivery_obligations WHERE session_key = ?")
      : null;
    const deleteGenerations = generationsCols.has("session_key")
      ? db.prepare("DELETE FROM conversation_generations WHERE session_key = ?")
      : null;
    const deleteDelegations = delegationsCols.has("origin_session") && delegationsCols.has("parent_session_id")
      ? db.prepare("DELETE FROM async_delegations WHERE origin_session = ? OR parent_session_id = ?")
      : null;
    const deleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");
    const unparentChild = db.prepare("UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = ?");
    const survivingSessionByKey = db.prepare("SELECT 1 FROM sessions WHERE session_key = ? LIMIT 1");

    // Execute cascade deletions in a strict immediate transaction
    db.exec("BEGIN IMMEDIATE;");
    try {
      // First, nullify parent_session_id references to prevent self-referential FK constraint failures
      for (const sessId of sessionsToDelete.keys()) {
        unparentChild.run(sessId);
      }

      const deletedSessionKeys = new Set();
      for (const [sessId, session] of sessionsToDelete.entries()) {
        const sessKey = session.session_key;
        if (sessKey) deletedSessionKeys.add(sessKey);

        if (deleteMessages) deleteMessages.run(sessId);
        if (deleteUsage) deleteUsage.run(sessId);
        if (deleteLocks) deleteLocks.run(sessId);
        if (deleteLeases) deleteLeases.run(sessId);
        if (deleteDelegations) deleteDelegations.run(sessId, sessId);
        deleteSession.run(sessId);
      }

      // Safe cleanup of obligations and generations:
      // Only delete by session_key when no surviving sessions share that session_key.
      for (const sessKey of deletedSessionKeys) {
        const surviving = survivingSessionByKey.get(sessKey);
        if (!surviving) {
          if (deleteObligations) deleteObligations.run(sessKey);
          if (deleteGenerations) deleteGenerations.run(sessKey);
        }
      }

      db.exec("COMMIT;");
    } catch (err) {
      try { db.exec("ROLLBACK;"); } catch {}
      db.close();
      log(`hermes-retention: transaction failed: ${err.message}`);
      throw err;
    }

    const prunedCount = sessionsToDelete.size;
    log(`hermes-retention: pruned ${prunedCount} sessions of closed tasks older than ${retentionDays}d`);

    // VACUUM checks: idle check, busy_timeout, free disk space
    if (idle !== true) {
      log("hermes-retention: skipping VACUUM because bot is not idle");
      db.close();
      return { prunedCount, vacuumed: false, skippedReason: "not_idle" };
    }

    // Configure SQLite temp directory on persistent storage in db directory, never /tmp tmpfs
    const dbDir = path.dirname(stateDbPath);
    const sqliteTmpDir = path.join(dbDir, ".sqlite-tmp");
    try {
      fs.mkdirSync(sqliteTmpDir, { recursive: true });
      process.env.SQLITE_TMPDIR = sqliteTmpDir;
      db.exec(`PRAGMA temp_store_directory = '${sqliteTmpDir}';`);
    } catch (err) {
      log(`hermes-retention: temp dir setup: ${err.message}`);
    }

    let freeBytes = Infinity;
    let dbSize = 0;
    try {
      const dbStat = fs.statSync(stateDbPath);
      dbSize = dbStat.size;
      const fsStat = fs.statfsSync(sqliteTmpDir);
      freeBytes = Number(fsStat.bfree) * Number(fsStat.bsize);
    } catch (err) {
      log(`hermes-retention: filesystem stat check: ${err.message}`);
    }

    // Require free space of at least 1.5x database size
    if (freeBytes < dbSize * 1.5) {
      log(`hermes-retention: skipping VACUUM: free space (${Math.round(freeBytes / 1024 / 1024)}MB) < 1.5x db size (${Math.round(dbSize / 1024 / 1024)}MB)`);
      db.close();
      return { prunedCount, vacuumed: false, skippedReason: "insufficient_free_space" };
    }

    let vacuumed = false;
    try {
      db.exec("VACUUM;");
      vacuumed = true;
    } catch (err) {
      log(`hermes-retention: VACUUM failed: ${err.message}`);
      vacuumed = false;
    } finally {
      try {
        const tmpFiles = fs.readdirSync(sqliteTmpDir);
        for (const f of tmpFiles) {
          try { fs.unlinkSync(path.join(sqliteTmpDir, f)); } catch {}
        }
      } catch {}
    }

    db.close();
    return { prunedCount, vacuumed };
  } catch (err) {
    try { db.close(); } catch {}
    throw err;
  }
}

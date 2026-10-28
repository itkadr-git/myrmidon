/**
 * Hermes SQLite sessions retention and safe idle VACUUM helper.
 *
 * Implements the retention contract for closed tasks older than 7 days:
 * 1. Selects closed tasks based on authoritative workspace state/timestamps and closedKeys.
 * 2. Strictly protects active/in-progress/open tasks and explicit protectKeys.
 * 3. Prunes Hermes sessions, messages, and associated cascade tables in state.db.
 * 4. Runs SQLite VACUUM during idle state after pruning.
 */

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Filter closed tasks older than retentionDays (default 7 days).
 *
 * @param {object|Array} input - desiredState object or workspaces array
 * @param {object} [options]
 * @param {Array} [options.workspaces] - optional separate workspaces list
 * @param {Array|Set} [options.protectKeys] - optional protected task keys
 * @param {Array|Set} [options.protectIds] - optional protected task IDs
 * @param {Array|Set} [options.closedKeys] - optional confirmed closed task keys
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
  const closedKeysSet = new Set();
  const closedIdsSet = new Set();

  const ingest = (source, target) => {
    if (Array.isArray(source) || source instanceof Set) {
      for (const item of source) {
        if (item) target.add(String(item));
      }
    }
  };

  // Ingest protected lists from input and options
  ingest(inp.protectKeys, protectedKeys);
  ingest(inp.protectedKeys, protectedKeys);
  ingest(inp.protectIds, protectedIds);
  ingest(inp.protectedIds, protectedIds);

  ingest(opts.protectKeys, protectedKeys);
  ingest(opts.protectedKeys, protectedKeys);
  ingest(opts.protectIds, protectedIds);
  ingest(opts.protectedIds, protectedIds);

  // Ingest closed candidates from input and options
  ingest(inp.closedKeys, closedKeysSet);
  ingest(inp.closedTaskKeys, closedKeysSet);
  ingest(inp.closedIds, closedIdsSet);
  ingest(inp.closedTaskIds, closedIdsSet);

  ingest(opts.closedKeys, closedKeysSet);
  ingest(opts.closedTaskKeys, closedKeysSet);
  ingest(opts.closedIds, closedIdsSet);
  ingest(opts.closedTaskIds, closedIdsSet);

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

  // Pass 1: register all open/active workspaces as strictly protected
  for (const w of rawWorkspaces) {
    if (!w || typeof w !== "object") continue;
    const key = w.key ? String(w.key) : null;
    const id = w.id ? String(w.id) : null;

    const isOpenStatus =
      w.state === "active" ||
      ["todo", "in_progress", "in_review", "blocked"].includes(w.status);

    if (isOpenStatus) {
      if (key) protectedKeys.add(key);
      if (id) protectedIds.add(id);
    }
  }

  // Pass 2: evaluate closed tasks.
  // Rule: A task is eligible for retention ONLY IF:
  // 1. Not in protectedKeys or protectedIds.
  // 2. Confirmed closed (state closing/closed, or status done/cancelled/closed, or in closedKeysSet/closedIdsSet).
  // 3. Has an authoritative closure timestamp strictly before cutoffMs (< cutoffMs).
  const selectedKeys = new Set();
  const selectedIds = new Set();

  for (const w of rawWorkspaces) {
    if (!w || typeof w !== "object") continue;
    const key = w.key ? String(w.key) : null;
    const id = w.id ? String(w.id) : null;

    if ((key && protectedKeys.has(key)) || (id && protectedIds.has(id))) {
      continue;
    }

    const isClosed =
      w.state === "closing" ||
      w.state === "closed" ||
      ["done", "cancelled", "closed"].includes(w.status) ||
      (key && closedKeysSet.has(key)) ||
      (id && closedIdsSet.has(id));

    if (!isClosed) continue;

    const timeVal = w.since || w.closedAt || w.completedAt || w.cancelledAt || w.updatedAt;
    if (!timeVal) continue;

    const closedMs = new Date(timeVal).getTime();
    if (isNaN(closedMs) || closedMs >= cutoffMs) continue;

    if (key) selectedKeys.add(key);
    if (id) selectedIds.add(id);
  }

  // For candidate closed keys not in rawWorkspaces, verify against optional taskTimestamps
  if (opts.taskTimestamps && typeof opts.taskTimestamps === "object") {
    for (const [key, ts] of Object.entries(opts.taskTimestamps)) {
      if (protectedKeys.has(key) || protectedIds.has(key)) continue;
      if (closedKeysSet.has(key) || closedIdsSet.has(key)) {
        const closedMs = new Date(ts).getTime();
        if (!isNaN(closedMs) && closedMs < cutoffMs) {
          selectedKeys.add(key);
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
 * Runs SQLite VACUUM after pruning.
 *
 * @param {object} options
 * @param {string} [options.stateDbPath]
 * @param {object} [options.desiredState]
 * @param {Array} [options.workspaces]
 * @param {Array} [options.protectKeys]
 * @param {Array} [options.closedKeys]
 * @param {number} [options.retentionDays=7]
 * @param {Date|number} [options.now]
 * @param {Function} [options.log]
 * @returns {{ prunedCount: number, vacuumed: boolean, error?: string }}
 */
export function pruneHermesClosedTaskSessions(options = {}) {
  const {
    stateDbPath = process.env.HERMES_STATE_DB || "/data/hermes/state.db",
    desiredState,
    workspaces,
    protectKeys,
    closedKeys,
    retentionDays = 7,
    now = Date.now(),
    log = () => {},
  } = options;

  if (!fs.existsSync(stateDbPath)) {
    return { prunedCount: 0, vacuumed: false, error: "database_not_found" };
  }

  const nowMs = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now();
  const cutoffSec = Math.floor((nowMs - retentionDays * 86_400_000) / 1000);

  // Derive selection strictly through selectClosedTasksForRetention with full options
  const selection = selectClosedTasksForRetention(desiredState || workspaces || options, {
    ...options,
    workspaces: workspaces || (desiredState && desiredState.workspaces) || options.workspaces,
    protectKeys: protectKeys || (desiredState && desiredState.protectKeys) || options.protectKeys,
    closedKeys: closedKeys || (desiredState && desiredState.closedKeys) || options.closedKeys,
    retentionDays,
    now: nowMs,
  });

  const closedTaskIds = new Set(selection.closedTaskIds);
  const closedTaskKeys = new Set(selection.closedTaskKeys);
  const protectedKeys = new Set(selection.protectedKeys);
  const protectedIds = new Set(selection.protectedIds);

  if (closedTaskIds.size === 0 && closedTaskKeys.size === 0) {
    return { prunedCount: 0, vacuumed: false, eligibleTasks: 0 };
  }

  let db;
  try {
    db = new DatabaseSync(stateDbPath);
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

    const isProtectedSession = (session) => {
      for (const key of protectedKeys) {
        if (session.name && session.name.includes(key)) return true;
        if (session.session_key && session.session_key.includes(key)) return true;
      }
      for (const id of protectedIds) {
        if (session.session_key && session.session_key.includes(id)) return true;
        if (session.name && session.name.includes(id)) return true;
      }
      return false;
    };

    const matchesClosedTask = (session) => {
      for (const key of closedTaskKeys) {
        if (session.name && session.name.includes(key)) return true;
        if (session.session_key && session.session_key.includes(key)) return true;
      }
      for (const id of closedTaskIds) {
        if (session.session_key && session.session_key.includes(id)) return true;
        if (session.name && session.name.includes(id)) return true;
      }
      return false;
    };

    for (const session of allSessions) {
      if (isProtectedSession(session)) {
        continue;
      }
      if (!matchesClosedTask(session)) {
        continue;
      }

      // Safety check: verify session was not active/touched within retention window
      const sessTime = session.last_activity_at || session.ended_at || session.started_at;
      if (typeof sessTime === "number" && sessTime > cutoffSec) {
        continue;
      }

      sessionsToDelete.set(session.id, session);
    }

    // Cascade: include any subagent/child sessions (parent_session_id)
    let addedChild = true;
    while (addedChild) {
      addedChild = false;
      for (const session of allSessions) {
        if (
          session.parent_session_id &&
          sessionsToDelete.has(session.parent_session_id) &&
          !sessionsToDelete.has(session.id)
        ) {
          if (!isProtectedSession(session)) {
            sessionsToDelete.set(session.id, session);
            addedChild = true;
          }
        }
      }
    }

    if (sessionsToDelete.size === 0) {
      db.close();
      return { prunedCount: 0, vacuumed: false };
    }

    // Cascade deletion through related Hermes tables
    db.exec("BEGIN TRANSACTION;");
    try {
      const deleteMessages = existingTables.has("messages")
        ? db.prepare("DELETE FROM messages WHERE session_id = ?")
        : null;
      const deleteUsage = existingTables.has("session_model_usage")
        ? db.prepare("DELETE FROM session_model_usage WHERE session_id = ?")
        : null;
      const deleteLocks = existingTables.has("compression_locks")
        ? db.prepare("DELETE FROM compression_locks WHERE session_id = ?")
        : null;
      const deleteLeases = existingTables.has("session_turn_leases")
        ? db.prepare("DELETE FROM session_turn_leases WHERE conversation_id = ? OR conversation_id = ?")
        : null;
      const deleteObligations = existingTables.has("delivery_obligations")
        ? db.prepare("DELETE FROM delivery_obligations WHERE session_key = ? OR session_key = ?")
        : null;
      const deleteGenerations = existingTables.has("conversation_generations")
        ? db.prepare("DELETE FROM conversation_generations WHERE session_key = ? OR session_key = ?")
        : null;
      const deleteDelegations = existingTables.has("async_delegations")
        ? db.prepare("DELETE FROM async_delegations WHERE origin_session = ? OR parent_session_id = ?")
        : null;
      const deleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");

      // First, nullify parent_session_id references to prevent self-referential FK constraint failures
      for (const sessId of sessionsToDelete.keys()) {
        try {
          db.prepare("UPDATE sessions SET parent_session_id = NULL WHERE id = ? OR parent_session_id = ?").run(sessId, sessId);
        } catch {}
      }

      for (const [sessId, session] of sessionsToDelete.entries()) {
        const sessKey = session.session_key ?? sessId;
        if (deleteMessages) {
          try { deleteMessages.run(sessId); } catch {}
        }
        if (deleteUsage) {
          try { deleteUsage.run(sessId); } catch {}
        }
        if (deleteLocks) {
          try { deleteLocks.run(sessId); } catch {}
        }
        if (deleteLeases) {
          try { deleteLeases.run(sessId, sessKey); } catch {}
        }
        if (deleteObligations) {
          try { deleteObligations.run(sessKey, sessId); } catch {}
        }
        if (deleteGenerations) {
          try { deleteGenerations.run(sessKey, sessId); } catch {}
        }
        if (deleteDelegations) {
          try { deleteDelegations.run(sessId, sessId); } catch {}
        }
        deleteSession.run(sessId);
      }

      db.exec("COMMIT;");
    } catch (err) {
      try { db.exec("ROLLBACK;"); } catch {}
      db.close();
      log(`hermes-retention: transaction failed: ${err.message}`);
      throw err;
    }

    const prunedCount = sessionsToDelete.size;
    log(`hermes-retention: pruned ${prunedCount} sessions of closed tasks older than ${retentionDays}d, running VACUUM...`);
    db.exec("VACUUM;");
    db.close();
    return { prunedCount, vacuumed: true };
  } catch (err) {
    try { db.close(); } catch {}
    throw err;
  }
}

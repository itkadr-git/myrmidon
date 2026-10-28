// myrmidon: Hermes session retention & vacuum when idle (OPE-9673).
// Only removes sessions corresponding to CLOSED Paperclip tasks older than retentionDays (default 7 days).
// Active and open task sessions are strictly preserved.
// Performs SQLite VACUUM when sessions are pruned and the bot is idle.

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Selects closed tasks/workspaces eligible for retention (> retentionDays).
 * Validates against protectKeys and active workspaces so open tasks are never selected.
 * @param {Array<object>|object} input Array of workspaces or desiredState object ({ workspaces, protectKeys, closedKeys })
 * @param {object} [options]
 * @param {number} [options.retentionDays=7] Retention threshold in days
 * @param {number|Date} [options.now=Date.now()] Reference timestamp
 * @returns {{ closedTaskKeys: Set<string>, closedTaskIds: Set<string>, protectedKeys: Set<string>, protectedIds: Set<string> }}
 */
export function selectClosedTasksForRetention(input, options = {}) {
  let workspaces = [];
  const protectedKeys = new Set();
  const protectedIds = new Set();
  const closedKeysSet = new Set();

  if (Array.isArray(input)) {
    workspaces = input;
  } else if (input && typeof input === "object") {
    workspaces = Array.isArray(input.workspaces) ? input.workspaces : [];
    if (Array.isArray(input.protectKeys)) {
      for (const k of input.protectKeys) if (k) protectedKeys.add(String(k));
    }
    if (Array.isArray(input.closedKeys)) {
      for (const k of input.closedKeys) if (k) closedKeysSet.add(String(k));
    }
  }

  const retentionDays = Number(options.retentionDays ?? 7);
  const nowMs = options.now instanceof Date
    ? options.now.getTime()
    : typeof options.now === "number"
      ? options.now
      : Date.now();
  const cutoffMs = nowMs - retentionDays * 86_400_000;

  const closedTaskKeys = new Set();
  const closedTaskIds = new Set();

  // First pass: register all active/open workspaces as protected
  for (const ws of workspaces) {
    if (!ws || typeof ws !== "object") continue;
    const isActive =
      ws.state === "active" ||
      ["todo", "in_progress", "in_review", "blocked"].includes(ws.status);
    if (isActive) {
      if (ws.key) protectedKeys.add(String(ws.key));
      if (ws.id) protectedIds.add(String(ws.id));
      if (ws.issueId) protectedIds.add(String(ws.issueId));
    }
  }

  // Second pass: identify tasks confirmed closed and older than cutoff
  for (const ws of workspaces) {
    if (!ws || typeof ws !== "object") continue;
    const key = ws.key ? String(ws.key) : undefined;
    const id = ws.id || ws.issueId ? String(ws.id || ws.issueId) : undefined;

    // Never select protected tasks
    if (key && protectedKeys.has(key)) continue;
    if (id && protectedIds.has(id)) continue;

    const isClosing = ws.state === "closing" || ws.state === "closed";
    const isClosedStatus = ["done", "cancelled", "closed"].includes(ws.status);
    const isConfirmedClosed = key && closedKeysSet.has(key);

    if (!isClosing && !isClosedStatus && !isConfirmedClosed) {
      continue;
    }

    // Authoritative closed-at timestamp: `since` from desiredState reflects when task became closing/terminal
    const closedTime = Date.parse(ws.since || ws.closedAt || ws.completedAt || ws.cancelledAt || ws.updatedAt || 0);
    if (Number.isFinite(closedTime) && closedTime > 0 && closedTime < cutoffMs) {
      if (key) closedTaskKeys.add(key);
      if (id) closedTaskIds.add(id);
    }
  }

  return { closedTaskKeys, closedTaskIds, protectedKeys, protectedIds };
}

/**
 * Prunes Hermes sessions for closed tasks older than retentionDays.
 * Cascades through messages, session_model_usage, turn leases, compression locks, obligations,
 * child sessions, and runs VACUUM.
 * @param {object} options
 * @param {string} [options.stateDbPath] Path to state.db (defaults to /data/hermes/state.db)
 * @param {Array<object>|object} [options.desiredState] Desired state object from botd poll
 * @param {Array<object>} [options.workspaces] Workspaces array
 * @param {Set<string>|Array<string>} [options.closedTaskIds] Closed task issue UUIDs
 * @param {Set<string>|Array<string>} [options.closedTaskKeys] Closed task keys (e.g. ["OPE-1234"])
 * @param {Set<string>|Array<string>} [options.protectKeys] Keys of open tasks to protect
 * @param {number} [options.retentionDays=7] Retention threshold in days
 * @param {number|Date} [options.now=Date.now()] Reference timestamp
 * @param {Function} [options.log] Logger function
 * @returns {{prunedCount: number, vacuumed: boolean}}
 */
export function pruneHermesClosedTaskSessions(options = {}) {
  const {
    stateDbPath = process.env.HERMES_STATE_DB || "/data/hermes/state.db",
    desiredState,
    workspaces,
    retentionDays = 7,
    now = Date.now(),
    log = () => {},
  } = options;

  const nowMs = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now();
  const input = desiredState || workspaces || options;
  const selection = selectClosedTasksForRetention(input, { retentionDays, now: nowMs });

  const closedTaskIds = new Set(selection.closedTaskIds);
  const closedTaskKeys = new Set(selection.closedTaskKeys);
  const protectedKeys = new Set(selection.protectedKeys);
  const protectedIds = new Set(selection.protectedIds);

  if (Array.isArray(options.closedTaskIds) || options.closedTaskIds instanceof Set) {
    for (const id of options.closedTaskIds) if (id) closedTaskIds.add(String(id));
  }
  if (Array.isArray(options.closedTaskKeys) || options.closedTaskKeys instanceof Set) {
    for (const key of options.closedTaskKeys) if (key) closedTaskKeys.add(String(key));
  }
  if (Array.isArray(options.protectKeys) || options.protectKeys instanceof Set) {
    for (const p of options.protectKeys) if (p) protectedKeys.add(String(p));
  }

  // Remove any protected keys/ids from closed selection
  for (const p of protectedKeys) closedTaskKeys.delete(p);
  for (const p of protectedIds) closedTaskIds.delete(p);

  if (!stateDbPath || !fs.existsSync(stateDbPath)) {
    return { prunedCount: 0, vacuumed: false };
  }

  const ids = Array.from(closedTaskIds).filter(Boolean);
  const keys = Array.from(closedTaskKeys).filter(Boolean);

  if (ids.length === 0 && keys.length === 0) {
    return { prunedCount: 0, vacuumed: false };
  }

  let db;
  try {
    db = new DatabaseSync(stateDbPath);
  } catch (err) {
    log(`hermes-retention: failed to open state.db: ${err.message}`);
    return { prunedCount: 0, vacuumed: false };
  }

  try {
    const existingTables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
    );

    if (!existingTables.has("sessions")) {
      db.close();
      return { prunedCount: 0, vacuumed: false };
    }

    const sessionCols = new Set(
      db.prepare("PRAGMA table_info(sessions)").all().map((r) => r.name),
    );

    const selectCols = ["id"];
    if (sessionCols.has("session_key")) selectCols.push("session_key");
    if (sessionCols.has("title")) selectCols.push("title");
    if (sessionCols.has("started_at")) selectCols.push("started_at");
    if (sessionCols.has("ended_at")) selectCols.push("ended_at");
    if (sessionCols.has("last_activity_at")) selectCols.push("last_activity_at");
    if (sessionCols.has("parent_session_id")) selectCols.push("parent_session_id");

    const allSessions = db.prepare(`SELECT ${selectCols.join(", ")} FROM sessions`).all();

    const isProtectedSession = (session) => {
      for (const pKey of protectedKeys) {
        if (!pKey) continue;
        if (session.id && (session.id === pKey || session.id.includes(`:${pKey}`))) return true;
        if (session.session_key && (session.session_key === pKey || session.session_key.includes(`:${pKey}`))) return true;
        if (session.title && (session.title.startsWith(`${pKey} `) || session.title === pKey || session.title.includes(` ${pKey} `))) return true;
      }
      for (const pId of protectedIds) {
        if (!pId) continue;
        if (session.id && (session.id === pId || session.id.includes(`:issue:${pId}`))) return true;
        if (session.session_key && (session.session_key === pId || session.session_key.includes(`:issue:${pId}`))) return true;
      }
      return false;
    };

    const matchesClosedTask = (session) => {
      for (const id of ids) {
        if (session.id === id || (session.id && session.id.includes(`:issue:${id}`))) return true;
        if (session.session_key && session.session_key.includes(`:issue:${id}`)) return true;
      }
      for (const key of keys) {
        if (session.id && (session.id === key || session.id.includes(`:${key}`))) return true;
        if (session.session_key && (session.session_key === key || session.session_key.includes(`:${key}`))) return true;
        if (session.title && (session.title.startsWith(`${key} `) || session.title === key || session.title.includes(` ${key} `))) return true;
      }
      return false;
    };

    const cutoffSec = (nowMs - retentionDays * 86_400_000) / 1000;
    const sessionsToDelete = new Map();

    for (const session of allSessions) {
      if (isProtectedSession(session)) continue;
      if (!matchesClosedTask(session)) continue;

      // Verify session activity is also older than retention threshold
      const sessTime = session.last_activity_at || session.ended_at || session.started_at;
      if (typeof sessTime === "number" && sessTime > cutoffSec) {
        // Active within retention window, do not prune
        continue;
      }

      sessionsToDelete.set(session.id, session);
    }

    // Include child/subagent sessions of pruned parent sessions
    if (sessionCols.has("parent_session_id")) {
      for (const session of allSessions) {
        if (session.parent_session_id && sessionsToDelete.has(session.parent_session_id)) {
          if (!isProtectedSession(session)) {
            sessionsToDelete.set(session.id, session);
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
        ? db.prepare("DELETE FROM async_delegations WHERE origin_session_id = ? OR parent_session_id = ?")
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

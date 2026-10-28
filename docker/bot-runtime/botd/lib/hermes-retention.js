// myrmidon: Hermes session retention & vacuum when idle (OPE-9673).
// Only removes sessions corresponding to CLOSED Paperclip tasks older than retentionDays (default 7 days).
// Active and open task sessions are preserved.
// Performs SQLite VACUUM when sessions are pruned and the bot is idle.

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Selects closed tasks/workspaces eligible for retention (> retentionDays).
 * @param {Array<object>} workspaces Array of workspace objects from botd desired state or task inventory
 * @param {object} [options]
 * @param {number} [options.retentionDays=7] Retention threshold in days
 * @param {number} [options.now=Date.now()] Reference timestamp (ms)
 * @returns {{ closedTaskKeys: Set<string>, closedTaskIds: Set<string> }}
 */
export function selectClosedTasksForRetention(workspaces = [], options = {}) {
  const { retentionDays = 7, now = Date.now() } = options;
  const cutoff = now - retentionDays * 86_400_000;
  const closedTaskKeys = new Set();
  const closedTaskIds = new Set();

  if (!Array.isArray(workspaces)) {
    return { closedTaskKeys, closedTaskIds };
  }

  for (const ws of workspaces) {
    if (!ws) continue;
    // Closed state: workspace state is "closing", or issue status is "done"/"cancelled"/"closed"
    const isClosed =
      ws.state === "closing" ||
      ws.state === "closed" ||
      ["done", "cancelled", "closed"].includes(ws.status);

    if (!isClosed) continue;

    // Timestamp when task was closed / marked closing
    const closedTime = Date.parse(ws.since || ws.closedAt || ws.updatedAt || 0);
    if (Number.isFinite(closedTime) && closedTime > 0 && closedTime < cutoff) {
      if (ws.key) closedTaskKeys.add(ws.key);
      if (ws.id || ws.issueId) closedTaskIds.add(ws.id || ws.issueId);
    }
  }

  return { closedTaskKeys, closedTaskIds };
}

/**
 * Prunes Hermes sessions for closed tasks older than retentionDays.
 * @param {object} options
 * @param {string} [options.stateDbPath] Path to state.db (defaults to /data/hermes/state.db)
 * @param {Array<object>} [options.workspaces] Workspaces array to filter via selectClosedTasksForRetention
 * @param {Set<string>|Array<string>} [options.closedTaskIds] Closed task issue UUIDs
 * @param {Set<string>|Array<string>} [options.closedTaskKeys] Closed task keys (e.g. ["OPE-1234"])
 * @param {number} [options.retentionDays=7] Retention threshold in days
 * @param {number} [options.now=Date.now()] Reference timestamp (ms)
 * @param {Function} [options.log] Logger function
 * @returns {{prunedCount: number, vacuumed: boolean}}
 */
export function pruneHermesClosedTaskSessions(options = {}) {
  const {
    stateDbPath = process.env.HERMES_STATE_DB || "/data/hermes/state.db",
    workspaces,
    retentionDays = 7,
    now = Date.now(),
    log = () => {},
  } = options;

  let closedTaskIds = new Set(options.closedTaskIds || []);
  let closedTaskKeys = new Set(options.closedTaskKeys || []);

  if (Array.isArray(workspaces)) {
    const selected = selectClosedTasksForRetention(workspaces, { retentionDays, now });
    for (const id of selected.closedTaskIds) closedTaskIds.add(id);
    for (const key of selected.closedTaskKeys) closedTaskKeys.add(key);
  }

  if (!stateDbPath || !fs.existsSync(stateDbPath)) {
    return { prunedCount: 0, vacuumed: false };
  }

  const ids = Array.from(closedTaskIds).filter(Boolean);
  const keys = Array.from(closedTaskKeys).filter(Boolean);

  if (ids.length === 0 && keys.length === 0) {
    return { prunedCount: 0, vacuumed: false };
  }

  const db = new DatabaseSync(stateDbPath);
  let prunedCount = 0;

  try {
    const findByIdStmt = db.prepare(`
      SELECT id, started_at, ended_at, last_activity_at FROM sessions
      WHERE session_key LIKE ? OR id LIKE ?
    `);

    const findByKeyStmt = db.prepare(`
      SELECT id, started_at, ended_at, last_activity_at FROM sessions
      WHERE title LIKE ? OR session_key LIKE ?
    `);

    const deleteMessagesStmt = db.prepare(`
      DELETE FROM messages WHERE session_id = ?
    `);

    const deleteModelUsageStmt = db.prepare(`
      DELETE FROM session_model_usage WHERE session_id = ?
    `);

    const deleteSessionStmt = db.prepare(`
      DELETE FROM sessions WHERE id = ?
    `);

    const sessionsToDelete = new Set();
    const cutoffSec = (now - retentionDays * 86_400_000) / 1000;

    const checkAndAdd = (row) => {
      // If session has timestamp, verify it is also older than cutoffSec or ended
      const sessTime = row.ended_at || row.last_activity_at || row.started_at;
      if (sessTime && sessTime > cutoffSec + 86400) {
        // Session had activity well after cutoff; skip to protect recent work
        return;
      }
      sessionsToDelete.add(row.id);
    };

    for (const issueId of ids) {
      const pattern = `%${issueId}%`;
      const matches = findByIdStmt.all(pattern, pattern);
      for (const m of matches) {
        checkAndAdd(m);
      }
    }

    for (const key of keys) {
      const titlePattern = `${key}%`;
      const keyPattern = `%:${key}%`;
      const matches = findByKeyStmt.all(titlePattern, keyPattern);
      for (const m of matches) {
        checkAndAdd(m);
      }
    }

    for (const sessId of sessionsToDelete) {
      try {
        deleteMessagesStmt.run(sessId);
      } catch {}
      try {
        deleteModelUsageStmt.run(sessId);
      } catch {}
      deleteSessionStmt.run(sessId);
      prunedCount += 1;
    }

    let vacuumed = false;
    if (prunedCount > 0) {
      log(`hermes-retention: pruned ${prunedCount} sessions of closed tasks older than ${retentionDays}d, running VACUUM...`);
      db.exec("VACUUM;");
      vacuumed = true;
    }

    return { prunedCount, vacuumed };
  } finally {
    db.close();
  }
}

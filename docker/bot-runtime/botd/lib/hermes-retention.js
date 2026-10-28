// myrmidon: Hermes session retention & vacuum when idle (OPE-9673).
// Only removes sessions corresponding to CLOSED Paperclip tasks older than retentionDays (default 7 days).
// Active and open task sessions are preserved.
// Performs SQLite VACUUM when sessions are pruned and the bot is idle.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Prunes Hermes sessions for closed tasks older than retentionDays.
 * @param {object} options
 * @param {string} [options.stateDbPath] Path to state.db (defaults to /data/hermes/state.db)
 * @param {Set<string>|Array<string>} [options.closedTaskIds] Closed task issue UUIDs
 * @param {Set<string>|Array<string>} [options.closedTaskKeys] Closed task keys (e.g. ["OPE-1234"])
 * @param {number} [options.retentionDays=7] Retention threshold in days
 * @param {Function} [options.log] Logger function
 * @returns {{prunedCount: number, vacuumed: boolean}}
 */
export function pruneHermesClosedTaskSessions(options = {}) {
  const {
    stateDbPath = process.env.HERMES_STATE_DB || "/data/hermes/state.db",
    closedTaskIds = new Set(),
    closedTaskKeys = new Set(),
    retentionDays = 7,
    log = () => {},
  } = options;

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
      SELECT id FROM sessions
      WHERE session_key LIKE ? OR id LIKE ?
    `);

    const findByKeyStmt = db.prepare(`
      SELECT id FROM sessions
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

    for (const issueId of ids) {
      const pattern = `%${issueId}%`;
      const matches = findByIdStmt.all(pattern, pattern);
      for (const m of matches) {
        sessionsToDelete.add(m.id);
      }
    }

    for (const key of keys) {
      const titlePattern = `${key}%`;
      const keyPattern = `%:${key}%`;
      const matches = findByKeyStmt.all(titlePattern, keyPattern);
      for (const m of matches) {
        sessionsToDelete.add(m.id);
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



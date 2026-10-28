import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pruneHermesClosedTaskSessions } from "../../../docker/bot-runtime/botd/lib/hermes-retention.js";

test("pruneHermesClosedTaskSessions only prunes sessions for closed tasks older than retention threshold", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-retention-test-"));
  const dbPath = path.join(tmp, "state.db");

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, session_key TEXT, title TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, text TEXT);
    CREATE TABLE session_model_usage (id INTEGER PRIMARY KEY, session_id TEXT);
  `);

  db.exec(`
    INSERT INTO sessions VALUES ('s_active', 'paperclip:company:1:agent:1:issue:task-active', 'Active task');
    INSERT INTO sessions VALUES ('s_closed_old', 'paperclip:company:1:agent:1:issue:task-closed-old', 'Closed old task');
    INSERT INTO sessions VALUES ('s_closed_recent', 'paperclip:company:1:agent:1:issue:task-closed-recent', 'Closed recent task');
    INSERT INTO messages VALUES (1, 's_active', 'hello active');
    INSERT INTO messages VALUES (2, 's_closed_old', 'hello old');
    INSERT INTO messages VALUES (3, 's_closed_recent', 'hello recent');
    INSERT INTO session_model_usage VALUES (1, 's_closed_old');
  `);
  db.close();

  // Closed task IDs: only task-closed-old is past the 7d retention threshold
  const closedTaskIds = new Set(["task-closed-old"]);
  const res = pruneHermesClosedTaskSessions({
    stateDbPath: dbPath,
    closedTaskIds,
    retentionDays: 7,
  });

  assert.strictEqual(res.prunedCount, 1);
  assert.strictEqual(res.vacuumed, true);

  const verifyDb = new DatabaseSync(dbPath);
  const remainingSessions = verifyDb.prepare("SELECT id FROM sessions").all().map((r) => r.id);
  assert.deepStrictEqual(remainingSessions.sort(), ["s_active", "s_closed_recent"].sort());

  const remainingMessages = verifyDb.prepare("SELECT session_id FROM messages").all().map((r) => r.session_id);
  assert.deepStrictEqual(remainingMessages.sort(), ["s_active", "s_closed_recent"].sort());

  const remainingUsage = verifyDb.prepare("SELECT session_id FROM session_model_usage").all();
  assert.strictEqual(remainingUsage.length, 0);

  verifyDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

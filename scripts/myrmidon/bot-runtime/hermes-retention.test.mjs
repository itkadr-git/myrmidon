import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  extractIssueIdFromSession,
  selectClosedTasksForRetention,
  pruneHermesClosedTaskSessions,
} from "../../../docker/bot-runtime/botd/lib/hermes-retention.js";

// Real DDL from Hermes state.db (no `name` column!)
const REAL_HERMES_SESSIONS_DDL = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    user_id TEXT,
    session_key TEXT,
    chat_id TEXT,
    chat_type TEXT,
    thread_id TEXT,
    display_name TEXT,
    origin_json TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    last_activity_at REAL,
    message_count INTEGER DEFAULT 0
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT
  );
  CREATE TABLE session_model_usage (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    total_tokens INTEGER DEFAULT 0
  );
  CREATE TABLE session_turn_leases (
    conversation_id TEXT PRIMARY KEY
  );
  CREATE TABLE compression_locks (
    session_id TEXT PRIMARY KEY
  );
  CREATE TABLE delivery_obligations (
    id TEXT PRIMARY KEY,
    session_key TEXT
  );
  CREATE TABLE conversation_generations (
    source TEXT,
    session_key TEXT,
    generation INTEGER
  );
  CREATE TABLE async_delegations (
    origin_session TEXT,
    parent_session_id TEXT
  );
`;

test("extractIssueIdFromSession extracts UUID from session_key and session.id", () => {
  const s1 = {
    session_key: "paperclip:company:2870b911-483a-4091-9f15-183841811143:agent:88481fab-78df-4480-a6fd-8ecae695993b:issue:9187047e-454d-4bba-93d5-b6c2c39601af",
  };
  assert.strictEqual(extractIssueIdFromSession(s1), "9187047e-454d-4bba-93d5-b6c2c39601af");

  const s2 = {
    id: "paperclip:company:c1:agent:a1:issue:5301f0d3-2d40-4a3c-a7a8-0f01f17f6b01:g2",
  };
  assert.strictEqual(extractIssueIdFromSession(s2), "5301f0d3-2d40-4a3c-a7a8-0f01f17f6b01");

  const sCron = {
    session_key: "cronjob:run:daily-clean",
  };
  assert.strictEqual(extractIssueIdFromSession(sCron), null);
});

test("selectClosedTasksForRetention with real C3 contract (workspaces with id, closedKeys with closedAt and issueId)", () => {
  const now = new Date("2026-10-28T12:00:00Z").getTime();

  const idActive = "11111111-1111-4111-8111-111111111111";
  const idRecent = "22222222-2222-4222-8222-222222222222";
  const idOldClosed = "33333333-3333-4333-8333-333333333333";
  const idClosedKeysOld = "44444444-4444-4444-8444-444444444444";
  const idClosedKeysRecent = "55555555-5555-4555-8555-555555555555";
  const idProtected = "66666666-6666-4666-8666-666666666666";

  const desiredState = {
    generatedAt: new Date(now).toISOString(),
    pressure: { level: "none", partitionPercent: 50, quotaPercent: null },
    workspaces: [
      {
        key: "OPE-12",
        id: idActive,
        state: "active",
        since: new Date(now - 20 * 86_400_000).toISOString(), // active open task
      },
      {
        key: "OPE-123",
        id: idRecent,
        state: "closing",
        since: new Date(now - 2 * 86_400_000).toISOString(), // closed only 2 days ago (< 7d)
      },
      {
        key: "OPE-1234",
        id: idOldClosed,
        state: "closing",
        since: new Date(now - 12 * 86_400_000).toISOString(), // closed 12 days ago (> 7d)
      },
      {
        key: "OPE-PROT",
        id: idProtected,
        state: "closing",
        since: new Date(now - 30 * 86_400_000).toISOString(), // old, but listed in protectKeys
      },
    ],
    protectKeys: ["OPE-PROT"],
    closedKeys: [
      {
        key: "OPE-OLD-KEY",
        issueId: idClosedKeysOld,
        closedAt: new Date(now - 10 * 86_400_000).toISOString(), // closed 10 days ago (> 7d)
      },
      {
        key: "OPE-REC-KEY",
        issueId: idClosedKeysRecent,
        closedAt: new Date(now - 3 * 86_400_000).toISOString(), // closed 3 days ago (< 7d)
      },
      "OPE-STR-ONLY", // string only, no timestamp or issueId -> fail safe, not eligible
    ],
  };

  const selection = selectClosedTasksForRetention(desiredState, {
    workspaces: desiredState.workspaces,
    protectKeys: desiredState.protectKeys,
    closedKeys: desiredState.closedKeys,
    retentionDays: 7,
    now,
  });

  assert.ok(selection.closedTaskIds.includes(idOldClosed), "old closed task in workspaces selected");
  assert.ok(selection.closedTaskIds.includes(idClosedKeysOld), "old closed task in closedKeys selected");

  assert.ok(!selection.closedTaskIds.includes(idActive), "active task must NOT be selected");
  assert.ok(!selection.closedTaskIds.includes(idRecent), "recently closed task must NOT be selected");
  assert.ok(!selection.closedTaskIds.includes(idClosedKeysRecent), "recent closedKeys task must NOT be selected");
  assert.ok(!selection.closedTaskIds.includes(idProtected), "protected task must NOT be selected");

  assert.ok(selection.protectedIds.includes(idActive), "active task must be in protectedIds");
  assert.ok(selection.protectedIds.includes(idRecent), "recent task must be protected");
  assert.ok(selection.protectedIds.includes(idProtected), "protectKeys task must be protected");
});

test("pruneHermesClosedTaskSessions on real schema: exact UUID matching without substring pollution and safe idle VACUUM", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-real-test-"));
  const dbPath = path.join(tmp, "state.db");
  const db = new DatabaseSync(dbPath);

  db.exec(REAL_HERMES_SESSIONS_DDL);

  const now = new Date("2026-10-28T12:00:00Z").getTime();
  const secNow = Math.floor(now / 1000);

  // UUIDs
  const idOpe12 = "12121212-1212-4212-8212-121212121212";   // active OPE-12
  const idOpe123 = "12312312-1231-4123-8123-123123123123"; // closed >7d OPE-123
  const idRecent = "22222222-2222-4222-8222-222222222222"; // closed <7d
  const idStringTime = "33333333-3333-4333-8333-333333333333"; // closed >7d, session has string timestamp

  // Insert sessions
  db.exec(`
    INSERT INTO sessions (id, source, session_key, started_at, ended_at, last_activity_at) VALUES
      ('s_active', 'paperclip', 'paperclip:company:c1:agent:a1:issue:${idOpe12}', ${secNow - 864000}, NULL, ${secNow - 3600}),
      ('s_active_sub', 'paperclip', 'paperclip:company:c1:agent:a1:sub:active', ${secNow - 3600}, NULL, ${secNow - 3600}),
      ('s_recent', 'paperclip', 'paperclip:company:c1:agent:a1:issue:${idRecent}', ${secNow - 172800}, ${secNow - 172800}, ${secNow - 172800}),
      ('s_old', 'paperclip', 'paperclip:company:c1:agent:a1:issue:${idOpe123}', ${secNow - 864000}, ${secNow - 864000}, ${secNow - 864000}),
      ('s_old_sub', 'paperclip', 'paperclip:company:c1:agent:a1:sub:old', ${secNow - 864000}, ${secNow - 864000}, ${secNow - 864000}),
      ('s_str_time', 'paperclip', 'paperclip:company:c1:agent:a1:issue:${idStringTime}', ${secNow - 900000}, ${secNow - 900000}, ${secNow - 900000}),
      ('s_cron', 'cron', 'cronjob:daily', ${secNow - 900000}, NULL, ${secNow - 100});

    UPDATE sessions SET parent_session_id = 's_active' WHERE id = 's_active_sub';
    UPDATE sessions SET parent_session_id = 's_old' WHERE id = 's_old_sub';
  `);

  // Insert messages and related records
  db.exec(`
    INSERT INTO messages VALUES
      ('m1', 's_active', 'user', 'hello active'),
      ('m2', 's_old', 'user', 'hello old'),
      ('m3', 's_old_sub', 'user', 'hello old sub'),
      ('m4', 's_str_time', 'user', 'hello str time');
    INSERT INTO session_model_usage VALUES
      ('u1', 's_active', 10),
      ('u2', 's_old', 20),
      ('u3', 's_old_sub', 30);
    INSERT INTO delivery_obligations VALUES
      ('d1', 'paperclip:company:c1:agent:a1:issue:${idOpe12}'),
      ('d2', 'paperclip:company:c1:agent:a1:issue:${idOpe123}');
    INSERT INTO conversation_generations VALUES
      ('paperclip', 'paperclip:company:c1:agent:a1:issue:${idOpe123}', 1);
  `);
  db.close();

  const desiredState = {
    workspaces: [
      {
        key: "OPE-12",
        id: idOpe12,
        state: "active",
        since: new Date(now - 10 * 86_400_000).toISOString(),
      },
      {
        key: "OPE-123",
        id: idOpe123,
        state: "closing",
        since: new Date(now - 10 * 86_400_000).toISOString(),
      },
      {
        key: "OPE-REC",
        id: idRecent,
        state: "closing",
        since: new Date(now - 2 * 86_400_000).toISOString(),
      },
    ],
    closedKeys: [
      {
        key: "OPE-STR-TASK",
        issueId: idStringTime,
        closedAt: new Date(now - 10 * 86_400_000).toISOString(),
      },
    ],
  };

  // Test 1: prune with idle=false -> VACUUM must be skipped!
  const notIdleRes = pruneHermesClosedTaskSessions({
    stateDbPath: dbPath,
    desiredState,
    retentionDays: 7,
    idle: false,
    now,
  });
  assert.strictEqual(notIdleRes.prunedCount, 3, "prunes s_old, s_old_sub, s_str_time");
  assert.strictEqual(notIdleRes.vacuumed, false, "vacuum must NOT run when bot is not idle");
  assert.strictEqual(notIdleRes.skippedReason, "not_idle");

  // Check database contents
  const checkDb = new DatabaseSync(dbPath);
  const remainingIds = checkDb.prepare("SELECT id FROM sessions ORDER BY id").all().map((r) => r.id);
  assert.deepStrictEqual(
    remainingIds,
    ["s_active", "s_active_sub", "s_cron", "s_recent"],
    "s_active (OPE-12), s_active_sub, s_cron, and s_recent must remain untouched"
  );

  // Check cascading deletions
  const remainingMsgs = checkDb.prepare("SELECT id FROM messages").all().map((r) => r.id);
  assert.deepStrictEqual(remainingMsgs, ["m1"], "only active session message remains");

  const remainingObligations = checkDb.prepare("SELECT id FROM delivery_obligations").all().map((r) => r.id);
  assert.deepStrictEqual(remainingObligations, ["d1"], "only active delivery obligation remains");

  checkDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("pruneHermesClosedTaskSessions rolls back transaction if cascade delete fails", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-rollback-test-"));
  const dbPath = path.join(tmp, "state.db");
  const db = new DatabaseSync(dbPath);

  db.exec(REAL_HERMES_SESSIONS_DDL);

  const now = new Date("2026-10-28T12:00:00Z").getTime();
  const secNow = Math.floor(now / 1000);
  const idOld = "99999999-9999-4999-8999-999999999999";

  db.exec(`
    INSERT INTO sessions (id, source, session_key, started_at, ended_at, last_activity_at) VALUES
      ('s_fail', 'paperclip', 'paperclip:company:c1:agent:a1:issue:${idOld}', ${secNow - 864000}, ${secNow - 864000}, ${secNow - 864000});
  `);

  // Create a trigger that intentionally aborts on DELETE from messages to force a failure
  db.exec(`
    CREATE TRIGGER fail_on_message_delete
    BEFORE DELETE ON messages
    BEGIN
      SELECT RAISE(ABORT, 'intentional delete failure test');
    END;
  `);

  db.exec(`
    INSERT INTO messages VALUES ('m_fail', 's_fail', 'user', 'content');
  `);
  db.close();

  const desiredState = {
    workspaces: [
      {
        key: "OPE-FAIL",
        id: idOld,
        state: "closing",
        since: new Date(now - 10 * 86_400_000).toISOString(),
      },
    ],
  };

  assert.throws(() => {
    pruneHermesClosedTaskSessions({
      stateDbPath: dbPath,
      desiredState,
      retentionDays: 7,
      now,
    });
  }, /intentional delete failure test/);

  // Verify rollback: session and message must still exist!
  const checkDb = new DatabaseSync(dbPath);
  const sess = checkDb.prepare("SELECT id FROM sessions WHERE id = 's_fail'").all();
  assert.strictEqual(sess.length, 1, "session must NOT be deleted due to transaction rollback");
  checkDb.close();

  fs.rmSync(tmp, { recursive: true, force: true });
});

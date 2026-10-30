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
  CREATE TABLE sessions (\n    id TEXT PRIMARY KEY,\n    source TEXT NOT NULL,\n    user_id TEXT,\n    session_key TEXT,\n    chat_id TEXT,\n    chat_type TEXT,\n    thread_id TEXT,\n    display_name TEXT,\n    origin_json TEXT,\n    parent_session_id TEXT,\n    started_at REAL NOT NULL,\n    ended_at REAL,\n    last_activity_at REAL,\n    message_count INTEGER DEFAULT 0\n  );
  CREATE TABLE messages (\n    id TEXT PRIMARY KEY,\n    session_id TEXT NOT NULL,\n    role TEXT NOT NULL,\n    content TEXT\n  );
  CREATE TABLE session_model_usage (\n    id TEXT PRIMARY KEY,\n    session_id TEXT NOT NULL,\n    total_tokens INTEGER DEFAULT 0\n  );
  CREATE TABLE session_turn_leases (\n    conversation_id TEXT PRIMARY KEY\n  );
  CREATE TABLE compression_locks (\n    session_id TEXT PRIMARY KEY\n  );
  CREATE TABLE delivery_obligations (\n    id TEXT PRIMARY KEY,\n    session_key TEXT\n  );
  CREATE TABLE conversation_generations (\n    source TEXT,\n    session_key TEXT,\n    generation INTEGER\n  );
  CREATE TABLE async_delegations (\n    origin_session TEXT,\n    parent_session_id TEXT\n  );
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

test("selectClosedTasksForRetention: state='closing' is NOT closed (protects reassigned/hidden open tasks), only closedTasks with closedAt are eligible", () => {
  const now = new Date("2026-10-28T12:00:00Z").getTime();

  const idActive = "11111111-1111-4111-8111-111111111111";
  const idReassignedClosing = "22222222-2222-4222-8222-222222222222";
  const idOldClosed = "33333333-3333-4333-8333-333333333333";
  const idClosedTasksOld = "44444444-4444-4444-8444-444444444444";
  const idClosedTasksRecent = "55555555-5555-4555-8555-555555555555";
  const idProtected = "66666666-6666-4666-8666-666666666666";

  const desiredState = {
    generatedAt: new Date(now).toISOString(),
    pressure: { level: "none", partitionPercent: 50, quotaPercent: null },
    workspaces: [
      {
        key: "OPE-12",
        id: idActive,
        state: "active",
        since: new Date(now - 20 * 86_400_000).toISOString(),
      },
      {
        // Reassigned open task without activity for 10 days: state is 'closing', but task is NOT closed!
        key: "OPE-REASSIGNED",
        id: idReassignedClosing,
        state: "closing",
        since: new Date(now - 10 * 86_400_000).toISOString(),
      },
      {
        key: "OPE-1234",
        id: idOldClosed,
        status: "done",
        completedAt: new Date(now - 12 * 86_400_000).toISOString(),
      },
      {
        key: "OPE-PROT",
        id: idProtected,
        status: "done",
        completedAt: new Date(now - 30 * 86_400_000).toISOString(),
      },
    ],
    protectKeys: ["OPE-PROT"],
    closedKeys: ["OPE-1234", "OPE-OLD-KEY", "OPE-REC-KEY", "OPE-STR-ONLY"],
    closedTasks: [
      {
        key: "OPE-OLD-KEY",
        issueId: idClosedTasksOld,
        closedAt: new Date(now - 10 * 86_400_000).toISOString(),
      },
      {
        key: "OPE-REC-KEY",
        issueId: idClosedTasksRecent,
        closedAt: new Date(now - 3 * 86_400_000).toISOString(),
      },
      {
        key: "OPE-STR-ONLY", // string only / no timestamp -> fail safe
      },
    ],
  };

  const selection = selectClosedTasksForRetention(desiredState, {
    workspaces: desiredState.workspaces,
    protectKeys: desiredState.protectKeys,
    closedKeys: desiredState.closedKeys,
    closedTasks: desiredState.closedTasks,
    retentionDays: 7,
    now,
  });

  assert.ok(selection.closedTaskIds.includes(idOldClosed), "old closed task in workspaces selected");
  assert.ok(selection.closedTaskIds.includes(idClosedTasksOld), "old closed task in closedTasks selected");

  assert.ok(!selection.closedTaskIds.includes(idActive), "active task must NOT be selected");
  assert.ok(!selection.closedTaskIds.includes(idReassignedClosing), "reassigned closing task must NOT be selected");
  assert.ok(!selection.closedTaskIds.includes(idClosedTasksRecent), "recent closed task must NOT be selected");
  assert.ok(!selection.closedTaskIds.includes(idProtected), "protected task must NOT be selected");

  assert.ok(selection.protectedIds.includes(idActive), "active task must be in protectedIds");
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
      ('s_recent', 'paperclip', 'paperclip:company:c1:agent:a1:issue:${idRecent}', ${secNow - 172800}, ${secNow - 172800}, ${secNow - 172800}),
      ('s_old', 'paperclip', 'paperclip:company:c1:agent:a1:issue:${idOpe123}', ${secNow - 864000}, ${secNow - 864000}, ${secNow - 864000}),
      ('s_str_time', 'paperclip', 'paperclip:company:c1:agent:a1:issue:${idStringTime}', ${secNow - 900000}, ${secNow - 900000}, ${secNow - 900000}),
      ('s_cron', 'cron', 'cronjob:daily', ${secNow - 900000}, NULL, ${secNow - 100});
  `);

  // Insert messages and related records
  db.exec(`
    INSERT INTO messages VALUES
      ('m1', 's_active', 'user', 'hello active'),
      ('m2', 's_old', 'user', 'hello old'),
      ('m4', 's_str_time', 'user', 'hello str time');
    INSERT INTO session_model_usage VALUES
      ('u1', 's_active', 10),
      ('u2', 's_old', 20);
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
        key: "OPE-REC",
        id: idRecent,
        status: "done",
        completedAt: new Date(now - 2 * 86_400_000).toISOString(),
      },
    ],
    closedTasks: [
      {
        key: "OPE-123",
        issueId: idOpe123,
        closedAt: new Date(now - 10 * 86_400_000).toISOString(),
      },
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
  assert.strictEqual(notIdleRes.prunedCount, 2, "prunes s_old, s_str_time");
  assert.strictEqual(notIdleRes.vacuumed, false, "vacuum must NOT run when bot is not idle");
  assert.strictEqual(notIdleRes.skippedReason, "not_idle");

  // Check database contents
  const checkDb = new DatabaseSync(dbPath);
  const remainingIds = checkDb.prepare("SELECT id FROM sessions ORDER BY id").all().map((r) => r.id);
  assert.deepStrictEqual(
    remainingIds,
    ["s_active", "s_cron", "s_recent"],
    "s_active (OPE-12), s_cron, and s_recent must remain untouched"
  );

  // Check cascading deletions
  const remainingMsgs = checkDb.prepare("SELECT id FROM messages").all().map((r) => r.id);
  assert.deepStrictEqual(remainingMsgs, ["m1"], "only active session message remains");

  const remainingObligations = checkDb.prepare("SELECT id FROM delivery_obligations").all().map((r) => r.id);
  assert.deepStrictEqual(remainingObligations, ["d1"], "only active delivery obligation remains");

  checkDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("CRITICAL SAFETY: active/recent child session is preserved when old parent session is pruned", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-child-safety-test-"));
  const dbPath = path.join(tmp, "state.db");
  const db = new DatabaseSync(dbPath);

  db.exec(REAL_HERMES_SESSIONS_DDL);

  const now = new Date("2026-10-28T12:00:00Z").getTime();
  const secNow = Math.floor(now / 1000);

  const idOldTask = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const idActiveTask = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  // s_parent belongs to an old closed task (closed 15 days ago), last active 15 days ago
  // s_child_recent has parent_session_id = 's_parent', but was active 1 hour ago!
  // s_child_active_task has parent_session_id = 's_parent', but belongs to active open task idActiveTask!
  // s_child_old_stale has parent_session_id = 's_parent', belongs to idOldTask, and is 15 days stale -> this one CAN be deleted
  db.exec(`
    INSERT INTO sessions (id, source, session_key, parent_session_id, started_at, ended_at, last_activity_at) VALUES
      ('s_parent', 'paperclip', 'paperclip:company:c1:agent:a1:issue:${idOldTask}', NULL, ${secNow - 1296000}, ${secNow - 1296000}, ${secNow - 1296000}),
      ('s_child_recent', 'paperclip', 'paperclip:company:c1:agent:a1:issue:${idOldTask}', 's_parent', ${secNow - 3600}, NULL, ${secNow - 3600}),
      ('s_child_active_task', 'paperclip', 'paperclip:company:c1:agent:a1:issue:${idActiveTask}', 's_parent', ${secNow - 1296000}, ${secNow - 1296000}, ${secNow - 1296000}),
      ('s_child_old_stale', 'paperclip', 'paperclip:company:c1:agent:a1:issue:${idOldTask}', 's_parent', ${secNow - 1296000}, ${secNow - 1296000}, ${secNow - 1296000});

    INSERT INTO messages VALUES
      ('m_parent', 's_parent', 'user', 'parent message'),
      ('m_child_recent', 's_child_recent', 'user', 'active child message'),
      ('m_child_active_task', 's_child_active_task', 'user', 'active task child message'),
      ('m_child_stale', 's_child_old_stale', 'user', 'stale child message');
  `);
  db.close();

  const desiredState = {
    workspaces: [
      {
        key: "OPE-ACTIVE",
        id: idActiveTask,
        state: "active",
      },
    ],
    closedTasks: [
      {
        key: "OPE-OLD",
        issueId: idOldTask,
        closedAt: new Date(now - 15 * 86_400_000).toISOString(),
      },
    ],
  };

  const res = pruneHermesClosedTaskSessions({
    stateDbPath: dbPath,
    desiredState,
    retentionDays: 7,
    idle: true,
    now,
  });

  // Only s_parent and s_child_old_stale should be pruned (2 sessions)
  assert.strictEqual(res.prunedCount, 2, "only stale parent and stale child are pruned");

  const checkDb = new DatabaseSync(dbPath);
  const remainingSessions = checkDb.prepare("SELECT id, parent_session_id FROM sessions ORDER BY id").all();

  // s_child_recent and s_child_active_task MUST survive!
  assert.deepStrictEqual(
    remainingSessions.map((s) => s.id),
    ["s_child_active_task", "s_child_recent"],
    "recent child and active-task child MUST be preserved"
  );

  // Their parent_session_id should have been safely unparented to NULL
  for (const s of remainingSessions) {
    assert.strictEqual(s.parent_session_id, null, "surviving children are safely unparented");
  }

  // Their messages must remain intact
  const remainingMsgs = checkDb.prepare("SELECT id FROM messages ORDER BY id").all().map((m) => m.id);
  assert.deepStrictEqual(
    remainingMsgs,
    ["m_child_active_task", "m_child_recent"],
    "messages for surviving child sessions must be preserved"
  );

  checkDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("SAFE DELIVERY OBLIGATIONS: obligations preserved when surviving session shares session_key", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-obligations-test-"));
  const dbPath = path.join(tmp, "state.db");
  const db = new DatabaseSync(dbPath);

  db.exec(REAL_HERMES_SESSIONS_DDL);

  const now = new Date("2026-10-28T12:00:00Z").getTime();
  const secNow = Math.floor(now / 1000);
  const idOldTask = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const sharedKey = `paperclip:company:c1:agent:a1:issue:${idOldTask}`;

  // Two sessions share the same session_key: one old stale, one active/recent
  db.exec(`
    INSERT INTO sessions (id, source, session_key, started_at, ended_at, last_activity_at) VALUES
      ('s_stale_1', 'paperclip', '${sharedKey}', ${secNow - 1296000}, ${secNow - 1296000}, ${secNow - 1296000}),
      ('s_alive_2', 'paperclip', '${sharedKey}', ${secNow - 3600}, NULL, ${secNow - 3600});

    INSERT INTO delivery_obligations VALUES ('d_shared', '${sharedKey}');
    INSERT INTO conversation_generations VALUES ('paperclip', '${sharedKey}', 42);
  `);
  db.close();

  const desiredState = {
    closedTasks: [
      {
        key: "OPE-OLD-2",
        issueId: idOldTask,
        closedAt: new Date(now - 15 * 86_400_000).toISOString(),
      },
    ],
  };

  const res = pruneHermesClosedTaskSessions({
    stateDbPath: dbPath,
    desiredState,
    retentionDays: 7,
    idle: true,
    now,
  });

  assert.strictEqual(res.prunedCount, 1, "only s_stale_1 is pruned");

  const checkDb = new DatabaseSync(dbPath);
  const surviving = checkDb.prepare("SELECT id FROM sessions").all().map((s) => s.id);
  assert.deepStrictEqual(surviving, ["s_alive_2"]);

  // Because s_alive_2 shares sharedKey and is still present, delivery_obligations and conversation_generations must survive!
  const remainingObligations = checkDb.prepare("SELECT id FROM delivery_obligations").all();
  assert.strictEqual(remainingObligations.length, 1, "shared obligation must NOT be deleted");

  const remainingGen = checkDb.prepare("SELECT generation FROM conversation_generations").all();
  assert.strictEqual(remainingGen.length, 1, "shared generation must NOT be deleted");

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
    closedTasks: [
      {
        key: "OPE-FAIL",
        issueId: idOld,
        closedAt: new Date(now - 10 * 86_400_000).toISOString(),
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

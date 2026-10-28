import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  selectClosedTasksForRetention,
  pruneHermesClosedTaskSessions,
} from "../../../docker/bot-runtime/botd/lib/hermes-retention.js";

test("selectClosedTasksForRetention correctly handles desiredState payload, timestamps and protections", () => {
  const now = Date.now();
  const day = 86_400_000;

  const desiredState = {
    protectKeys: ["OPE-1001", "OPE-1005"],
    closedKeys: ["OPE-1002", "OPE-1003", "OPE-1004"],
    workspaces: [
      // 1. Active task (older than 7d, but in protectKeys & state: active -> MUST NOT BE SELECTED)
      {
        key: "OPE-1001",
        id: "uuid-1001",
        state: "active",
        status: "in_progress",
        since: new Date(now - 14 * day).toISOString(),
      },
      // 2. Recently closed task (closing 2 days ago -> MUST NOT BE SELECTED)
      {
        key: "OPE-1002",
        id: "uuid-1002",
        state: "closing",
        status: "done",
        since: new Date(now - 2 * day).toISOString(),
      },
      // 3. Old closed task (closing 10 days ago -> MUST BE SELECTED)
      {
        key: "OPE-1003",
        id: "uuid-1003",
        state: "closing",
        status: "done",
        since: new Date(now - 10 * day).toISOString(),
      },
      // 4. Old completed task with status done (closed 15 days ago -> MUST BE SELECTED)
      {
        key: "OPE-1004",
        id: "uuid-1004",
        state: "closing",
        status: "done",
        since: new Date(now - 15 * day).toISOString(),
      },
      // 5. Task marked closing, BUT present in protectKeys (board protection -> MUST NOT BE SELECTED)
      {
        key: "OPE-1005",
        id: "uuid-1005",
        state: "closing",
        status: "done",
        since: new Date(now - 20 * day).toISOString(),
      },
    ],
  };

  const selected = selectClosedTasksForRetention(desiredState, { retentionDays: 7, now });

  assert.deepStrictEqual(Array.from(selected.closedTaskKeys).sort(), ["OPE-1003", "OPE-1004"].sort());
  assert.deepStrictEqual(Array.from(selected.closedTaskIds).sort(), ["uuid-1003", "uuid-1004"].sort());
  assert.ok(!selected.closedTaskKeys.has("OPE-1001"), "active task must not be selected");
  assert.ok(!selected.closedTaskKeys.has("OPE-1002"), "recently closed task must not be selected");
  assert.ok(!selected.closedTaskKeys.has("OPE-1005"), "protected task must not be selected");
});

test("pruneHermesClosedTaskSessions behaviorally prunes only old closed sessions with full schema cascading", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-retention-test-"));
  const dbPath = path.join(tmp, "state.db");
  const now = Date.now();
  const nowSec = now / 1000;
  const daySec = 86400;

  const db = new DatabaseSync(dbPath);
  // Real Hermes state.db schema
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT,
      user_id TEXT,
      session_key TEXT,
      chat_id TEXT,
      chat_type TEXT,
      thread_id TEXT,
      display_name TEXT,
      origin_json TEXT,
      started_at REAL NOT NULL,
      ended_at REAL,
      last_activity_at REAL,
      title TEXT,
      parent_session_id TEXT REFERENCES sessions(id)
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT,
      content TEXT,
      timestamp REAL
    );
    CREATE TABLE session_model_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      model TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER
    );
    CREATE TABLE session_turn_leases (
      conversation_id TEXT PRIMARY KEY,
      holder TEXT,
      expires_at REAL
    );
    CREATE TABLE compression_locks (
      session_id TEXT PRIMARY KEY,
      acquired_at REAL
    );
    CREATE TABLE delivery_obligations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT,
      status TEXT
    );
    CREATE TABLE conversation_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT,
      prompt TEXT
    );
    CREATE TABLE async_delegations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin_session_id TEXT,
      parent_session_id TEXT,
      status TEXT
    );
  `);

  // Insert test sessions:
  // 1. Active task session (OPE-1001, uuid-active)
  db.exec(`
    INSERT INTO sessions VALUES (
      's_active',
      'paperclip', 'user1',
      'paperclip:company:c1:agent:a1:issue:uuid-active',
      NULL, NULL, NULL, NULL, NULL,
      ${nowSec - 14 * daySec}, NULL, ${nowSec},
      'OPE-1001 Active task', NULL
    );
    INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s_active', 'user', 'hello', ${nowSec});
    INSERT INTO session_model_usage (session_id, model, prompt_tokens, completion_tokens) VALUES ('s_active', 'gpt-4', 10, 20);
    INSERT INTO session_turn_leases VALUES ('s_active', 'holder1', ${nowSec + 60});
  `);

  // 2. Child subagent session of active task
  db.exec(`
    INSERT INTO sessions VALUES (
      's_active_sub',
      'paperclip', 'user1',
      'paperclip:company:c1:agent:a1:subagent:1',
      NULL, NULL, NULL, NULL, NULL,
      ${nowSec - 10 * daySec}, NULL, ${nowSec},
      'OPE-1001 subagent run', 's_active'
    );
    INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s_active_sub', 'assistant', 'sub task', ${nowSec});
  `);

  // 3. Recently closed task session (OPE-1002, closed 2 days ago)
  db.exec(`
    INSERT INTO sessions VALUES (
      's_recent',
      'paperclip', 'user1',
      'paperclip:company:c1:agent:a1:issue:uuid-recent',
      NULL, NULL, NULL, NULL, NULL,
      ${nowSec - 5 * daySec}, ${nowSec - 2 * daySec}, ${nowSec - 2 * daySec},
      'OPE-1002 Recent closed task', NULL
    );
    INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s_recent', 'user', 'done', ${nowSec - 2 * daySec});
    INSERT INTO session_model_usage (session_id, model, prompt_tokens, completion_tokens) VALUES ('s_recent', 'gpt-4', 5, 5);
  `);

  // 4. Old closed task session (OPE-1003, closed 10 days ago)
  db.exec(`
    INSERT INTO sessions VALUES (
      's_old',
      'paperclip', 'user1',
      'paperclip:company:c1:agent:a1:issue:uuid-old',
      NULL, NULL, NULL, NULL, NULL,
      ${nowSec - 12 * daySec}, ${nowSec - 10 * daySec}, ${nowSec - 10 * daySec},
      'OPE-1003 Old closed task', NULL
    );
    INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s_old', 'user', 'old message', ${nowSec - 10 * daySec});
    INSERT INTO session_model_usage (session_id, model, prompt_tokens, completion_tokens) VALUES ('s_old', 'gpt-4', 100, 200);
    INSERT INTO session_turn_leases VALUES ('s_old', 'holder2', ${nowSec - 10 * daySec});
    INSERT INTO compression_locks VALUES ('s_old', ${nowSec - 10 * daySec});
    INSERT INTO delivery_obligations (session_key, status) VALUES ('paperclip:company:c1:agent:a1:issue:uuid-old', 'delivered');
    INSERT INTO conversation_generations (session_key, prompt) VALUES ('paperclip:company:c1:agent:a1:issue:uuid-old', 'prompt');
    INSERT INTO async_delegations (origin_session_id, parent_session_id, status) VALUES ('s_old', 's_old', 'done');
  `);

  // 5. Child subagent session of old closed task
  db.exec(`
    INSERT INTO sessions VALUES (
      's_old_sub',
      'paperclip', 'user1',
      'paperclip:company:c1:agent:a1:subagent:2',
      NULL, NULL, NULL, NULL, NULL,
      ${nowSec - 11 * daySec}, ${nowSec - 10 * daySec}, ${nowSec - 10 * daySec},
      'OPE-1003 helper review', 's_old'
    );
    INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s_old_sub', 'assistant', 'sub message', ${nowSec - 10 * daySec});
    INSERT INTO session_model_usage (session_id, model, prompt_tokens, completion_tokens) VALUES ('s_old_sub', 'gpt-4', 50, 50);
  `);

  // 6. Unrelated session (e.g. system heartbeat)
  db.exec(`
    INSERT INTO sessions VALUES (
      's_system',
      'system', 'system',
      'sys:health',
      NULL, NULL, NULL, NULL, NULL,
      ${nowSec - 20 * daySec}, NULL, ${nowSec},
      'System monitor', NULL
    );
  `);

  db.close();

  // Run retention using desiredState
  const desiredState = {
    protectKeys: ["OPE-1001"],
    closedKeys: ["OPE-1002", "OPE-1003"],
    workspaces: [
      {
        key: "OPE-1001",
        id: "uuid-active",
        state: "active",
        since: new Date(now - 14 * 86_400_000).toISOString(),
      },
      {
        key: "OPE-1002",
        id: "uuid-recent",
        state: "closing",
        status: "done",
        since: new Date(now - 2 * 86_400_000).toISOString(),
      },
      {
        key: "OPE-1003",
        id: "uuid-old",
        state: "closing",
        status: "done",
        since: new Date(now - 10 * 86_400_000).toISOString(),
      },
    ],
  };

  const logs = [];
  const res = pruneHermesClosedTaskSessions({
    stateDbPath: dbPath,
    desiredState,
    retentionDays: 7,
    now: new Date(now),
    log: (msg) => logs.push(msg),
  });

  assert.strictEqual(res.prunedCount, 2, "must prune exactly 2 sessions: s_old and its child s_old_sub");
  assert.strictEqual(res.vacuumed, true, "vacuum must run");

  // Verify DB state
  const checkDb = new DatabaseSync(dbPath);
  const remainingSessions = checkDb.prepare("SELECT id FROM sessions ORDER BY id").all().map((r) => r.id);
  assert.deepStrictEqual(
    remainingSessions,
    ["s_active", "s_active_sub", "s_recent", "s_system"],
    "active, active child, recent closed, and unrelated sessions must remain"
  );

  // Verify related tables cascaded
  const oldMsgs = checkDb.prepare("SELECT id FROM messages WHERE session_id IN ('s_old', 's_old_sub')").all();
  assert.strictEqual(oldMsgs.length, 0, "messages of pruned sessions must be deleted");

  const activeMsgs = checkDb.prepare("SELECT id FROM messages WHERE session_id = 's_active'").all();
  assert.strictEqual(activeMsgs.length, 1, "messages of active session must remain");

  const oldUsage = checkDb.prepare("SELECT id FROM session_model_usage WHERE session_id IN ('s_old', 's_old_sub')").all();
  assert.strictEqual(oldUsage.length, 0, "model usage of pruned sessions must be deleted");

  const oldLeases = checkDb.prepare("SELECT conversation_id FROM session_turn_leases WHERE conversation_id = 's_old'").all();
  assert.strictEqual(oldLeases.length, 0, "turn leases of pruned session must be deleted");

  const oldLocks = checkDb.prepare("SELECT session_id FROM compression_locks WHERE session_id = 's_old'").all();
  assert.strictEqual(oldLocks.length, 0, "compression locks of pruned session must be deleted");

  const oldObligations = checkDb.prepare("SELECT id FROM delivery_obligations WHERE session_key = 'paperclip:company:c1:agent:a1:issue:uuid-old'").all();
  assert.strictEqual(oldObligations.length, 0, "delivery obligations of pruned session must be deleted");

  checkDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

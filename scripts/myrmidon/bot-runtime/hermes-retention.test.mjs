import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  selectClosedTasksForRetention,
  pruneHermesClosedTaskSessions,
} from "../../../docker/bot-runtime/botd/lib/hermes-retention.js";

test("selectClosedTasksForRetention handles botd payload shape and protects active/recent tasks", () => {
  const now = new Date("2026-10-28T12:00:00Z").getTime();

  const desiredState = {
    generatedAt: new Date(now).toISOString(),
    pressure: false,
    protectKeys: ["OPE-1001", "OPE-PROT"],
    closedKeys: ["OPE-1002", "OPE-1003"],
    workspaces: [
      {
        key: "OPE-1001",
        id: "task-active",
        state: "active",
        status: "in_progress",
        since: new Date(now - 15 * 86_400_000).toISOString(), // old, but ACTIVE!
      },
      {
        key: "OPE-1002",
        id: "task-recent",
        state: "closing",
        status: "done",
        since: new Date(now - 3 * 86_400_000).toISOString(), // closed, but only 3 days ago
      },
      {
        key: "OPE-1003",
        id: "task-old",
        state: "closing",
        status: "done",
        since: new Date(now - 10 * 86_400_000).toISOString(), // closed 10 days ago (> 7 days)
      },
      {
        key: "OPE-PROT",
        id: "task-prot-old",
        state: "closed",
        status: "done",
        since: new Date(now - 20 * 86_400_000).toISOString(), // closed, but explicitly in protectKeys!
      },
    ],
  };

  // 1. Test production botd call shape: passing desiredState with separate lists
  const selection = selectClosedTasksForRetention(desiredState, {
    workspaces: desiredState.workspaces,
    protectKeys: desiredState.protectKeys,
    closedKeys: desiredState.closedKeys,
    retentionDays: 7,
    now,
  });

  assert.deepStrictEqual(selection.closedTaskKeys, ["OPE-1003"], "only task closed >7 days is selected");
  assert.deepStrictEqual(selection.closedTaskIds, ["task-old"]);
  assert.ok(selection.protectedKeys.includes("OPE-1001"), "active task must be in protectedKeys");
  assert.ok(selection.protectedKeys.includes("OPE-PROT"), "protectKeys task must be protected");
  assert.ok(!selection.closedTaskKeys.includes("OPE-1001"), "active task must NOT be in closedTaskKeys");
  assert.ok(!selection.closedTaskKeys.includes("OPE-1002"), "recent closed task must NOT be in closedTaskKeys");
  assert.ok(!selection.closedTaskKeys.includes("OPE-PROT"), "explicitly protected task must NOT be in closedTaskKeys");

  // 2. Test safety against caller passing closedTaskKeys directly: cannot bypass age or protection checks
  const bypassAttempt = selectClosedTasksForRetention(desiredState, {
    workspaces: desiredState.workspaces,
    protectKeys: desiredState.protectKeys,
    closedTaskKeys: ["OPE-1001", "OPE-1002"], // attempt to force active/recent
    retentionDays: 7,
    now,
  });
  assert.ok(!bypassAttempt.closedTaskKeys.includes("OPE-1001"), "active task cannot be forced via closedTaskKeys");
  assert.ok(!bypassAttempt.closedTaskKeys.includes("OPE-1002"), "recent closed task cannot be forced via closedTaskKeys");
});

test("pruneHermesClosedTaskSessions cascades deletion and vacuums DB for >7d closed tasks (botd call shape)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-retention-"));
  const dbPath = path.join(tmp, "state.db");

  const db = new DatabaseSync(dbPath);

  // Initialize SQLite tables matching Hermes production schema
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      session_key TEXT,
      name TEXT,
      parent_session_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      last_activity_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT
    );
    CREATE TABLE session_model_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT
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
  `);

  const now = new Date("2026-10-28T12:00:00Z").getTime();
  const secNow = Math.floor(now / 1000);

  // Seed sessions
  db.exec(`
    INSERT INTO sessions VALUES
      ('s_active', 'paperclip:company:c1:agent:a1:issue:uuid-active', 'OPE-1001', NULL, ${secNow - 864000}, NULL, ${secNow - 3600}),
      ('s_active_sub', 'paperclip:company:c1:agent:a1:subtask:1', 'subtask of active', 's_active', ${secNow - 7200}, NULL, ${secNow - 3600}),
      ('s_recent', 'paperclip:company:c1:agent:a1:issue:uuid-recent', 'OPE-1002', NULL, ${secNow - 172800}, ${secNow - 172800}, ${secNow - 172800}),
      ('s_old', 'paperclip:company:c1:agent:a1:issue:uuid-old', 'OPE-1003', NULL, ${secNow - 864000}, ${secNow - 864000}, ${secNow - 864000}),
      ('s_old_sub', 'paperclip:company:c1:agent:a1:subtask:2', 'subtask of old', 's_old', ${secNow - 864000}, ${secNow - 864000}, ${secNow - 864000}),
      ('s_system', 'system:session:cron', 'cronjob', NULL, ${secNow - 900000}, NULL, ${secNow - 100});
  `);

  // Seed related table records
  db.exec(`
    INSERT INTO messages VALUES
      ('m1', 's_active'),
      ('m2', 's_old'),
      ('m3', 's_old_sub');
    INSERT INTO session_model_usage VALUES
      ('u1', 's_active'),
      ('u2', 's_old'),
      ('u3', 's_old_sub');
    INSERT INTO session_turn_leases VALUES
      ('s_active'),
      ('s_old');
    INSERT INTO compression_locks VALUES
      ('s_active'),
      ('s_old');
    INSERT INTO delivery_obligations VALUES
      ('d1', 'paperclip:company:c1:agent:a1:issue:uuid-active'),
      ('d2', 'paperclip:company:c1:agent:a1:issue:uuid-old');
  `);

  db.close();

  // Test with full botd payload structure
  const desiredState = {
    workspaces: [
      {
        key: "OPE-1001",
        id: "uuid-active",
        state: "active",
        status: "in_progress",
        since: new Date(now - 15 * 86_400_000).toISOString(),
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
    protectKeys: ["OPE-1001"],
    closedKeys: ["OPE-1002", "OPE-1003"],
  };

  const logs = [];
  const res = pruneHermesClosedTaskSessions({
    stateDbPath: dbPath,
    desiredState,
    workspaces: desiredState.workspaces,
    protectKeys: desiredState.protectKeys,
    closedKeys: desiredState.closedKeys,
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

test("pruneHermesClosedTaskSessions rejects caller-supplied closedTaskKeys bypass for active/recent sessions", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-retention-bypass-"));
  const dbPath = path.join(tmp, "state.db");
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      session_key TEXT,
      name TEXT,
      parent_session_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      last_activity_at INTEGER
    );
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT);
  `);

  const now = new Date("2026-10-28T12:00:00Z").getTime();
  const secNow = Math.floor(now / 1000);

  db.exec(`
    INSERT INTO sessions VALUES
      ('s_active', 'paperclip:company:c1:agent:a1:issue:uuid-active', 'OPE-9999', NULL, ${secNow - 1000}, NULL, ${secNow - 100}),
      ('s_recent', 'paperclip:company:c1:agent:a1:issue:uuid-recent', 'OPE-8888', NULL, ${secNow - 86400}, ${secNow - 86400}, ${secNow - 86400});
  `);
  db.close();

  // Caller attempts to pass active/recent task keys via closedTaskKeys option directly
  const res = pruneHermesClosedTaskSessions({
    stateDbPath: dbPath,
    workspaces: [
      { key: "OPE-9999", id: "uuid-active", state: "active", status: "in_progress" },
      { key: "OPE-8888", id: "uuid-recent", state: "closing", status: "done", since: new Date(now - 86400_000).toISOString() },
    ],
    closedTaskKeys: ["OPE-9999", "OPE-8888"],
    retentionDays: 7,
    now: new Date(now),
  });

  assert.strictEqual(res.prunedCount, 0, "must not prune active or recently closed sessions despite closedTaskKeys");

  const checkDb = new DatabaseSync(dbPath);
  const remaining = checkDb.prepare("SELECT id FROM sessions").all().map((r) => r.id);
  assert.deepStrictEqual(remaining, ["s_active", "s_recent"], "all active and recent sessions must remain intact");
  checkDb.close();

  fs.rmSync(tmp, { recursive: true, force: true });
});

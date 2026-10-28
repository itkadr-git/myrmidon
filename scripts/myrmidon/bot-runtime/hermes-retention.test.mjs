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

test("selectClosedTasksForRetention selects only closed tasks older than retention threshold", () => {
  const now = Date.now();
  const day = 86_400_000;

  const workspaces = [
    // 1. Active task (older than 7d, but active -> MUST NOT BE SELECTED)
    {
      key: "OPE-1001",
      id: "uuid-1001",
      state: "active",
      status: "in_progress",
      since: new Date(now - 14 * day).toISOString(),
    },
    // 2. Recently closed task (state closing, closed 2 days ago -> MUST NOT BE SELECTED)
    {
      key: "OPE-1002",
      id: "uuid-1002",
      state: "closing",
      status: "done",
      since: new Date(now - 2 * day).toISOString(),
    },
    // 3. Old closed task (state closing, closed 10 days ago -> MUST BE SELECTED)
    {
      key: "OPE-1003",
      id: "uuid-1003",
      state: "closing",
      status: "done",
      since: new Date(now - 10 * day).toISOString(),
    },
    // 4. Old completed task by status (closed 15 days ago -> MUST BE SELECTED)
    {
      key: "OPE-1004",
      id: "uuid-1004",
      status: "closed",
      closedAt: new Date(now - 15 * day).toISOString(),
    },
  ];

  const selected = selectClosedTasksForRetention(workspaces, { retentionDays: 7, now });

  assert.deepStrictEqual(Array.from(selected.closedTaskKeys).sort(), ["OPE-1003", "OPE-1004"].sort());
  assert.deepStrictEqual(Array.from(selected.closedTaskIds).sort(), ["uuid-1003", "uuid-1004"].sort());
  assert.ok(!selected.closedTaskKeys.has("OPE-1001"), "active task must not be selected");
  assert.ok(!selected.closedTaskKeys.has("OPE-1002"), "recently closed task must not be selected");
});

test("pruneHermesClosedTaskSessions behaviorally prunes only old closed task sessions and runs VACUUM", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-retention-test-"));
  const dbPath = path.join(tmp, "state.db");
  const now = Date.now();
  const nowSec = now / 1000;
  const daySec = 86400;

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      session_key TEXT,
      title TEXT,
      started_at REAL,
      ended_at REAL,
      last_activity_at REAL
    );
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, text TEXT);
    CREATE TABLE session_model_usage (id INTEGER PRIMARY KEY, session_id TEXT);
  `);

  db.exec(`
    INSERT INTO sessions VALUES (
      's_active',
      'paperclip:company:1:agent:1:issue:uuid-active',
      'OPE-ACTIVE working task',
      ${nowSec - 14 * daySec},
      NULL,
      ${nowSec}
    );
    INSERT INTO sessions VALUES (
      's_closed_recent',
      'paperclip:company:1:agent:1:issue:uuid-recent',
      'OPE-RECENT closed 2d ago',
      ${nowSec - 5 * daySec},
      ${nowSec - 2 * daySec},
      ${nowSec - 2 * daySec}
    );
    INSERT INTO sessions VALUES (
      's_closed_old',
      'paperclip:company:1:agent:1:issue:uuid-old',
      'OPE-OLD closed 10d ago',
      ${nowSec - 12 * daySec},
      ${nowSec - 10 * daySec},
      ${nowSec - 10 * daySec}
    );
    INSERT INTO sessions VALUES (
      's_unrelated',
      'random:key',
      'Unrelated conversation',
      ${nowSec - 20 * daySec},
      ${nowSec - 20 * daySec},
      ${nowSec - 20 * daySec}
    );

    INSERT INTO messages VALUES (1, 's_active', 'active work message');
    INSERT INTO messages VALUES (2, 's_closed_recent', 'recent closed message');
    INSERT INTO messages VALUES (3, 's_closed_old', 'old closed message');
    INSERT INTO messages VALUES (4, 's_unrelated', 'unrelated message');

    INSERT INTO session_model_usage VALUES (1, 's_active');
    INSERT INTO session_model_usage VALUES (2, 's_closed_recent');
    INSERT INTO session_model_usage VALUES (3, 's_closed_old');
  `);
  db.close();

  const workspaces = [
    {
      key: "OPE-ACTIVE",
      id: "uuid-active",
      state: "active",
      since: new Date(now - 14 * 86_400_000).toISOString(),
    },
    {
      key: "OPE-RECENT",
      id: "uuid-recent",
      state: "closing",
      since: new Date(now - 2 * 86_400_000).toISOString(),
    },
    {
      key: "OPE-OLD",
      id: "uuid-old",
      state: "closing",
      since: new Date(now - 10 * 86_400_000).toISOString(),
    },
  ];

  const res = pruneHermesClosedTaskSessions({
    stateDbPath: dbPath,
    workspaces,
    retentionDays: 7,
    now,
  });

  assert.strictEqual(res.prunedCount, 1, "only old closed session should be pruned");
  assert.strictEqual(res.vacuumed, true, "VACUUM must run when sessions are pruned");

  const verifyDb = new DatabaseSync(dbPath);
  const remainingSessions = verifyDb.prepare("SELECT id FROM sessions").all().map((r) => r.id);
  assert.deepStrictEqual(
    remainingSessions.sort(),
    ["s_active", "s_closed_recent", "s_unrelated"].sort(),
    "s_closed_old must be pruned, active, recent and unrelated sessions preserved"
  );

  const remainingMessages = verifyDb.prepare("SELECT session_id FROM messages").all().map((r) => r.session_id);
  assert.deepStrictEqual(
    remainingMessages.sort(),
    ["s_active", "s_closed_recent", "s_unrelated"].sort(),
    "cascade delete must remove messages of old closed session only"
  );

  const remainingUsage = verifyDb.prepare("SELECT session_id FROM session_model_usage").all().map((r) => r.session_id);
  assert.deepStrictEqual(
    remainingUsage.sort(),
    ["s_active", "s_closed_recent"].sort(),
    "usage must be preserved for active and recent sessions"
  );

  verifyDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

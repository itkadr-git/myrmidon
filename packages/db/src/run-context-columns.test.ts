// OPE-5007 П2: unit tests for the run-context thin-column helpers.
import { describe, expect, it } from "vitest";
import {
  attentionRunIssueTaskColumns,
  HEARTBEAT_RUN_CONTEXT_SUMMARY_MAX_CHARS,
  heartbeatRunListContextColumnProjections,
  readRunContextColumnValues,
  runContextPersistenceFields,
  runContextWritePatch,
  stripRunContextForPersistence,
} from "./run-context-columns.js";
import { PgDialect } from "drizzle-orm/pg-core";
import { heartbeatRuns } from "./schema/heartbeat_runs.js";

const dialect = new PgDialect();

function renderProjections(projections: Record<string, unknown>): string {
  // Same unwrap trick as existing repo tests: every fragment carries an
  // underlying SQL expression renderable through the pg dialect.
  return Object.entries(projections)
    .map(([, fragment]) => renderOne(fragment))
    .join(", ");
}

function renderOne(fragment: unknown): string {
  const holder = fragment as { __drizzle_sql?: unknown; sql?: unknown };
  const inner = holder.__drizzle_sql ?? holder.sql ?? fragment;
  return dialect.sqlToQuery(inner as never).sql;
}

describe("readRunContextColumnValues", () => {
  it("extracts the eight thin fields and drops empty strings", () => {
    const values = readRunContextColumnValues({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "",
      commentId: "comment-1",
      wakeCommentId: "wake-comment-1",
      wakeReason: "issue_commented",
      wakeSource: "user",
      wakeTriggerDetail: "manual",
      prompt: "x".repeat(4096),
    });
    expect(values).toEqual({
      contextIssueId: "issue-1",
      contextTaskId: "task-1",
      contextTaskKey: null,
      contextCommentId: "comment-1",
      contextWakeCommentId: "wake-comment-1",
      contextWakeReason: "issue_commented",
      contextWakeSource: "user",
      contextWakeTriggerDetail: "manual",
      contextRunSummary: null,
    });
  });

  it("derives the summary from taskTitle, falling back to the continuation objective", () => {
    expect(
      readRunContextColumnValues({ taskTitle: "OPE-1: do the thing" })
        .contextRunSummary,
    ).toBe("OPE-1: do the thing");
    expect(
      readRunContextColumnValues({
        executionContinuation: { objective: "continue the work" },
      }).contextRunSummary,
    ).toBe("continue the work");
    const long = readRunContextColumnValues({
      taskTitle: "t".repeat(HEARTBEAT_RUN_CONTEXT_SUMMARY_MAX_CHARS + 200),
    });
    expect(long.contextRunSummary).toHaveLength(HEARTBEAT_RUN_CONTEXT_SUMMARY_MAX_CHARS);
  });

  it("tolerates null snapshots", () => {
    expect(readRunContextColumnValues(null).contextIssueId).toBeNull();
    expect(readRunContextColumnValues(undefined).contextRunSummary).toBeNull();
  });
});

describe("stripRunContextForPersistence", () => {
  it("drops the executionContinuation duplicate and keeps everything else", () => {
    const context = {
      issueId: "issue-1",
      wakeReason: "heartbeat_timer",
      executionContinuation: { objective: "big", messages: new Array(500) },
    };
    const stripped = stripRunContextForPersistence(context);
    expect(stripped).not.toHaveProperty("executionContinuation");
    expect(stripped).toMatchObject({ issueId: "issue-1", wakeReason: "heartbeat_timer" });
    // The in-memory context keeps the envelope: the wake payload is built
    // from it before persistence, and resumeDelta still works.
    expect(context.executionContinuation).toBeDefined();
    expect(stripped).not.toBe(context);
  });

  it("passes through snapshots without the envelope without copying", () => {
    const context = { issueId: "issue-1" };
    expect(stripRunContextForPersistence(context)).toBe(context);
    expect(stripRunContextForPersistence(null)).toBeNull();
  });
});

describe("runContextPersistenceFields", () => {
  it("fills all nine columns from the same object that is persisted", () => {
    const fields = runContextPersistenceFields({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "OPE-1",
      commentId: "comment-1",
      wakeCommentId: "wake-comment-1",
      wakeReason: "issue_commented",
      wakeSource: "user",
      wakeTriggerDetail: "manual",
      taskTitle: "OPE-1: do the thing",
      executionContinuation: { objective: "big envelope" },
    });
    expect(Object.keys(fields)).toHaveLength(10); // 9 columns + contextSnapshot
    expect(fields.contextSnapshot).not.toHaveProperty("executionContinuation");
    expect(fields).toMatchObject({
      contextIssueId: "issue-1",
      contextTaskId: "task-1",
      contextTaskKey: "OPE-1",
      contextCommentId: "comment-1",
      contextWakeCommentId: "wake-comment-1",
      contextWakeReason: "issue_commented",
      contextWakeSource: "user",
      contextWakeTriggerDetail: "manual",
      contextRunSummary: "OPE-1: do the thing",
    });
  });

  it("keeps the objective summary even though the envelope is not persisted", () => {
    const fields = runContextPersistenceFields({
      issueId: "issue-1",
      executionContinuation: { objective: "finish the migration" },
    });
    expect(fields.contextRunSummary).toBe("finish the migration");
    expect(fields.contextSnapshot).not.toHaveProperty("executionContinuation");
  });
});

describe("runContextWritePatch", () => {
  it("replaces a plain-object snapshot with the stripped snapshot plus columns", () => {
    const patch = runContextWritePatch({
      status: "queued",
      contextSnapshot: { issueId: "issue-1", executionContinuation: { objective: "o" } },
    });
    expect(patch).toMatchObject({
      status: "queued",
      contextIssueId: "issue-1",
      contextRunSummary: "o",
    });
    expect(patch.contextSnapshot).not.toHaveProperty("executionContinuation");
  });

  it("leaves SQL-managed snapshot patches and patches without snapshots untouched", () => {
    const sqlPatch = { contextSnapshot: heartbeatRuns.contextSnapshot };
    expect(runContextWritePatch(sqlPatch)).toBe(sqlPatch);
    const noSnapshot = { status: "running" };
    expect(runContextWritePatch(noSnapshot)).toBe(noSnapshot);
  });
});

describe("heartbeat list projections", () => {
  it("reads every thin field via coalesce(column, snapshot ->> key) — never the whole snapshot", () => {
    const entries = Object.entries(heartbeatRunListContextColumnProjections);
    expect(entries).toHaveLength(8);
    const all = renderProjections(Object.fromEntries(entries));
    for (const [alias, fragment] of entries) {
      const sqlText = renderOne(fragment);
      expect(sqlText, alias).toMatch(/^coalesce\(/);
      expect(sqlText, alias).toContain("->>");
      expect(sqlText, alias).not.toMatch(/context_snapshot"(?!\s*->>)/);
    }
    expect(all).toContain("context_issue_id");
    expect(all).toContain("context_wake_trigger_detail");
  });

  it("projects issueId/taskId for the attention feed from the thin columns", () => {
    const attentionSql = renderProjections(attentionRunIssueTaskColumns);
    expect(attentionSql).toContain("context_issue_id");
    expect(attentionSql).toContain("context_task_id");
  });
});

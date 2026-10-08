// myrmidon(DB-PERF-C-P5): the work gates answer "is there anything for this
// lane to do" with one cheap statement. These tests pin the two properties the
// coordinator relies on: one statement per gate (never two), and a "no work"
// answer that cannot be reached while the lane still has work.
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  MILESTONE_WATERMARK_SAFETY_WINDOW_MS,
  PUBLICATION_SAFETY_WINDOW_MS,
  createChatReconciliationWorkGates,
  hasDeliveryWork,
  hasPublicationWork,
  hasRunMilestoneWork,
  hasSlackFileReceiptWork,
  hasSlackSessionSyncWork,
  type WorkGateDb,
} from "./work-gates.js";

const dialect = new PgDialect();

/** A neutral company scope; the gates take one from their call site. */
const COMPANY_ID = "00000000-0000-0000-0000-000000000000";

function harness(rows: unknown[] = []) {
  const statements: SQL[] = [];
  const execute = vi.fn(async (statement: SQL) => {
    statements.push(statement);
    return rows;
  });
  const db = { execute } as unknown as WorkGateDb;
  return {
    db,
    execute,
    statements,
    rendered: () => statements.map((s) => dialect.sqlToQuery(s).sql),
    params: () => statements.map((s) => dialect.sqlToQuery(s).params),
  };
}

describe("chat reconciliation work gates", () => {
  it("asks each queue once and reads the answer off an empty result", async () => {
    const empty = harness([]);
    await expect(hasPublicationWork(empty.db)).resolves.toBe(false);
    await expect(hasDeliveryWork(empty.db)).resolves.toBe(false);
    await expect(hasSlackFileReceiptWork(empty.db)).resolves.toBe(false);
    await expect(hasSlackSessionSyncWork(empty.db)).resolves.toBe(false);
    await expect(
      hasRunMilestoneWork(empty.db, { since: new Date(0) }),
    ).resolves.toBe(false);
    // Five gates, five statements: one per queue, never a fan-out.
    expect(empty.statements).toHaveLength(5);
    for (const sql of empty.rendered()) {
      expect(sql.startsWith("select 1 as probe where (")).toBe(true);
      expect(sql.endsWith("limit 1")).toBe(true);
    }
  });

  it("reports work when the probe returns a row", async () => {
    const occupied = harness([{ probe: 1 }]);
    await expect(hasPublicationWork(occupied.db)).resolves.toBe(true);
    await expect(hasDeliveryWork(occupied.db)).resolves.toBe(true);
    await expect(hasSlackFileReceiptWork(occupied.db)).resolves.toBe(true);
    await expect(hasSlackSessionSyncWork(occupied.db)).resolves.toBe(true);
    await expect(
      hasRunMilestoneWork(occupied.db, { since: new Date(0) }),
    ).resolves.toBe(true);
  });

  it("keeps every predicate on an indexed column of the target queue", async () => {
    const h = harness([]);
    await hasPublicationWork(h.db, { now: new Date(0) });
    await hasDeliveryWork(h.db);
    await hasSlackFileReceiptWork(h.db);
    await hasSlackSessionSyncWork(h.db);
    await hasRunMilestoneWork(h.db, { since: new Date(0) });
    const [publications, deliveries, receipts, sessionSyncs, milestones] =
      h.rendered();

    // Publications: chat_publications_work_idx (state, next_attempt_at).
    expect(publications).toContain(
      `"chat_publications"."state" in ('pending', 'retry')`,
    );
    expect(publications).toContain(
      `"chat_publications"."next_attempt_at" is null`,
    );
    expect(publications).toContain(
      `"chat_publications"."next_attempt_at" <= $1`,
    );
    expect(publications).toContain(`"chat_publications"."state" in ('streaming')`);
    expect(publications).toContain(
      `"chat_actions"."kind" = 'confirmation_response'`,
    );
    // The settled-wakeup notice producers are NOT modelled here: that
    // question needs a scan of the whole settled population and measured
    // slower than the sweep it would replace. The lane reaches them through
    // its safety window instead.
    expect(publications).not.toContain(`inner join "agent_wakeup_requests"`);
    expect(publications).not.toContain(`"chat_publications"."idempotency_key" =`);

    // Deliveries: chat_deliveries_work_idx plus the chat_actions outboxes.
    expect(deliveries).toContain(
      `"chat_deliveries"."state" in ('received', 'retry', 'processing')`,
    );
    expect(deliveries).toContain(`"chat_actions"."kind" in (`);
    expect(deliveries).toContain(`"chat_actions"."result" ->> 'retryable' = 'true'`);

    // Slack lanes: chat_actions_inbound_wakeup_sweep_idx (kind, status, ...).
    expect(receipts).toContain(
      `"chat_actions"."kind" = 'slack_file_upload_receipt'`,
    );
    expect(sessionSyncs).toContain(
      `"chat_actions"."kind" = 'slack_session_sync'`,
    );

    // Milestones: heartbeat_runs_company_ctx_issue_created_idx per conversation.
    expect(milestones).toContain(
      `"chat_conversations"."state" in ('active', 'waiting')`,
    );
    expect(milestones).toContain(`"chat_endpoints"."publication_mode" = 'automatic'`);
    expect(milestones).toContain(
      `"heartbeat_runs"."context_snapshot" ->> 'issueId' = "chat_conversations"."issue_id"::text`,
    );
    expect(milestones).toContain(`"heartbeat_runs"."updated_at" > $1`);
  });

  it("narrows a probe to one company when the call site asks for it", async () => {
    const h = harness([]);
    await hasPublicationWork(h.db, { companyId: COMPANY_ID });
    expect(h.rendered()[0]).toContain(
      `"chat_publications"."company_id" = $2`,
    );
    expect(h.params()[0]).toContain(COMPANY_ID);
  });

  it("leaves the queue predicates untouched without a company scope", async () => {
    const h = harness([]);
    await hasPublicationWork(h.db);
    // Only the queue's own `now` bound is bound; no company scope is added.
    expect(h.params()[0]).toHaveLength(1);
    expect(h.params()[0]).not.toContain(COMPANY_ID);
  });
});

describe("publication gate safety window", () => {
  it("treats the first pass of a process as a full pass without a query", async () => {
    const h = harness([]);
    const gates = createChatReconciliationWorkGates({ db: h.db });
    await expect(gates.hasPublicationWork()).resolves.toBe(true);
    expect(h.statements).toHaveLength(0);
  });

  it("probes the outbox while the window is still open", async () => {
    const passAt = new Date("2026-01-01T00:00:00.000Z");
    const h = harness([]);
    const gates = createChatReconciliationWorkGates({
      db: h.db,
      now: () => new Date(passAt.getTime() + PUBLICATION_SAFETY_WINDOW_MS - 1),
    });
    gates.notePublicationPassCompleted(passAt);
    await expect(gates.hasPublicationWork()).resolves.toBe(false);
    expect(h.statements).toHaveLength(1);
    expect(h.rendered()[0]).toContain(
      `"chat_publications"."state" in ('pending', 'retry')`,
    );
  });

  it("forces one pass per safety window, so idle ticks stay cheap", async () => {
    // The two notice producers inside the publication lane ask a question no
    // cheap index probe can answer; the window is what keeps their notices
    // bounded while the lane's idle ticks stop paying for the sweep.
    const passAt = new Date("2026-01-01T00:00:00.000Z");
    const h = harness([]);
    const gates = createChatReconciliationWorkGates({
      db: h.db,
      now: () => new Date(passAt.getTime() + PUBLICATION_SAFETY_WINDOW_MS),
    });
    gates.notePublicationPassCompleted(passAt);
    await expect(gates.hasPublicationWork()).resolves.toBe(true);
    expect(h.statements).toHaveLength(0);
  });
});

describe("run-milestone gate watermark", () => {
  it("treats the first pass of a process as a full pass without a query", async () => {
    const h = harness([]);
    const gates = createChatReconciliationWorkGates({ db: h.db });
    await expect(gates.hasMilestoneWork()).resolves.toBe(true);
    expect(h.statements).toHaveLength(0);
  });

  it("probes runs updated after the last completed pass", async () => {
    const passStartedAt = new Date("2026-01-01T00:00:00.000Z");
    const h = harness([]);
    const gates = createChatReconciliationWorkGates({
      db: h.db,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    });
    gates.noteMilestonePassCompleted(passStartedAt, 0);
    await expect(gates.hasMilestoneWork()).resolves.toBe(false);
    expect(h.statements).toHaveLength(1);
    expect(h.rendered()[0]).toContain(`"heartbeat_runs"."updated_at" > $1`);
    const param = h.params()[0]![0] as Date;
    expect(param.getTime()).toBe(passStartedAt.getTime());
  });

  it("does not advance the watermark on a pass that inserted rows", async () => {
    // A productive pass may have stopped at the projection's own row budget
    // with older candidates still unprocessed; moving the watermark there
    // would strand them.
    const emptyPassStart = new Date("2026-01-01T00:00:00.000Z");
    const productivePassStart = new Date("2026-01-01T00:00:05.000Z");
    const h = harness([]);
    const gates = createChatReconciliationWorkGates({
      db: h.db,
      now: () => new Date("2026-01-01T00:00:06.000Z"),
    });
    gates.noteMilestonePassCompleted(emptyPassStart, 0);
    gates.noteMilestonePassCompleted(productivePassStart, 7);
    await gates.hasMilestoneWork();
    const param = h.params()[0]![0] as Date;
    expect(param.getTime()).toBe(emptyPassStart.getTime());
  });

  it("reopens for one full pass per safety window", async () => {
    const passStartedAt = new Date("2026-01-01T00:00:00.000Z");
    const h = harness([]);
    const gates = createChatReconciliationWorkGates({
      db: h.db,
      now: () =>
        new Date(passStartedAt.getTime() + MILESTONE_WATERMARK_SAFETY_WINDOW_MS),
    });
    gates.noteMilestonePassCompleted(passStartedAt, 0);
    await expect(gates.hasMilestoneWork()).resolves.toBe(true);
    expect(h.statements).toHaveLength(0);
  });

  it("takes a fresh full pass after an explicit reset", async () => {
    const h = harness([]);
    const gates = createChatReconciliationWorkGates({ db: h.db });
    gates.noteMilestonePassCompleted(new Date(0), 0);
    gates.resetMilestoneWatermark();
    await expect(gates.hasMilestoneWork()).resolves.toBe(true);
    expect(h.statements).toHaveLength(0);
  });

  it("answers a null watermark for the standalone gate without a query", async () => {
    const h = harness([]);
    await expect(
      hasRunMilestoneWork(h.db, { since: null }),
    ).resolves.toBe(true);
    expect(h.statements).toHaveLength(0);
  });
});

describe("chat reconciliation work gate factory", () => {
  it("runs one statement per gate and forwards the queue answers", async () => {
    const h = harness([{ probe: 1 }]);
    const gates = createChatReconciliationWorkGates({ db: h.db });
    // The first publication tick is a full pass too (its own safety window
    // starts empty), so three queue probes run here and nothing else.
    await expect(gates.hasPublicationWork()).resolves.toBe(true);
    await expect(gates.hasDeliveryWork()).resolves.toBe(true);
    await expect(gates.hasSlackFileReceiptWork()).resolves.toBe(true);
    await expect(gates.hasSlackSessionSyncWork()).resolves.toBe(true);
    // The milestone gate answers from memory until a pass has been recorded.
    await expect(gates.hasMilestoneWork()).resolves.toBe(true);
    expect(h.statements).toHaveLength(3);
  });
});
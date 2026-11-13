import { describe, expect, it, vi } from "vitest";
import { appendAgentRecoveryJournal } from "../services/agent-recovery-journal.js";

const readMaintenanceDocument = vi.hoisted(() => vi.fn(async () => ({ version: 1 as const, windows: [], history: [] })));
vi.mock("../myrmidon/maintenance/store.js", () => ({ readMaintenanceDocument }));

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

function fakeDb() {
  let rows: Array<Record<string, unknown>> = [];
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => rows.filter((row) => row.dedupKey === "agent-recovery:test")),
          })),
          then: (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve(resolve([{ id: agentId, reportsTo: null }])),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((value: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          const row = { id: `row-${rows.length + 1}`, ...value };
          rows.push(row);
          return [row];
        }),
      })),
    })),
  };
  return { transaction: async <T>(callback: (value: typeof tx) => Promise<T>) => callback(tx), rows };
}

const input = {
  companyId,
  agentId,
  step: "retry",
  cause: "stalled_run",
  dedupKey: "agent-recovery:test",
  payload: { runId: "run-1" },
};

describe("agent recovery journal append", () => {
  it("does not append the same dedup key twice inside the window", async () => {
    const db = fakeDb();
    const first = await appendAgentRecoveryJournal(db as never, input, { now: new Date("2026-11-13T10:00:00Z") });
    const second = await appendAgentRecoveryJournal(db as never, input, { now: new Date("2026-11-13T10:01:00Z") });

    expect(first.disposition).toBe("committed");
    expect(second.disposition).toBe("duplicate");
    expect(second.row?.id).toBe(first.row?.id);
    expect(db.rows).toHaveLength(1);
  });

  it("appends again once the dedup window has passed", async () => {
    const db = fakeDb();
    await appendAgentRecoveryJournal(db as never, input, {
      now: new Date("2026-11-13T10:00:00Z"),
      dedupWindowMs: 60_000,
    });
    const later = await appendAgentRecoveryJournal(db as never, input, {
      now: new Date("2026-11-13T10:05:00Z"),
      dedupWindowMs: 60_000,
    });

    expect(later.disposition).toBe("committed");
    expect(db.rows).toHaveLength(2);
  });

  it("records exclusion suppression without executing the step", async () => {
    const db = fakeDb();
    const result = await appendAgentRecoveryJournal(db as never, {
      ...input,
      exclusionWindows: [{ startAt: "2026-11-13T10:00:00Z", endAt: "2026-11-13T11:00:00Z" }],
    }, { now: new Date("2026-11-13T10:30:00Z") });

    expect(result.disposition).toBe("committed");
    expect(result.suppressed).toBe(true);
    expect(result.row?.suppressedReason).toBe("exclusion_window");
  });

  it("commits an unsuppressed row outside exclusion windows", async () => {
    const db = fakeDb();
    const result = await appendAgentRecoveryJournal(db as never, input, { now: new Date("2026-11-13T12:00:00Z") });

    expect(result.disposition).toBe("committed");
    expect(result.suppressed).toBe(false);
    expect(result.row?.suppressedReason).toBeNull();
  });
});

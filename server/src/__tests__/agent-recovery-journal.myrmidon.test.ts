import { describe, expect, it, vi } from "vitest";
import {
  appendAgentRecoveryJournal,
  executeAgentRecoveryAction,
} from "../services/agent-recovery-journal.js";

const readMaintenanceDocument = vi.hoisted(() =>
  vi.fn(async () => ({ version: 1 as const, windows: [], history: [] })),
);
vi.mock("../myrmidon/maintenance/store.js", () => ({ readMaintenanceDocument }));

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

function findDate(obj: unknown, seen = new Set<unknown>()): Date | null {
  if (!obj || typeof obj !== "object") return null;
  if (obj instanceof Date) return obj;
  if (seen.has(obj)) return null;
  seen.add(obj);
  if ("value" in obj && (obj as { value?: unknown }).value instanceof Date) {
    return (obj as { value: Date }).value;
  }
  for (const key of Object.getOwnPropertyNames(obj)) {
    try {
      const found = findDate((obj as Record<string, unknown>)[key], seen);
      if (found) return found;
    } catch {
      // ignore
    }
  }
  return null;
}

function fakeDb() {
  let rows: Array<Record<string, unknown>> = [];
  const tx = {
    execute: vi.fn(async () => []),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((clause?: unknown) => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => {
              const since = findDate(clause);
              return rows.filter((row) => {
                if (row.dedupKey !== "agent-recovery:test") return false;
                if (since && row.createdAt) {
                  const rowTime =
                    row.createdAt instanceof Date
                      ? row.createdAt.getTime()
                      : new Date(row.createdAt as string).getTime();
                  return rowTime >= since.getTime();
                }
                return true;
              });
            }),
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
  return {
    transaction: async <T>(callback: (value: typeof tx) => Promise<T>) => callback(tx),
    rows,
    tx,
  };
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
    expect(second.executed).toBe(false);
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

  it("safely deduplicates concurrent appends with the same dedupKey and suppresses the duplicate action", async () => {
    const db = fakeDb();
    const now = new Date("2026-11-13T10:00:00Z");
    const action1 = vi.fn(async () => ({ run: 1 }));
    const action2 = vi.fn(async () => ({ run: 2 }));

    const [first, second] = await Promise.all([
      appendAgentRecoveryJournal(db as never, { ...input, action: action1 }, { now }),
      appendAgentRecoveryJournal(db as never, { ...input, action: action2 }, { now }),
    ]);

    const committed = [first, second].filter((r) => r.disposition === "committed");
    const duplicate = [first, second].filter((r) => r.disposition === "duplicate");

    expect(committed).toHaveLength(1);
    expect(duplicate).toHaveLength(1);
    expect(db.rows).toHaveLength(1);
    expect(duplicate[0]?.row?.id).toBe(committed[0]?.row?.id);
    expect(committed[0]?.executed).toBe(true);
    expect(duplicate[0]?.executed).toBe(false);
    expect(action1.mock.calls.length + action2.mock.calls.length).toBe(1);
  });

  it("records exclusion suppression and suppresses action execution within an explicit exclusion window", async () => {
    const db = fakeDb();
    const action = vi.fn(async () => ({ status: "recovering" }));
    const result = await appendAgentRecoveryJournal(
      db as never,
      {
        ...input,
        action,
        exclusionWindows: [{ startAt: "2026-11-13T10:00:00Z", endAt: "2026-11-13T11:00:00Z" }],
      },
      { now: new Date("2026-11-13T10:30:00Z") },
    );

    expect(result.disposition).toBe("committed");
    expect(result.suppressed).toBe(true);
    expect(result.row?.suppressedReason).toBe("exclusion_window");
    expect(result.executed).toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(1);
  });

  it("records exclusion suppression and suppresses action execution within a maintenance exclusion window", async () => {
    const db = fakeDb();
    readMaintenanceDocument.mockResolvedValueOnce({
      version: 1,
      windows: [
        {
          id: "mw-1",
          startAt: "2026-11-13T10:00:00Z",
          endAt: "2026-11-13T11:00:00Z",
          scope: { all: true },
        },
      ],
      history: [],
    });
    const action = vi.fn(async () => ({ status: "recovering" }));
    const result = await appendAgentRecoveryJournal(
      db as never,
      { ...input, action },
      { now: new Date("2026-11-13T10:30:00Z") },
    );

    expect(result.disposition).toBe("committed");
    expect(result.suppressed).toBe(true);
    expect(result.row?.suppressedReason).toBe("exclusion_window");
    expect(result.executed).toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(1);
  });

  it("commits an unsuppressed row outside exclusion windows and executes the action", async () => {
    const db = fakeDb();
    const action = vi.fn(async () => ({ status: "recovered" }));
    const result = await appendAgentRecoveryJournal(
      db as never,
      { ...input, action },
      { now: new Date("2026-11-13T12:00:00Z") },
    );

    expect(result.disposition).toBe("committed");
    expect(result.suppressed).toBe(false);
    expect(result.row?.suppressedReason).toBeNull();
    expect(result.executed).toBe(true);
    expect(result.actionResult).toEqual({ status: "recovered" });
    expect(action).toHaveBeenCalledOnce();
  });

  it("executes action via executeAgentRecoveryAction only when not suppressed", async () => {
    const db = fakeDb();
    const action = vi.fn(async () => ({ done: true }));
    const result = await executeAgentRecoveryAction(
      db as never,
      input,
      action,
      { now: new Date("2026-11-13T12:00:00Z") },
    );

    expect(result.disposition).toBe("committed");
    expect(result.executed).toBe(true);
    expect(result.actionResult).toEqual({ done: true });
    expect(action).toHaveBeenCalledOnce();
  });
});

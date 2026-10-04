// myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half): the pass-journal contract —
// what the "Foraging" page reads back. The reader is defensive on purpose: a
// hand-edited row loses entries, never the view.
import { describe, expect, it } from "vitest";
import {
  appendForagingPassJournal,
  readForagingPassJournal,
  FORAGING_PASS_JOURNAL_KEY,
  FORAGING_PASS_JOURNAL_LIMIT,
  type ForagingPassJournalEntry,
} from "./myrmidon-foraging-pass-journal.js";

function entry(overrides: Partial<ForagingPassJournalEntry> = {}): ForagingPassJournalEntry {
  return {
    at: "2026-10-04T10:00:00.000Z",
    companyId: "company-a",
    sourcesRead: 2,
    findings: 1,
    candidates: 0,
    errors: 0,
    stoppedByBudget: false,
    skippedReason: null,
    skipped: [],
    ...overrides,
  };
}

describe("myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half) pass journal", () => {
  it("keeps the stored key name stable (the settings row reads it back)", () => {
    expect(FORAGING_PASS_JOURNAL_KEY).toBe("foragingPassJournal");
  });

  it("appends newest first and drops the tail beyond the cap", () => {
    let stored: unknown = [];
    for (let index = 1; index <= FORAGING_PASS_JOURNAL_LIMIT + 5; index += 1) {
      stored = appendForagingPassJournal(stored, entry({ at: `2026-10-04T10:${String(index).padStart(2, "0")}:00.000Z` }));
    }
    const read = readForagingPassJournal(stored);
    expect(read).toHaveLength(FORAGING_PASS_JOURNAL_LIMIT);
    // The newest pass is the head; the oldest ones fell off.
    expect(read[0]?.at).toBe(`2026-10-04T10:${String(FORAGING_PASS_JOURNAL_LIMIT + 5).padStart(2, "0")}:00.000Z`);
    expect(read.some((item) => item.at === "2026-10-04T10:01:00.000Z")).toBe(false);
  });

  it("records the skipped roles and their reasons", () => {
    const stored = appendForagingPassJournal([], entry({
      skippedReason: "no_idle_agent",
      skipped: [
        { role: "engineer", reason: "queue_not_empty" },
        { role: "researcher", reason: "no_idle_agent" },
      ],
    }));
    const read = readForagingPassJournal(stored);
    expect(read[0]?.skipped).toEqual([
      { role: "engineer", reason: "queue_not_empty" },
      { role: "researcher", reason: "no_idle_agent" },
    ]);
    // The named reason of the pass wins over the first skipped role.
    expect(read[0]?.skippedReason).toBe("no_idle_agent");
  });

  it("falls back to the first skipped role when the pass reported no reason", () => {
    const stored = appendForagingPassJournal([], entry({
      skippedReason: null,
      skipped: [{ role: "engineer", reason: "queue_not_empty" }],
    }));
    expect(readForagingPassJournal(stored)[0]?.skippedReason).toBe("queue_not_empty");
  });

  it("filters the instance-wide list down to one company", () => {
    let stored: unknown = [];
    stored = appendForagingPassJournal(stored, entry({ companyId: "company-a", at: "2026-10-04T10:00:00.000Z" }));
    stored = appendForagingPassJournal(stored, entry({ companyId: "company-b", at: "2026-10-04T11:00:00.000Z" }));
    stored = appendForagingPassJournal(stored, entry({ companyId: "company-a", at: "2026-10-04T12:00:00.000Z" }));
    const read = readForagingPassJournal(stored, { companyId: "company-a" });
    expect(read.map((item) => item.at)).toEqual(["2026-10-04T12:00:00.000Z", "2026-10-04T10:00:00.000Z"]);
  });

  it("keeps the passes of other companies when a new pass is appended", () => {
    const stored = appendForagingPassJournal([], entry({ companyId: "company-b" }));
    const next = appendForagingPassJournal(stored, entry({ companyId: "company-a" }));
    const all = readForagingPassJournal(next);
    expect(all.map((item) => item.companyId)).toEqual(["company-a", "company-b"]);
  });

  it("drops an unreadable entry instead of failing the whole history", () => {
    const stored = [
      entry({ at: "2026-10-04T12:00:00.000Z" }),
      { at: "not-a-pass" },
      null,
      { companyId: "company-a" },
      entry({ at: "2026-10-04T09:00:00.000Z" }),
    ];
    const read = readForagingPassJournal(stored);
    expect(read.map((item) => item.at)).toEqual([
      "2026-10-04T12:00:00.000Z",
      "2026-10-04T09:00:00.000Z",
    ]);
  });

  it("reads a value that is not a list at all as an empty history", () => {
    expect(readForagingPassJournal(undefined)).toEqual([]);
    expect(readForagingPassJournal({ passes: [] })).toEqual([]);
  });

  it("ignores a skipped role with an unknown reason", () => {
    const stored = appendForagingPassJournal([], entry({
      skippedReason: null,
      skipped: [
        { role: "engineer", reason: "made_up_reason" as never },
        { role: "researcher", reason: "queue_not_empty" },
      ],
    }));
    expect(readForagingPassJournal(stored)[0]?.skipped).toEqual([
      { role: "researcher", reason: "queue_not_empty" },
    ]);
  });
});
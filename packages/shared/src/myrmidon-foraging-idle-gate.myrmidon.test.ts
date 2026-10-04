// myrmidon(1.6.2-FORAGING-IDLE-GATE): the shared contract of the per-company
// "только в простое" switch and the pass journal — precedence, the stored
// shape, and the journal cap. Pure, so the rules are pinned without a database.

import { describe, expect, it } from "vitest";
import {
  appendForagingPassRecord,
  foragingPassHistory,
  normalizeForagingIdleGateSettings,
  normalizeForagingPassJournal,
  resolveForagingIdleGate,
  storedForagingIdleOnly,
  type ForagingPassRecord,
} from "./myrmidon-foraging-idle-gate.js";

const pass: ForagingPassRecord = {
  at: "2026-10-04T09:00:00.000Z",
  skipReason: null,
  skippedRoles: [],
  sourcesRead: 1,
  findings: 0,
  candidates: 0,
  spentCents: 1,
  stoppedByBudget: false,
  errors: 0,
};

describe("myrmidon(1.6.2-FORAGING-IDLE-GATE) resolveForagingIdleGate", () => {
  it("lets the environment force the value over the stored one", () => {
    expect(resolveForagingIdleGate({ storedIdleOnly: true, envOverride: false })).toEqual({
      idleOnly: false,
      source: "env",
    });
    expect(resolveForagingIdleGate({ storedIdleOnly: false, envOverride: true })).toEqual({
      idleOnly: true,
      source: "env",
    });
  });

  it("uses the stored value when the environment does not answer", () => {
    expect(resolveForagingIdleGate({ storedIdleOnly: true, envOverride: null })).toEqual({
      idleOnly: true,
      source: "interface",
    });
  });

  it("falls back to the default (off) when nobody answered", () => {
    expect(resolveForagingIdleGate({ storedIdleOnly: null, envOverride: null })).toEqual({
      idleOnly: false,
      source: "default",
    });
  });
});

describe("myrmidon(1.6.2-FORAGING-IDLE-GATE) the stored switch", () => {
  it("reads one company's switch and null for a company with no row", () => {
    const settings = normalizeForagingIdleGateSettings({
      companies: { "company-a": { idleOnly: true, updatedAt: "2026-10-04T09:00:00.000Z" } },
    });
    expect(storedForagingIdleOnly(settings, "company-a")).toBe(true);
    expect(storedForagingIdleOnly(settings, "company-b")).toBeNull();
  });

  it("cannot half-apply a hand-edited row: unreadable means no company is switched", () => {
    expect(normalizeForagingIdleGateSettings({ companies: { "company-a": { idleOnly: "yes" } } })).toEqual({
      companies: {},
    });
    expect(normalizeForagingIdleGateSettings(null)).toEqual({ companies: {} });
  });
});

describe("myrmidon(1.6.2-FORAGING-IDLE-GATE) the pass journal", () => {
  it("prepends the newest pass and keeps the history bounded", () => {
    let journal = normalizeForagingPassJournal(undefined);
    for (let index = 0; index < 25; index += 1) {
      journal = appendForagingPassRecord(journal, "company-a", {
        ...pass,
        at: `2026-10-04T09:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }
    const rows = foragingPassHistory(journal, "company-a");
    expect(rows).toHaveLength(20);
    expect(rows[0].at).toBe("2026-10-04T09:24:00.000Z");
    expect(rows[19].at).toBe("2026-10-04T09:05:00.000Z");
  });

  it("keeps each company's history apart and honours a read limit", () => {
    let journal = appendForagingPassRecord(normalizeForagingPassJournal({}), "company-a", pass);
    journal = appendForagingPassRecord(journal, "company-b", { ...pass, skipReason: "agents_busy_for_role" });

    expect(foragingPassHistory(journal, "company-a")).toHaveLength(1);
    expect(foragingPassHistory(journal, "company-b")[0].skipReason).toBe("agents_busy_for_role");
    expect(foragingPassHistory(journal, "company-c")).toEqual([]);
    expect(foragingPassHistory(journal, "company-b", 0)).toHaveLength(1);
  });

  it("reads an unreadable journal as empty instead of failing the screen", () => {
    expect(normalizeForagingPassJournal({ companies: { "company-a": [{ at: 1 }] } })).toEqual({ companies: {} });
  });
});
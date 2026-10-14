// server/src/myrmidon/model-providers/signals.myrmidon.test.ts
//
// myrmidon(1.6.6 OPE-7198): unit tests for Codex / ChatGPT subscription pool
// role notification signals and in-memory registry.

import { beforeEach, describe, expect, it } from "vitest";
import type { PoolAccountChannelView } from "@paperclipai/shared";
import {
  clearPoolAccountSignals,
  codexPoolBannedDedupKey,
  codexPoolExhaustedDedupKey,
  evaluateAccountSignals,
  readPoolAccountSignals,
  recordPoolAccountSignals,
} from "./signals.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function makeChannel(overrides: Partial<PoolAccountChannelView> = {}): PoolAccountChannelView {
  return {
    n: 1,
    label: "acc-1",
    email: "acc1@example.com",
    state: "active",
    stateRu: "Активен",
    plan: "plus",
    limitedUntil: null,
    lastOk: 1700000000,
    windows: {
      primary: { usedPct: 20, windowMin: 300, resetsAt: 1700018000 },
      secondary: { usedPct: 15, windowMin: 10080, resetsAt: 1700600000 },
    },
    isBanned: false,
    isExhausted: false,
    ...overrides,
  };
}

describe("myrmidon(1.6.6 OPE-7198) evaluateAccountSignals", () => {
  beforeEach(() => {
    clearPoolAccountSignals();
  });

  it("produces no signals for active, healthy accounts", () => {
    const channels = [makeChannel({ n: 1 }), makeChannel({ n: 2, label: "acc-2" })];
    const signals = evaluateAccountSignals(COMPANY_ID, channels);
    expect(signals).toHaveLength(0);
  });

  it("produces a high-severity signal when an account is banned / token expired", () => {
    const fixedDate = new Date("2026-10-14T10:00:00Z");
    const channels = [
      makeChannel({
        n: 3,
        label: "acc-banned",
        state: "token_expired",
        stateRu: "Токен истёк",
        isBanned: true,
      }),
    ];
    const signals = evaluateAccountSignals(COMPANY_ID, channels, fixedDate);
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.accountNumber).toBe(3);
    expect(s.kind).toBe("banned");
    expect(s.severity).toBe("high");
    expect(s.dedupKey).toBe(codexPoolBannedDedupKey(COMPANY_ID, 3));
    expect(s.title).toContain("banned / token expired");
    expect(s.whyNow).toContain("token_expired");
    expect(s.resetsAt).toBeNull();
    expect(s.activityAt).toBe("2026-10-14T10:00:00.000Z");
  });

  it("produces a medium-severity signal when an account quota is exhausted", () => {
    const fixedDate = new Date("2026-10-14T10:00:00Z");
    const resetTime = 1700020000;
    const channels = [
      makeChannel({
        n: 4,
        label: "acc-limited",
        state: "rate_limited",
        stateRu: "Лимит исчерпан",
        isExhausted: true,
        limitedUntil: resetTime,
        windows: {
          primary: { usedPct: 100, windowMin: 300, resetsAt: resetTime },
          secondary: null,
        },
      }),
    ];
    const signals = evaluateAccountSignals(COMPANY_ID, channels, fixedDate);
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.accountNumber).toBe(4);
    expect(s.kind).toBe("exhausted");
    expect(s.severity).toBe("medium");
    expect(s.dedupKey).toBe(codexPoolExhaustedDedupKey(COMPANY_ID, 4, resetTime));
    expect(s.title).toContain("quota exhausted");
    expect(s.whyNow).toContain("100% quota");
    expect(s.resetsAt).toBe(resetTime);
    expect(s.activityAt).toBe("2026-10-14T10:00:00.000Z");
  });

  it("prioritizes banned signal over exhaustion if both flags are true", () => {
    const channels = [
      makeChannel({
        n: 5,
        label: "acc-both",
        isBanned: true,
        isExhausted: true,
      }),
    ];
    const signals = evaluateAccountSignals(COMPANY_ID, channels);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("banned");
  });
});

describe("myrmidon(1.6.6 OPE-7198) pool account signals in-memory registry", () => {
  beforeEach(() => {
    clearPoolAccountSignals();
  });

  it("records and reads signals scoped to companyId", () => {
    expect(readPoolAccountSignals(COMPANY_ID)).toEqual([]);

    const signals = evaluateAccountSignals(COMPANY_ID, [
      makeChannel({ n: 1, isBanned: true }),
    ]);
    recordPoolAccountSignals(COMPANY_ID, signals);

    expect(readPoolAccountSignals(COMPANY_ID)).toEqual(signals);
    expect(readPoolAccountSignals("other-company")).toEqual([]);

    // Clear specific company
    clearPoolAccountSignals(COMPANY_ID);
    expect(readPoolAccountSignals(COMPANY_ID)).toEqual([]);
  });

  it("clears company signals when recording empty array", () => {
    const signals = evaluateAccountSignals(COMPANY_ID, [
      makeChannel({ n: 1, isBanned: true }),
    ]);
    recordPoolAccountSignals(COMPANY_ID, signals);
    expect(readPoolAccountSignals(COMPANY_ID)).toHaveLength(1);

    recordPoolAccountSignals(COMPANY_ID, []);
    expect(readPoolAccountSignals(COMPANY_ID)).toHaveLength(0);
  });
});

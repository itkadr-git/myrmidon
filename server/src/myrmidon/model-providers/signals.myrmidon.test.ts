// server/src/myrmidon/model-providers/signals.myrmidon.test.ts
//
// myrmidon(1.6.6 OPE-7198): unit tests for Codex / ChatGPT subscription pool
// role notification signals, multi-provider isolation, rolling window calculations,
// and in-memory registry.

import { beforeEach, describe, expect, it } from "vitest";
import type { PoolAccountChannelView } from "@myrmidon/shared";
import {
  clearPoolAccountSignals,
  codexPoolBannedDedupKey,
  codexPoolExhaustedDedupKey,
  evaluateAccountSignals,
  readPoolAccountSignals,
  readProviderPoolAccountSignals,
  recordPoolAccountSignals,
  reportPoolAccountStatus,
} from "./signals.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_1 = "11111111-1111-4111-8111-111111111111";
const PROVIDER_2 = "33333333-3333-4333-8333-333333333333";

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
    const signals = evaluateAccountSignals(COMPANY_ID, PROVIDER_1, channels);
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
    const signals = evaluateAccountSignals(COMPANY_ID, PROVIDER_1, channels, fixedDate);
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.accountNumber).toBe(3);
    expect(s.providerId).toBe(PROVIDER_1);
    expect(s.kind).toBe("banned");
    expect(s.severity).toBe("high");
    expect(s.dedupKey).toBe(codexPoolBannedDedupKey(COMPANY_ID, PROVIDER_1, 3));
    expect(s.title).toContain("banned / token expired");
    expect(s.whyNow).toContain("token_expired");
    expect(s.resetsAt).toBeNull();
    expect(s.activityAt).toBe("2026-10-14T10:00:00.000Z");
  });

  it("produces a medium-severity signal for 5-hour primary window exhaustion", () => {
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
          secondary: { usedPct: 40, windowMin: 10080, resetsAt: 1700600000 },
        },
      }),
    ];
    const signals = evaluateAccountSignals(COMPANY_ID, PROVIDER_1, channels, fixedDate);
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.accountNumber).toBe(4);
    expect(s.providerId).toBe(PROVIDER_1);
    expect(s.kind).toBe("exhausted");
    expect(s.severity).toBe("medium");
    expect(s.dedupKey).toBe(codexPoolExhaustedDedupKey(COMPANY_ID, PROVIDER_1, 4, resetTime));
    expect(s.title).toContain("quota exhausted");
    expect(s.whyNow).toContain("100% quota (5-hour window)");
    expect(s.resetsAt).toBe(resetTime);
    expect(s.activityAt).toBe("2026-10-14T10:00:00.000Z");
  });

  it("produces a signal and selects weekly reset for weekly-only window exhaustion", () => {
    const fixedDate = new Date("2026-10-14T10:00:00Z");
    const weeklyReset = 1700600000;
    const channels = [
      makeChannel({
        n: 7,
        label: "acc-weekly-exhausted",
        state: "rate_limited",
        stateRu: "Лимит исчерпан",
        isExhausted: true,
        limitedUntil: null,
        windows: {
          primary: { usedPct: 15, windowMin: 300, resetsAt: 1700010000 },
          secondary: { usedPct: 100, windowMin: 10080, resetsAt: weeklyReset },
        },
      }),
    ];
    const signals = evaluateAccountSignals(COMPANY_ID, PROVIDER_1, channels, fixedDate);
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.accountNumber).toBe(7);
    expect(s.providerId).toBe(PROVIDER_1);
    expect(s.kind).toBe("exhausted");
    expect(s.resetsAt).toBe(weeklyReset);
    expect(s.dedupKey).toBe(codexPoolExhaustedDedupKey(COMPANY_ID, PROVIDER_1, 7, weeklyReset));
    expect(s.whyNow).toContain("weekly window");
  });

  it("selects the later blocking reset when both windows are exhausted", () => {
    const primaryReset = 1700010000;
    const weeklyReset = 1700600000; // later
    const channels = [
      makeChannel({
        n: 8,
        label: "acc-both-exhausted",
        isExhausted: true,
        windows: {
          primary: { usedPct: 100, windowMin: 300, resetsAt: primaryReset },
          secondary: { usedPct: 100, windowMin: 10080, resetsAt: weeklyReset },
        },
      }),
    ];
    const signals = evaluateAccountSignals(COMPANY_ID, PROVIDER_1, channels);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.resetsAt).toBe(weeklyReset);
    expect(signals[0]!.whyNow).toContain("both 5-hour and weekly windows");
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
    const signals = evaluateAccountSignals(COMPANY_ID, PROVIDER_1, channels);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("banned");
  });
});

describe("myrmidon(1.6.6 OPE-7198) pool account signals in-memory registry & multi-provider isolation", () => {
  beforeEach(() => {
    clearPoolAccountSignals();
  });

  it("records and reads signals scoped to companyId and providerId without cross-pollution", () => {
    expect(readPoolAccountSignals(COMPANY_ID)).toEqual([]);

    const signals1 = evaluateAccountSignals(COMPANY_ID, PROVIDER_1, [
      makeChannel({ n: 1, isBanned: true }),
    ]);
    recordPoolAccountSignals(COMPANY_ID, PROVIDER_1, signals1);

    // Polling Provider 2 with healthy accounts (signals2 = []) must NOT clear Provider 1!
    recordPoolAccountSignals(COMPANY_ID, PROVIDER_2, []);

    expect(readProviderPoolAccountSignals(COMPANY_ID, PROVIDER_1)).toEqual(signals1);
    expect(readProviderPoolAccountSignals(COMPANY_ID, PROVIDER_2)).toEqual([]);
    expect(readPoolAccountSignals(COMPANY_ID)).toEqual(signals1);
    expect(readPoolAccountSignals("other-company")).toEqual([]);

    // Now Provider 2 has an exhausted account
    const signals2 = evaluateAccountSignals(COMPANY_ID, PROVIDER_2, [
      makeChannel({ n: 2, isExhausted: true, windows: { primary: { usedPct: 100, windowMin: 300, resetsAt: 1700010000 }, secondary: null } }),
    ]);
    recordPoolAccountSignals(COMPANY_ID, PROVIDER_2, signals2);

    // Aggregated read returns both
    const aggregated = readPoolAccountSignals(COMPANY_ID);
    expect(aggregated).toHaveLength(2);
    expect(aggregated.some((s) => s.providerId === PROVIDER_1)).toBe(true);
    expect(aggregated.some((s) => s.providerId === PROVIDER_2)).toBe(true);

    // Clear specific provider
    clearPoolAccountSignals(COMPANY_ID, PROVIDER_1);
    expect(readPoolAccountSignals(COMPANY_ID)).toEqual(signals2);

    // Clear whole company
    clearPoolAccountSignals(COMPANY_ID);
    expect(readPoolAccountSignals(COMPANY_ID)).toEqual([]);
  });

  it("handles event reporting via reportPoolAccountStatus", () => {
    const bannedAccount = makeChannel({ n: 10, label: "event-acc", isBanned: true, state: "token_expired" });
    const signal = reportPoolAccountStatus({
      companyId: COMPANY_ID,
      providerId: PROVIDER_1,
      account: bannedAccount,
    });
    expect(signal).not.toBeNull();
    expect(signal!.accountNumber).toBe(10);
    expect(readPoolAccountSignals(COMPANY_ID)).toHaveLength(1);

    // Account recovers (active)
    const activeAccount = makeChannel({ n: 10, label: "event-acc", isBanned: false, isExhausted: false, state: "active" });
    const cleared = reportPoolAccountStatus({
      companyId: COMPANY_ID,
      providerId: PROVIDER_1,
      account: activeAccount,
    });
    expect(cleared).toBeNull();
    expect(readPoolAccountSignals(COMPANY_ID)).toHaveLength(0);
  });
});

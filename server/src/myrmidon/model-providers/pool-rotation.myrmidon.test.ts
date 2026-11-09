// server/src/myrmidon/model-providers/pool-rotation.myrmidon.test.ts
//
// Tests for myrmidon(1.6.6 OPE-10775): account rotation, sliding window exhaustion,
// and automatic role signals when accounts are banned or exhausted.

import { describe, it, expect, beforeEach } from "vitest";
import {
  isAccountEligibleForRotation,
  selectActivePoolAccount,
} from "./pool-rotation.js";
import { evaluateAccountSignals, clearPoolAccountSignals } from "./signals.js";
import type { PoolAccountChannelView } from "@myrmidon/shared";

describe("myrmidon(1.6.6 OPE-10775) pool rotation and limit windows", () => {
  const companyId = "comp-rot-test";
  const providerId = "prov-rot-test";
  const nowUnix = 1730000000;

  beforeEach(() => {
    clearPoolAccountSignals(companyId, providerId);
  });

  function makeAccount(
    n: number,
    label: string,
    overrides?: Partial<PoolAccountChannelView>,
  ): PoolAccountChannelView {
    return {
      n,
      label,
      email: `${label}@example.com`,
      plan: "plus",
      state: "active",
      stateRu: "Активен",
      models: ["gpt-4o", "o1-preview"],
      isBanned: false,
      isExhausted: false,
      limitedUntil: null,
      lastOk: nowUnix - 60,
      error: null,
      windows: {
        primary: {
          usedPct: 10,
          windowMin: 300, // 5 hours
          resetsAt: nowUnix + 10000,
          limitReached: false,
        },
        secondary: {
          usedPct: 20,
          windowMin: 10080, // 1 week
          resetsAt: nowUnix + 500000,
          limitReached: false,
        },
      },
      ...overrides,
    };
  }

  describe("eligibility and rotation", () => {
    it("selects the least loaded account among active accounts", () => {
      const acc1 = makeAccount(1, "acc-1", {
        windows: {
          primary: { usedPct: 50, windowMin: 300, resetsAt: nowUnix + 1000, limitReached: false },
          secondary: { usedPct: 60, windowMin: 10080, resetsAt: nowUnix + 10000, limitReached: false },
        },
      });
      const acc2 = makeAccount(2, "acc-2", {
        windows: {
          primary: { usedPct: 20, windowMin: 300, resetsAt: nowUnix + 1000, limitReached: false },
          secondary: { usedPct: 30, windowMin: 10080, resetsAt: nowUnix + 10000, limitReached: false },
        },
      });

      const selected = selectActivePoolAccount([acc1, acc2], { nowUnix });
      expect(selected?.n).toBe(2);
    });

    it("automatically removes banned account from rotation and emits high severity signal", () => {
      const acc1 = makeAccount(1, "banned-acc", {
        isBanned: true,
        state: "token_expired",
      });
      const acc2 = makeAccount(2, "healthy-acc");

      expect(isAccountEligibleForRotation(acc1, nowUnix)).toBe(false);
      expect(isAccountEligibleForRotation(acc2, nowUnix)).toBe(true);

      const selected = selectActivePoolAccount([acc1, acc2], { nowUnix });
      expect(selected?.n).toBe(2);

      const signals = evaluateAccountSignals(companyId, providerId, [acc1, acc2], nowUnix);
      expect(signals).toHaveLength(1);
      expect(signals[0].signalKind).toBe("banned");
      expect(signals[0].severity).toBe("high");
      expect(signals[0].accountNumber).toBe(1);
    });

    it("switches rotation to available account when 5-hour window limit is exhausted", () => {
      // Account 1 exhausted its 5h sliding window (usedPct = 100, limitReached = true)
      const acc1 = makeAccount(1, "5h-exhausted-acc", {
        isExhausted: true,
        windows: {
          primary: {
            usedPct: 100,
            windowMin: 300,
            resetsAt: nowUnix + 3600,
            limitReached: true,
          },
          secondary: {
            usedPct: 40,
            windowMin: 10080,
            resetsAt: nowUnix + 100000,
            limitReached: false,
          },
        },
      });

      // Account 2 has available capacity in both windows
      const acc2 = makeAccount(2, "available-acc", {
        windows: {
          primary: {
            usedPct: 15,
            windowMin: 300,
            resetsAt: nowUnix + 3600,
            limitReached: false,
          },
          secondary: {
            usedPct: 25,
            windowMin: 10080,
            resetsAt: nowUnix + 100000,
            limitReached: false,
          },
        },
      });

      expect(isAccountEligibleForRotation(acc1, nowUnix)).toBe(false);
      expect(isAccountEligibleForRotation(acc2, nowUnix)).toBe(true);

      // Rotation automatically selects Account 2
      const selected = selectActivePoolAccount([acc1, acc2], { nowUnix });
      expect(selected?.n).toBe(2);

      // Role signal is generated for the exhausted account
      const signals = evaluateAccountSignals(companyId, providerId, [acc1, acc2], nowUnix);
      expect(signals).toHaveLength(1);
      expect(signals[0].signalKind).toBe("exhausted");
      expect(signals[0].severity).toBe("medium");
      expect(signals[0].accountNumber).toBe(1);
    });

    it("switches rotation to available account when weekly window limit is exhausted", () => {
      // Account 1 exhausted its 7-day sliding window
      const acc1 = makeAccount(1, "weekly-exhausted-acc", {
        windows: {
          primary: {
            usedPct: 10,
            windowMin: 300,
            resetsAt: nowUnix + 3600,
            limitReached: false,
          },
          secondary: {
            usedPct: 100,
            windowMin: 10080,
            resetsAt: nowUnix + 86400,
            limitReached: true,
          },
        },
      });

      const acc2 = makeAccount(2, "available-acc-2");

      expect(isAccountEligibleForRotation(acc1, nowUnix)).toBe(false);
      expect(isAccountEligibleForRotation(acc2, nowUnix)).toBe(true);

      const selected = selectActivePoolAccount([acc1, acc2], { nowUnix });
      expect(selected?.n).toBe(2);
    });

    it("returns null when all accounts in the pool are exhausted or banned", () => {
      const acc1 = makeAccount(1, "exhausted-1", { isExhausted: true });
      const acc2 = makeAccount(2, "banned-2", { isBanned: true });

      const selected = selectActivePoolAccount([acc1, acc2], { nowUnix });
      expect(selected).toBeNull();
    });
  });
});

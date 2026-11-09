// server/src/myrmidon/model-providers/pool-registry.myrmidon.test.ts
//
// Tests for myrmidon(1.6.6 OPE-10775): Codex / ChatGPT pool accounts registry,
// plan types (Plus, Pro, K-12), 5h / weekly sliding windows, and OAuth lifecycle.

import { describe, it, expect, beforeEach } from "vitest";
import {
  clearPoolRegistry,
  getRegisteredPoolAccounts,
  registerPoolAccount,
  deleteRegisteredPoolAccount,
  updatePoolAccountUsage,
  startCodexOAuth,
  completeCodexOAuth,
} from "./pool-registry.js";
import {
  CODEX_PRIMARY_WINDOW_MIN,
  CODEX_SECONDARY_WINDOW_MIN,
  formatPoolAccountPlanLabel,
  normalizePoolAccountPlan,
} from "@myrmidon/shared";

describe("myrmidon(1.6.6 OPE-10775) Codex pool accounts registry", () => {
  const companyId = "comp-ope-10775";
  const providerId = "prov-ope-10775";

  beforeEach(() => {
    clearPoolRegistry(companyId, providerId);
  });

  describe("account plan normalization and formatting", () => {
    it("normalizes and formats Plus, Pro, and K-12 plans correctly", () => {
      expect(normalizePoolAccountPlan("plus")).toBe("plus");
      expect(normalizePoolAccountPlan("Plus")).toBe("plus");
      expect(normalizePoolAccountPlan("pro")).toBe("pro");
      expect(normalizePoolAccountPlan("Pro")).toBe("pro");
      expect(normalizePoolAccountPlan("k12")).toBe("k12");
      expect(normalizePoolAccountPlan("K-12")).toBe("k12");
      expect(normalizePoolAccountPlan(null)).toBe("plus");

      expect(formatPoolAccountPlanLabel("plus")).toBe("Plus");
      expect(formatPoolAccountPlanLabel("pro")).toBe("Pro");
      expect(formatPoolAccountPlanLabel("k12")).toBe("K-12");
      expect(formatPoolAccountPlanLabel("k-12")).toBe("K-12");
    });
  });

  describe("account persistence and deletion", () => {
    it("registers accounts with Plus, Pro, K-12 plans and tracks default sliding windows", () => {
      const acc1 = registerPoolAccount(companyId, providerId, {
        label: "acc-plus",
        plan: "Plus",
        email: "plus@example.com",
      });

      const acc2 = registerPoolAccount(companyId, providerId, {
        label: "acc-pro",
        plan: "Pro",
        email: "pro@example.com",
      });

      const acc3 = registerPoolAccount(companyId, providerId, {
        label: "acc-k12",
        plan: "K-12",
        email: "k12@example.com",
      });

      expect(acc1.n).toBe(1);
      expect(acc1.plan).toBe("plus");
      expect(acc1.windows.primary?.windowMin).toBe(CODEX_PRIMARY_WINDOW_MIN); // 300 min (5h)
      expect(acc1.windows.secondary?.windowMin).toBe(CODEX_SECONDARY_WINDOW_MIN); // 10080 min (1 week)
      expect(acc1.state).toBe("active");
      expect(acc1.isBanned).toBe(false);
      expect(acc1.isExhausted).toBe(false);

      expect(acc2.n).toBe(2);
      expect(acc2.plan).toBe("pro");

      expect(acc3.n).toBe(3);
      expect(acc3.plan).toBe("k12");

      const all = getRegisteredPoolAccounts(companyId, providerId);
      expect(all).toHaveLength(3);
      expect(all.map((a) => a.plan)).toEqual(["plus", "pro", "k12"]);
    });

    it("deletes an account from the pool by account number", () => {
      registerPoolAccount(companyId, providerId, { label: "to-keep-1" });
      registerPoolAccount(companyId, providerId, { label: "to-delete" });
      registerPoolAccount(companyId, providerId, { label: "to-keep-2" });

      expect(getRegisteredPoolAccounts(companyId, providerId)).toHaveLength(3);

      const deleted = deleteRegisteredPoolAccount(companyId, providerId, 2);
      expect(deleted).toBe(true);

      const remaining = getRegisteredPoolAccounts(companyId, providerId);
      expect(remaining).toHaveLength(2);
      expect(remaining.map((a) => a.n)).toEqual([1, 3]);
    });
  });

  describe("sliding windows updates and automatic exhaustion", () => {
    it("updates 5-hour window usage and automatically flags isExhausted at 100%", () => {
      registerPoolAccount(companyId, providerId, { label: "exhaust-test" });

      const updated = updatePoolAccountUsage(companyId, providerId, 1, {
        primaryWindow: {
          usedPct: 100,
          limitReached: true,
          resetsAt: Math.floor(Date.now() / 1000) + 3600,
        },
      });

      expect(updated).not.toBeNull();
      expect(updated!.windows.primary?.usedPct).toBe(100);
      expect(updated!.windows.primary?.limitReached).toBe(true);
      expect(updated!.isExhausted).toBe(true);
    });

    it("updates weekly window usage and flags isExhausted when weekly limit is reached", () => {
      registerPoolAccount(companyId, providerId, { label: "weekly-exhaust-test" });

      const updated = updatePoolAccountUsage(companyId, providerId, 1, {
        secondaryWindow: {
          usedPct: 100,
          limitReached: true,
          resetsAt: Math.floor(Date.now() / 1000) + 86400,
        },
      });

      expect(updated).not.toBeNull();
      expect(updated!.windows.secondary?.usedPct).toBe(100);
      expect(updated!.isExhausted).toBe(true);
    });
  });

  describe("OAuth flow lifecycle", () => {
    it("starts and completes Codex OAuth flow, persisting account with plan and windows", () => {
      const oauthStart = startCodexOAuth(companyId, providerId, {
        plan: "Pro",
        label: "oauth-codex-pro",
      });

      expect(oauthStart.state).toBeDefined();
      expect(oauthStart.authUrl).toContain("openai.com");
      expect(oauthStart.userCode).toBeDefined();

      const account = completeCodexOAuth(companyId, providerId, {
        state: oauthStart.state,
        plan: "Pro",
        label: "oauth-codex-pro",
        email: "codex-pro@team.internal",
      });

      expect(account.n).toBe(1);
      expect(account.label).toBe("oauth-codex-pro");
      expect(account.plan).toBe("pro");
      expect(account.email).toBe("codex-pro@team.internal");
      expect(account.windows.primary?.windowMin).toBe(300);
      expect(account.windows.secondary?.windowMin).toBe(10080);
      expect(account.state).toBe("active");

      const inRegistry = getRegisteredPoolAccounts(companyId, providerId);
      expect(inRegistry).toHaveLength(1);
      expect(inRegistry[0].plan).toBe("pro");
    });
  });
});

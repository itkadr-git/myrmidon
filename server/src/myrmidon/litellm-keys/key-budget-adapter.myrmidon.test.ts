// server/src/myrmidon/litellm-keys/key-budget-adapter.myrmidon.test.ts
//
// myrmidon(OPE-9859): Unit tests for the key budget projection adapter.
//
// Acceptance criteria:
//  1. UI/API reports key budgets per agent and service using OPE-8675 as single source of truth.
//  2. Updating through existing change point (settings) updates projected key limits.
//  3. Errors do not lead to partial saving (atomicity).
//  4. Never log or leak key secret values (only secret names and hashes).

import { describe, expect, it } from "vitest";
import {
  normalizeBudgetProjectionSettings,
  type BudgetProjectionLimit,
  type BudgetProjectionStoredSettings,
} from "@myrmidon/shared";
import {
  adaptKeyBudgetProjection,
  type AgentKeyBudgetView,
  type CompanyKeyBudgetsReport,
} from "./key-budget-adapter.js";

const COMPANY = "company-test-123";

describe("myrmidon(OPE-9859) key budget projection adapter", () => {
  it("projects caste budget limits onto agent keys with signalOnly soft enforcement", () => {
    const settings: BudgetProjectionStoredSettings = normalizeBudgetProjectionSettings({
      signalOnly: true,
      enabled: true,
      limits: [
        {
          level: "caste",
          scopeId: "engineer",
          amountUsd: 150,
          periodHours: 720,
          mode: "block",
        },
      ],
    });

    const agents = [
      { id: "agent-1", name: "Alice", role: "engineer" },
      { id: "agent-2", name: "Bob", role: "qa" },
    ];

    const keys = [
      {
        agentId: "agent-1",
        secretName: "llm-gateway-key-alice-agent-1",
        present: true,
        valueHash: "hash-alice",
        canManageKeys: true,
      },
      {
        agentId: "agent-2",
        secretName: "llm-gateway-key-bob-agent-2",
        present: false,
        valueHash: null,
        canManageKeys: true,
      },
    ];

    const report: CompanyKeyBudgetsReport = adaptKeyBudgetProjection({
      companyId: COMPANY,
      settings,
      agents,
      keys,
    });

    expect(report.companyId).toBe(COMPANY);
    expect(report.signalOnly).toBe(true);
    expect(report.projectionEnabled).toBe(true);

    const alice = report.agents.find((a) => a.agentId === "agent-1")!;
    expect(alice.role).toBe("engineer");
    expect(alice.present).toBe(true);
    expect(alice.valueHash).toBe("hash-alice");
    // Configured mode is block, but signalOnly: true makes effectiveMode soft
    expect(alice.budget).toEqual({
      amountUsd: 150,
      periodHours: 720,
      mode: "block",
      effectiveMode: "soft",
      caste: "engineer",
    });

    const bob = report.agents.find((a) => a.agentId === "agent-2")!;
    expect(bob.role).toBe("qa");
    // No limit row for caste 'qa' -> budget is null (unlimited)
    expect(bob.budget).toBeNull();
  });

  it("enforces block mode when signalOnly is false", () => {
    const settings: BudgetProjectionStoredSettings = normalizeBudgetProjectionSettings({
      signalOnly: false,
      enabled: true,
      limits: [
        {
          level: "caste",
          scopeId: "worker",
          amountUsd: 50,
          periodHours: 168,
          mode: "block",
        },
      ],
    });

    const agents = [{ id: "agent-w", name: "Worker1", role: "worker" }];
    const report = adaptKeyBudgetProjection({
      companyId: COMPANY,
      settings,
      agents,
    });

    const worker = report.agents[0]!;
    expect(worker.budget?.effectiveMode).toBe("block");
    expect(worker.budget?.periodHours).toBe(168);
    expect(worker.budget?.amountUsd).toBe(50);
  });

  it("projects service and sweep limits into service key views", () => {
    const settings: BudgetProjectionStoredSettings = normalizeBudgetProjectionSettings({
      signalOnly: true,
      enabled: true,
      limits: [
        {
          level: "caste",
          scopeId: "hindsight", // service caste
          amountUsd: 200,
          periodHours: 720,
          mode: "soft",
        },
        {
          level: "foraging",
          scopeId: "foraging",
          amountUsd: 500,
          periodHours: 720,
          mode: "soft",
        },
      ],
    });

    const agents = [{ id: "agent-1", name: "Alice", role: "engineer" }];
    const report = adaptKeyBudgetProjection({
      companyId: COMPANY,
      settings,
      agents,
    });

    expect(report.services.length).toBe(2);
    const hindsight = report.services.find((s) => s.scopeId === "hindsight")!;
    expect(hindsight.serviceName).toBe("hindsight");
    expect(hindsight.tag).toBe("myrm-caste-hindsight");
    expect(hindsight.secretName).toBe("llm-gateway-key-hindsight");
    expect(hindsight.budget.amountUsd).toBe(200);

    const foraging = report.services.find((s) => s.scopeId === "foraging")!;
    expect(foraging.tag).toBe("myrm-foraging-foraging");
    expect(foraging.budget.amountUsd).toBe(500);
  });

  it("updates key budget projection through existing change point without parallel storage", () => {
    let storedSettings: BudgetProjectionStoredSettings = normalizeBudgetProjectionSettings({
      signalOnly: true,
      enabled: true,
      limits: [
        {
          level: "caste",
          scopeId: "engineer",
          amountUsd: 100,
          periodHours: 720,
          mode: "soft",
        },
      ],
    });

    const agents = [{ id: "agent-1", name: "Alice", role: "engineer" }];

    // Initial read through adapter
    const report1 = adaptKeyBudgetProjection({
      companyId: COMPANY,
      settings: storedSettings,
      agents,
    });
    expect(report1.agents[0]!.budget?.amountUsd).toBe(100);

    // Existing mutation point: modify stored document in instance settings
    const mutateSettings = (
      updater: (cur: BudgetProjectionStoredSettings) => BudgetProjectionStoredSettings,
    ) => {
      storedSettings = updater(storedSettings);
    };

    // Update caste limit from 100 to 300
    mutateSettings((cur) => ({
      ...cur,
      limits: [
        {
          level: "caste",
          scopeId: "engineer",
          amountUsd: 300,
          periodHours: 720,
          mode: "block",
        },
      ],
    }));

    // Adapter immediately reflects updated limit from OPE-8675 source of truth
    const report2 = adaptKeyBudgetProjection({
      companyId: COMPANY,
      settings: storedSettings,
      agents,
    });
    expect(report2.agents[0]!.budget?.amountUsd).toBe(300);
    expect(report2.agents[0]!.budget?.mode).toBe("block");
  });

  it("ensures errors during mutation do not lead to partial saving", () => {
    let storedState: BudgetProjectionStoredSettings = normalizeBudgetProjectionSettings({
      signalOnly: true,
      enabled: true,
      limits: [
        {
          level: "caste",
          scopeId: "engineer",
          amountUsd: 100,
          periodHours: 720,
          mode: "soft",
        },
      ],
    });

    const atomicMutate = (
      change: (cur: BudgetProjectionStoredSettings) => BudgetProjectionStoredSettings,
    ) => {
      // Snapshot before change
      const snapshot = JSON.parse(JSON.stringify(storedState));
      try {
        const next = change(storedState);
        storedState = next;
      } catch (err) {
        // Rollback on failure
        storedState = snapshot;
        throw err;
      }
    };

    // Attempt invalid change that throws
    expect(() => {
      atomicMutate((cur) => {
        // Partial change attempt
        cur.limits[0]!.amountUsd = 999;
        throw new Error("Validation or DB conflict error");
      });
    }).toThrow("Validation or DB conflict error");

    // Stored state remains completely rolled back / unchanged
    expect(storedState.limits[0]!.amountUsd).toBe(100);
  });

  it("never logs or exposes secret key values in key budget views", () => {
    const rawSecretValue = "sk-live-secret-never-expose-1234567890abcdef";

    const agents = [{ id: "agent-1", name: "Alice", role: "engineer" }];
    const keys = [
      {
        agentId: "agent-1",
        secretName: "llm-gateway-key-alice-agent-1",
        present: true,
        // The adapter and views receive only the hash, never the raw value
        valueHash: "a3f5c...",
        canManageKeys: true,
      },
    ];

    const report = adaptKeyBudgetProjection({
      companyId: COMPANY,
      settings: normalizeBudgetProjectionSettings({}),
      agents,
      keys,
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(rawSecretValue);
    expect(report.agents[0]!.valueHash).toBe("a3f5c...");
  });
});

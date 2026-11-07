import { describe, expect, it, vi } from "vitest";
import {
  isK12Plan,
  modelProviderAccountSecretName,
  modelProviderSecretName,
  type PoolAccountChannelView,
} from "@myrmidon/shared";
import { createModelProviderService } from "./service.js";
import {
  clearPoolAccountSignals,
  evaluateAccountSignals,
} from "./signals.js";

describe("myrmidon(1.6.6 OPE-10810) Codex OAuth pool accounts, limit windows and K-12 tariff", () => {
  describe("isK12Plan helper", () => {
    it("recognizes K-12 tariff variants and normalizes case", () => {
      expect(isK12Plan("k-12")).toBe(true);
      expect(isK12Plan("k12")).toBe(true);
      expect(isK12Plan("K-12")).toBe(true);
      expect(isK12Plan("K12")).toBe(true);
      expect(isK12Plan("  k-12  ")).toBe(true);
    });

    it("rejects non-K-12 plans, null, and empty inputs", () => {
      expect(isK12Plan("plus")).toBe(false);
      expect(isK12Plan("pro")).toBe(false);
      expect(isK12Plan("team")).toBe(false);
      expect(isK12Plan("free")).toBe(false);
      expect(isK12Plan(null)).toBe(false);
      expect(isK12Plan(undefined)).toBe(false);
      expect(isK12Plan("")).toBe(false);
    });
  });

  describe("modelProviderAccountSecretName", () => {
    it("derives safe namespaced secret name under provider secret prefix", () => {
      const secretName = modelProviderAccountSecretName("prov-123", 4);
      expect(secretName).toBe(`${modelProviderSecretName("prov-123")}/accounts/4`);
      expect(secretName).toBe("model-provider-key-prov-123/accounts/4");
    });
  });

  describe("Pool account channels, limit windows (5h/7d) and K-12 disabling", () => {
    function createServiceWithCatalog(accounts: any[]) {
      const mockSecrets = {
        readSecretValue: vi.fn().mockResolvedValue("test-key"),
        findSecretId: vi.fn().mockResolvedValue("sec-1"),
        createSecret: vi.fn().mockResolvedValue("sec-created"),
        rotateSecret: vi.fn().mockResolvedValue(undefined),
        deleteSecret: vi.fn().mockResolvedValue(undefined),
        restoreSecret: vi.fn().mockResolvedValue(undefined),
      };

      const mockProvider = {
        id: "prov-pool",
        companyId: "company-1",
        type: "chatgpt-pool",
        name: "ChatGPT Codex Pool",
        baseUrl: "http://localhost:8895",
        free: false,
        credentialSecretName: "model-provider-key-prov-pool",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([mockProvider]),
            })),
          })),
        })),
        findProviderById: vi.fn().mockResolvedValue(mockProvider),
        listProvidersByCompany: vi.fn().mockResolvedValue([]),
        createProvider: vi.fn(),
        updateProvider: vi.fn(),
        deleteProvider: vi.fn(),
        listModelConfigs: vi.fn().mockResolvedValue([]),
        upsertModelConfigs: vi.fn(),
      };

      const mockCatalog = {
        listModels: vi.fn().mockResolvedValue({ models: [] }),
        listAccounts: vi.fn().mockResolvedValue({ accounts }),
      };

      const service = createModelProviderService({
        db: mockDb as any,
        secrets: mockSecrets as any,
        catalog: mockCatalog,
      });

      return { service, mockSecrets, mockCatalog };
    }

    it("excludes K-12 accounts from live pool rotation and counts them as disabled", async () => {
      const rawAccounts = [
        {
          account_number: 1,
          label: "Account Plus #1",
          plan: "plus",
          state: "active",
          p_used: 25,
          p_reset_at: 1700018000,
        },
        {
          account_number: 2,
          label: "Account Pro #2",
          plan: "pro",
          state: "active",
          p_used: 10,
          p_reset_at: 1700018000,
        },
        {
          account_number: 3,
          label: "Account K-12 #3 (Disabled)",
          plan: "k-12",
          state: "active",
        },
        {
          account_number: 4,
          label: "Account Plus Exhausted #4",
          plan: "plus",
          state: "rate_limited",
          p_used: 100,
          p_reset_at: 1700018000,
        },
        {
          account_number: 5,
          label: "Account Banned #5",
          plan: "plus",
          state: "banned",
        },
      ];

      const { service } = createServiceWithCatalog(rawAccounts);
      const res = await service.listChannels("company-1", "prov-pool");

      expect(res.channels).toHaveLength(5);

      const k12Channel = res.channels.find((ch) => ch.n === 3);
      expect(k12Channel).toBeDefined();
      expect(k12Channel?.isDisabled).toBe(true);
      expect(k12Channel?.isExcluded).toBe(true);
      expect(k12Channel?.stateRu).toBe("Отключен (K-12)");

      const exhaustedChannel = res.channels.find((ch) => ch.n === 4);
      expect(exhaustedChannel?.isExhausted).toBe(true);
      expect(exhaustedChannel?.isExcluded).toBe(true);

      const bannedChannel = res.channels.find((ch) => ch.n === 5);
      expect(bannedChannel?.isBanned).toBe(true);
      expect(bannedChannel?.isExcluded).toBe(true);

      // Summary verification
      expect(res.summary).toBeDefined();
      expect(res.summary?.total).toBe(5);
      expect(res.summary?.live).toBe(2); // Only #1 and #2 are live!
      expect(res.summary?.disabled).toBe(1); // #3 is K-12 disabled
      expect(res.summary?.exhausted).toBe(1); // #4 is exhausted
      expect(res.summary?.banned).toBe(1); // #5 is banned
    });

    it("maps 5-hour primary and weekly secondary limit windows correctly", async () => {
      const rawAccounts = [
        {
          account_number: 1,
          label: "Account Plus #1",
          plan: "plus",
          state: "active",
          p_used: 45,
          p_reset_at: 1700018000,
          windows: {
            secondary: { used_pct: 30, window_min: 10080, resets_at: 1700600000 },
          },
        },
      ];

      const { service } = createServiceWithCatalog(rawAccounts);
      const res = await service.listChannels("company-1", "prov-pool");

      const ch = res.channels[0];
      expect(ch.windows.primary?.usedPct).toBe(45);
      expect(ch.windows.primary?.windowMin).toBe(300); // 5 hours rolling window
      expect(ch.windows.primary?.resetsAt).toBe(1700018000);

      expect(ch.windows.secondary?.usedPct).toBe(30);
      expect(ch.windows.secondary?.windowMin).toBe(10080); // 7 days weekly window
      expect(ch.windows.secondary?.resetsAt).toBe(1700600000);
      expect(ch.isExhausted).toBe(false);
    });

    it("evaluates signals ignoring disabled accounts", () => {
      const channels = [
        {
          n: 1,
          label: "acc-1",
          state: "disabled" as const,
          stateRu: "Отключен",
          plan: "k12",
          isLive: false,
          isBanned: true,
          isRateLimited: false,
          isExhausted: false,
          isDisabled: true,
          isExcluded: true,
          limitedUntil: null,
          windows: {
            primary: null,
            secondary: null,
          },
        },
      ];
      const signals = evaluateAccountSignals("company-1", "prov-pool", channels as any);
      expect(signals).toHaveLength(0);
    });
  });

  describe("Codex OAuth Lifecycle (begin, status, complete, refresh)", () => {
    function createService() {
      const storedSecrets = new Map<string, string>();
      let secretIdSeq = 1;

      const mockSecrets = {
        readSecretValue: vi.fn(async (_cid: string, name: string) => storedSecrets.get(name) ?? null),
        findSecretId: vi.fn(async (_cid: string, name: string) => {
          return storedSecrets.has(name) ? `sec-${name}` : null;
        }),
        createSecret: vi.fn(async (params: { companyId: string; name: string; value: string }) => {
          const id = `sec-${secretIdSeq++}`;
          storedSecrets.set(params.name, params.value);
          return id;
        }),
        rotateSecret: vi.fn(async (secretId: string, value: string) => {
          for (const [k] of storedSecrets.entries()) {
            if (`sec-${k}` === secretId || secretId.includes(k)) {
              storedSecrets.set(k, value);
            }
          }
        }),
        deleteSecret: vi.fn(),
        restoreSecret: vi.fn().mockResolvedValue(undefined),
      };

      const mockProvider = {
        id: "prov-pool",
        companyId: "company-1",
        type: "chatgpt-pool",
        name: "ChatGPT Codex Pool",
        baseUrl: "http://localhost:8895",
        free: false,
        credentialSecretName: "model-provider-key-prov-pool",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([mockProvider]),
            })),
          })),
        })),
        findProviderById: vi.fn().mockResolvedValue(mockProvider),
        listProvidersByCompany: vi.fn().mockResolvedValue([]),
        createProvider: vi.fn(),
        updateProvider: vi.fn(),
        deleteProvider: vi.fn(),
        listModelConfigs: vi.fn().mockResolvedValue([]),
        upsertModelConfigs: vi.fn(),
      };

      const mockCatalog = {
        listModels: vi.fn().mockResolvedValue({ models: [] }),
        listAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
      };

      const service = createModelProviderService({
        db: mockDb as any,
        secrets: mockSecrets as any,
        catalog: mockCatalog,
      });

      return { service, mockSecrets, storedSecrets };
    }

    it("completes OAuth authorization lifecycle and stores credential in secret store", async () => {
      const { service, mockSecrets, storedSecrets } = createService();

      // 1. Begin OAuth
      const beginResult = await service.oauthBegin("company-1", "prov-pool", {
        accountNumber: 1,
        plan: "plus",
      });

      expect(beginResult.accountNumber).toBe(1);
      expect(beginResult.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(beginResult.verificationUri).toBe("http://localhost:8895/auth/codex/device");
      expect(beginResult.expiresInSec).toBe(900);
      expect(beginResult.intervalSec).toBe(5);

      // 2. Poll Status
      const statusPending = await service.oauthStatus("company-1", "prov-pool", 1);
      expect(statusPending.status).toBe("pending");

      // 3. Complete OAuth
      const completeResult = await service.oauthComplete("company-1", "prov-pool", {
        accountNumber: 1,
        token: "oauth-test-token-12345",
      });
      expect(completeResult.ok).toBe(true);
      expect(completeResult.accountNumber).toBe(1);

      // Verify secret store was called and stores the token
      const expectedSecretName = modelProviderAccountSecretName("prov-pool", 1);
      expect(mockSecrets.createSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          name: expectedSecretName,
          value: "oauth-test-token-12345",
        }),
      );
      expect(storedSecrets.get(expectedSecretName)).toBe("oauth-test-token-12345");

      // 4. Refresh OAuth token
      const refreshResult = await service.oauthRefresh("company-1", "prov-pool", {
        accountNumber: 1,
      });
      expect(refreshResult.ok).toBe(true);
      expect(refreshResult.accountNumber).toBe(1);
      expect(mockSecrets.rotateSecret).toHaveBeenCalled();
    });

    it("rejects OAuth begin for non-pool provider", async () => {
      const { service } = createService();
      // Mock db returning standard openai provider
      const mockOpenaiProvider = {
        id: "prov-openai",
        companyId: "company-1",
        type: "openai",
        name: "OpenAI Direct",
        baseUrl: null,
        free: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([mockOpenaiProvider]),
            })),
          })),
        })),
        findProviderById: vi.fn().mockResolvedValue(mockOpenaiProvider),
      };
      const serviceNonPool = createModelProviderService({
        db: mockDb as any,
        secrets: {
          readSecretValue: vi.fn(),
          findSecretId: vi.fn(),
          createSecret: vi.fn(),
          rotateSecret: vi.fn(),
          deleteSecret: vi.fn(),
          restoreSecret: vi.fn().mockResolvedValue(undefined),
        } as any,
        catalog: { listModels: vi.fn() },
      });

      await expect(serviceNonPool.oauthBegin("company-1", "prov-openai")).rejects.toThrow(
        "This provider does not support pool account OAuth",
      );
    });
  });
});

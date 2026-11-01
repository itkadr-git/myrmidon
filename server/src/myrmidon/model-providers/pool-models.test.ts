// server/src/myrmidon/model-providers/pool-models.test.ts
//
// 1.6.6 OPE-9932: Unit tests for pool model enrichment in agent model selection.

import { describe, expect, it } from "vitest";
import { enrichWithPoolModels, type PoolAccountChannelProvider } from "./pool-models.js";
import type { AdapterModel } from "@myrmidon/adapter-utils";

describe("enrichWithPoolModels (1.6.6 OPE-9932)", () => {
  it("returns base models unchanged when company has no pool providers", async () => {
    const mockDb: any = {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    };
    const baseModels: AdapterModel[] = [
      { id: "gpt-4o", label: "gpt-4o" },
      { id: "claude-3-5-sonnet", label: "claude-3-5-sonnet" },
    ];

    const result = await enrichWithPoolModels(mockDb, "cmp-1", baseModels);
    expect(result).toEqual(baseModels);
  });

  it("enriches existing models and adds new pool models with account labels", async () => {
    const mockDb: any = {
      select: () => ({
        from: () => ({
          where: async () => [
            { id: "prov-1", type: "chatgpt-pool", companyId: "cmp-1" },
          ],
        }),
      }),
    };

    const mockService: PoolAccountChannelProvider = {
      listChannels: async () => ({
        channels: [
          {
            n: 1,
            label: "acc1",
            state: "active",
            isBanned: false,
            isExhausted: false,
            limitedUntil: null,
            lastOk: null,
            windows: { primary: null, secondary: null },
            models: ["gpt-4o", "gemini-2.0-flash"],
          },
          {
            n: 2,
            label: "acc2",
            state: "active",
            isBanned: false,
            isExhausted: false,
            limitedUntil: null,
            lastOk: null,
            windows: { primary: null, secondary: null },
            models: ["gpt-4o", "o3-mini"],
          },
        ],
      }),
    };

    const baseModels: AdapterModel[] = [
      { id: "gpt-4o", label: "GPT-4o", pricing: "paid" },
      { id: "claude-3-7-sonnet", label: "Claude 3.7 Sonnet" },
    ];

    const result = await enrichWithPoolModels(mockDb, "cmp-1", baseModels, mockService);

    // gpt-4o was in baseModels -> preserved properties + accounts annotated
    const gpt4o = result.find((m) => m.id === "gpt-4o");
    expect(gpt4o).toBeDefined();
    expect(gpt4o?.label).toBe("GPT-4o");
    expect(gpt4o?.pricing).toBe("paid");
    expect(gpt4o?.accounts).toEqual(["acc1", "acc2"]);

    // claude-3-7-sonnet had no pool accounts -> untouched
    const claude = result.find((m) => m.id === "claude-3-7-sonnet");
    expect(claude?.accounts).toBeUndefined();

    // gemini-2.0-flash and o3-mini were not in baseModels -> added
    const gemini = result.find((m) => m.id === "gemini-2.0-flash");
    expect(gemini).toBeDefined();
    expect(gemini?.accounts).toEqual(["acc1"]);

    const o3 = result.find((m) => m.id === "o3-mini");
    expect(o3).toBeDefined();
    expect(o3?.accounts).toEqual(["acc2"]);
  });

  it("excludes banned accounts from providing models", async () => {
    const mockDb: any = {
      select: () => ({
        from: () => ({
          where: async () => [
            { id: "prov-1", type: "chatgpt-pool", companyId: "cmp-1" },
          ],
        }),
      }),
    };

    const mockService: PoolAccountChannelProvider = {
      listChannels: async () => ({
        channels: [
          {
            n: 1,
            label: "acc1",
            state: "active",
            isBanned: false,
            isExhausted: false,
            limitedUntil: null,
            lastOk: null,
            windows: { primary: null, secondary: null },
            models: ["shared-model"],
          },
          {
            n: 2,
            label: "banned-acc",
            state: "banned",
            isBanned: true,
            isExhausted: false,
            limitedUntil: null,
            lastOk: null,
            windows: { primary: null, secondary: null },
            models: ["shared-model", "banned-only-model"],
          },
        ],
      }),
    };

    const baseModels: AdapterModel[] = [{ id: "base", label: "base" }];
    const result = await enrichWithPoolModels(mockDb, "cmp-1", baseModels, mockService);

    // shared-model should only be attributed to acc1
    const shared = result.find((m) => m.id === "shared-model");
    expect(shared?.accounts).toEqual(["acc1"]);

    // banned-only-model should not be added
    const bannedOnly = result.find((m) => m.id === "banned-only-model");
    expect(bannedOnly).toBeUndefined();
  });

  it("handles provider channel listing failure gracefully", async () => {
    const mockDb: any = {
      select: () => ({
        from: () => ({
          where: async () => [
            { id: "prov-failing", type: "chatgpt-pool", companyId: "cmp-1" },
          ],
        }),
      }),
    };

    const mockService: PoolAccountChannelProvider = {
      listChannels: async () => {
        throw new Error("Pool daemon unreachable");
      },
    };

    const baseModels: AdapterModel[] = [{ id: "base", label: "base" }];
    const result = await enrichWithPoolModels(mockDb, "cmp-1", baseModels, mockService);
    expect(result).toEqual(baseModels);
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createLitellmConfigClient,
  readFallbacksFromDb,
  writeFallbacksToDb,
} from "./config-client.js";
import type { KnownModelInfo } from "@myrmidon/shared";

describe("myrmidon(OPE-9855) LiteLLM config client and DB integration", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  beforeEach(() => {
    fetchMock.mockReset();
  });

  const clientWithoutDb = createLitellmConfigClient({
    litellmBaseUrl: "http://litellm-test:4000",
    litellmAdminKey: "«redacted:sk-…»",
  });

  it("reads fallback topology from /router/settings API when DB is not configured", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        fields: [
          {
            field_name: "fallbacks",
            field_value: [
              { "gpt-4o": ["claude-3-5-sonnet", "gemini-pro"] },
            ],
          },
        ],
      }),
    });

    const chains = await clientWithoutDb.readFallbackTopology();
    expect(fetchMock).toHaveBeenCalledWith("http://litellm-test:4000/router/settings", {
      headers: {
        Authorization: "Bearer «redacted:sk-…»",
      },
    });
    expect(chains).toEqual([
      { model: "gpt-4o", targets: ["claude-3-5-sonnet", "gemini-pro"] },
    ]);
  });

  it("reads fallback topology directly from DB (source of truth) without hitting HTTP API", async () => {
    const dbMock: any = {
      execute: vi.fn().mockResolvedValueOnce([
        {
          param_value: {
            fallbacks: [{ "gpt-4o": ["claude-3-5-sonnet"] }],
          },
        },
      ]),
    };

    const clientWithDb = createLitellmConfigClient({
      litellmBaseUrl: "http://litellm-test:4000",
      litellmAdminKey: "«redacted:sk-…»",
      db: dbMock,
    });

    const chains = await clientWithDb.readFallbackTopology();
    expect(dbMock.execute).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chains).toEqual([{ model: "gpt-4o", targets: ["claude-3-5-sonnet"] }]);
  });

  it("falls back to HTTP API when DB has no stored fallbacks", async () => {
    const dbMock: any = {
      execute: vi.fn().mockResolvedValueOnce([]),
    };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        fields: [
          {
            field_name: "fallbacks",
            field_value: [{ "gpt-4o": ["gemini-pro"] }],
          },
        ],
      }),
    });

    const clientWithDb = createLitellmConfigClient({
      litellmBaseUrl: "http://litellm-test:4000",
      litellmAdminKey: "«redacted:sk-…»",
      db: dbMock,
    });

    const chains = await clientWithDb.readFallbackTopology();
    expect(dbMock.execute).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
    expect(chains).toEqual([{ model: "gpt-4o", targets: ["gemini-pro"] }]);
  });

  it("throws when gateway /router/settings returns HTTP error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
    });

    await expect(clientWithoutDb.readFallbackTopology()).rejects.toThrow("LiteLLM /router/settings answered 502");
  });

  it("updates fallback topology: writes to DB AND calls /config/update API", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: "Config updated successfully" }),
    });

    const dbMock: any = {
      execute: vi.fn().mockResolvedValue([]),
    };

    const clientWithDb = createLitellmConfigClient({
      litellmBaseUrl: "http://litellm-test:4000",
      litellmAdminKey: "«redacted:sk-…»",
      db: dbMock,
    });

    const catalog = new Map<string, KnownModelInfo>([
      ["gpt-4o", { modelName: "gpt-4o", provider: "openai" }],
      ["claude-3-5-sonnet", { modelName: "claude-3-5-sonnet", provider: "anthropic" }],
    ]);

    const res = await clientWithDb.updateFallbackTopology(
      [{ model: "gpt-4o", targets: ["claude-3-5-sonnet"] }],
      catalog,
    );
    expect(res).toEqual({ ok: true });
    expect(dbMock.execute).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://litellm-test:4000/config/update",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer «redacted:sk-…»",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          router_settings: {
            fallbacks: [{ "gpt-4o": ["claude-3-5-sonnet"] }],
          },
        }),
      }),
    );
  });

  it("refuses to update when unknown model groups are used", async () => {
    const catalog = new Map<string, KnownModelInfo>([
      ["gpt-4o", { modelName: "gpt-4o", provider: "openai" }],
      ["claude-3-5-sonnet", { modelName: "claude-3-5-sonnet", provider: "anthropic" }],
    ]);

    await expect(
      clientWithoutDb.updateFallbackTopology(
        [{ model: "gpt-4o", targets: ["unknown-future-model"] }],
        catalog,
      ),
    ).rejects.toThrow(/unknown model groups/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to update when catalog is empty/unavailable and non-empty chains are provided", async () => {
    // Empty catalog: any model in chains must be rejected as unknown
    await expect(
      clientWithoutDb.updateFallbackTopology(
        [{ model: "any-model", targets: ["any-target"] }],
        new Map(),
      ),
    ).rejects.toThrow(/unknown model groups/i);

    // Undefined catalog: also treated as empty catalog, rejecting unknown groups
    await expect(
      clientWithoutDb.updateFallbackTopology(
        [{ model: "any-model", targets: ["any-target"] }],
        undefined,
      ),
    ).rejects.toThrow(/unknown model groups/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to update when paid fallback uses the same provider as primary model", async () => {
    const catalog = new Map<string, KnownModelInfo>([
      ["gpt-4o", { modelName: "gpt-4o", provider: "openai", cost: 0.03 }],
      ["gpt-4o-mini", { modelName: "gpt-4o-mini", provider: "openai", cost: 0.005 }],
      ["claude-3-5-haiku", { modelName: "claude-3-5-haiku", provider: "anthropic", cost: 0.002 }],
    ]);

    await expect(
      clientWithoutDb.updateFallbackTopology(
        [{ model: "gpt-4o", targets: ["gpt-4o-mini"] }],
        catalog,
      ),
    ).rejects.toThrow(/uses the same provider/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to update when subsequent paid fallback uses the same provider as earlier paid fallback", async () => {
    const catalog = new Map<string, KnownModelInfo>([
      ["gemini-1.5-pro", { modelName: "gemini-1.5-pro", provider: "google", cost: 0.02 }],
      ["claude-3-5-haiku", { modelName: "claude-3-5-haiku", provider: "anthropic", cost: 0.002 }],
      ["claude-3-5-sonnet", { modelName: "claude-3-5-sonnet", provider: "anthropic", cost: 0.01 }],
    ]);

    await expect(
      clientWithoutDb.updateFallbackTopology(
        [{ model: "gemini-1.5-pro", targets: ["claude-3-5-haiku", "claude-3-5-sonnet"] }],
        catalog,
      ),
    ).rejects.toThrow(/uses the same provider/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to update when fallback order is invalid (free channels after paid channels)", async () => {
    const catalog = new Map<string, KnownModelInfo>([
      ["gpt-4o", { modelName: "gpt-4o", provider: "openai", cost: 0.03 }],
      ["paid-backup", { modelName: "paid-backup", provider: "anthropic", cost: 0.01 }],
      ["free-backup", { modelName: "free-backup", provider: "google", isFree: true }],
    ]);

    await expect(
      clientWithoutDb.updateFallbackTopology(
        [{ model: "gpt-4o", targets: ["paid-backup", "free-backup"] }],
        catalog,
      ),
    ).rejects.toThrow(/free channels must precede/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to update when a chain introduces a cycle", async () => {
    await expect(
      clientWithoutDb.updateFallbackTopology([
        { model: "model-a", targets: ["model-b"] },
        { model: "model-b", targets: ["model-a"] },
      ]),
    ).rejects.toThrow(/loops/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to update when a chain relies entirely on a single provider", async () => {
    const catalog = new Map<string, KnownModelInfo>([
      ["gpt-4o", { modelName: "gpt-4o", provider: "openai" }],
      ["gpt-4o-mini", { modelName: "gpt-4o-mini", provider: "openai" }],
    ]);

    await expect(
      clientWithoutDb.updateFallbackTopology(
        [{ model: "gpt-4o", targets: ["gpt-4o-mini"] }],
        catalog,
      ),
    ).rejects.toThrow(/single provider/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads fallback topology directly from LiteLLM_Config DB table", async () => {
    const dbMock: any = {
      execute: vi.fn().mockResolvedValueOnce([
        {
          param_value: {
            fallbacks: [{ "model-alpha": ["model-beta"] }],
          },
        },
      ]),
    };

    const chains = await readFallbacksFromDb(dbMock);
    expect(chains).toEqual([{ model: "model-alpha", targets: ["model-beta"] }]);
    expect(dbMock.execute).toHaveBeenCalled();
  });

  it("readFallbacksFromDb returns null when table cannot be read", async () => {
    const dbMock: any = {
      execute: vi.fn().mockRejectedValueOnce(new Error('relation "LiteLLM_Config" does not exist')),
    };

    const chains = await readFallbacksFromDb(dbMock);
    expect(chains).toBeNull();
  });

  it("writeFallbacksToDb creates table and inserts serialized fallbacks", async () => {
    const dbMock: any = {
      execute: vi.fn().mockResolvedValue([]),
    };

    await writeFallbacksToDb(dbMock, [{ model: "model-alpha", targets: ["model-beta"] }]);
    expect(dbMock.execute).toHaveBeenCalledTimes(2);
  });
});

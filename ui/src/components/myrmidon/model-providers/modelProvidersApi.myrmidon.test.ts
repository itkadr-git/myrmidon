// myrmidon(1.6.7 OPE-12345): the "Model providers" client must call the paths
// the server mounts. The 1.6.1 client put an extra `/providers` segment into
// every path (`…/model-providers/providers/:id/models`), the server has no such
// route, and the whole screen answered 404. The paths asserted here are the
// ones server/src/myrmidon/model-providers/routes-with-sync.ts registers; the
// server suite (model-providers-client-contract.myrmidon.test.ts) pins the same
// list from the other side.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/api/client", () => ({ api: mockApi }));

import { litellmAuditApi, modelProvidersApi, normalizeLitellmChannel } from "./modelProvidersApi";

const COMPANY = "company-1";
const BASE = `/myrmidon/companies/${COMPANY}/model-providers`;

describe("modelProvidersApi paths follow the server contract", () => {
  beforeEach(() => {
    mockApi.get.mockReset().mockResolvedValue({ channels: [] });
    mockApi.post.mockReset().mockResolvedValue({});
    mockApi.patch.mockReset().mockResolvedValue({});
    mockApi.delete.mockReset().mockResolvedValue({});
  });

  it("list and add use the collection path, without a /providers segment", async () => {
    await modelProvidersApi.view(COMPANY);
    expect(mockApi.get).toHaveBeenCalledWith(BASE);

    const input = { type: "antigravity-pool" as const, name: "Antigravity", baseUrl: null, key: "k", free: false };
    await modelProvidersApi.add(COMPANY, input);
    expect(mockApi.post).toHaveBeenCalledWith(BASE, input);
  });

  it("rotate, remove, models and channels use /:providerId", async () => {
    await modelProvidersApi.rotate(COMPANY, "prov 1", { key: "new" });
    expect(mockApi.patch).toHaveBeenCalledWith(`${BASE}/prov%201`, { key: "new" });

    await modelProvidersApi.remove(COMPANY, "prov-1");
    expect(mockApi.delete).toHaveBeenCalledWith(`${BASE}/prov-1`);

    await modelProvidersApi.models(COMPANY, "prov-1");
    expect(mockApi.get).toHaveBeenCalledWith(`${BASE}/prov-1/models`);

    const models = { models: [{ modelName: "m", litellmModelName: "p/m", enabled: true, free: false }] };
    await modelProvidersApi.updateModels(COMPANY, "prov-1", models);
    expect(mockApi.post).toHaveBeenCalledWith(`${BASE}/prov-1/models`, models);

    await modelProvidersApi.channels(COMPANY, "prov-1");
    expect(mockApi.get).toHaveBeenCalledWith(`${BASE}/prov-1/channels`);
  });

  it("the OAuth calls use /:providerId/oauth/…", async () => {
    await modelProvidersApi.oauthBegin(COMPANY, "prov-1");
    expect(mockApi.post).toHaveBeenCalledWith(`${BASE}/prov-1/oauth/begin`, {});

    await modelProvidersApi.oauthStatus(COMPANY, "prov-1", 3);
    expect(mockApi.get).toHaveBeenCalledWith(`${BASE}/prov-1/oauth/status?accountNumber=3`);

    await modelProvidersApi.oauthComplete(COMPANY, "prov-1", { accountNumber: 3, code: "c" });
    expect(mockApi.post).toHaveBeenCalledWith(`${BASE}/prov-1/oauth/complete`, { accountNumber: 3, code: "c" });

    await modelProvidersApi.oauthRefresh(COMPANY, "prov-1", { accountNumber: 3 });
    expect(mockApi.post).toHaveBeenCalledWith(`${BASE}/prov-1/oauth/refresh`, { accountNumber: 3 });
  });

  it("no call goes through the retired /providers path", async () => {
    await modelProvidersApi.view(COMPANY);
    await modelProvidersApi.models(COMPANY, "p");
    await modelProvidersApi.channels(COMPANY, "p");
    await modelProvidersApi.litellmChannels(COMPANY);
    await modelProvidersApi.remove(COMPANY, "p");
    const paths = [
      ...mockApi.get.mock.calls,
      ...mockApi.post.mock.calls,
      ...mockApi.patch.mock.calls,
      ...mockApi.delete.mock.calls,
    ].map((call) => String(call[0]));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path).not.toContain("/providers");
  });

  it("the LiteLLM channels call keeps its path and maps both server row spellings", async () => {
    mockApi.get.mockResolvedValueOnce({
      enabled: true,
      channels: [
        { id: "a", group: "g1", provider: "openai", providerModel: "m1", order: 1, weight: 2 },
        { id: "b", modelName: "g2", providerType: "deepseek", providerModel: "m2", order: 0, weight: 0 },
      ],
    });
    const result = await modelProvidersApi.litellmChannels(COMPANY);
    expect(mockApi.get).toHaveBeenCalledWith(`${BASE}/litellm/channels`);
    expect(result.enabled).toBe(true);
    expect(result.channels).toEqual([
      { id: "a", group: "g1", provider: "openai", providerModel: "m1", order: 1, weight: 2 },
      { id: "b", group: "g2", provider: "deepseek", providerModel: "m2", order: 0, weight: 0 },
    ]);
  });

  it("normalizeLitellmChannel fills the gaps with empty values", () => {
    expect(normalizeLitellmChannel({})).toEqual({
      id: null,
      group: "",
      provider: "",
      providerModel: "",
      order: null,
      weight: null,
    });
  });
});

describe("litellmAuditApi paths carry no second /api prefix", () => {
  beforeEach(() => {
    mockApi.get.mockReset().mockResolvedValue({ entries: [] });
    mockApi.post.mockReset().mockResolvedValue({});
  });

  it("list and rollback address /myrmidon/companies/… (the client adds /api)", async () => {
    await litellmAuditApi.list(COMPANY);
    expect(mockApi.get).toHaveBeenCalledWith(`/myrmidon/companies/${COMPANY}/litellm/audit`);
    await litellmAuditApi.list(COMPANY, "models");
    expect(mockApi.get).toHaveBeenCalledWith(`/myrmidon/companies/${COMPANY}/litellm/audit?category=models`);
    await litellmAuditApi.rollback(COMPANY, "audit-1");
    expect(mockApi.post).toHaveBeenCalledWith(
      `/myrmidon/companies/${COMPANY}/litellm/audit/audit-1/rollback`,
      {},
    );
  });
});

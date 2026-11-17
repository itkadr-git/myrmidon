import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeSettingsPatch, KnowledgeSettingsView } from "@myrmidon/shared";
import { fetchKnowledgeSettings, knowledgeSettingsPath, patchKnowledgeSettings } from "./knowledgeSettingsApi";

const transport = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock("@/api/client", () => ({ api: transport }));

const response: KnowledgeSettingsView = {
  maxItems: { value: 5000, source: "default" },
  maxRevisionBytes: { value: 262144, source: "default" },
  autoAcceptEnabled: { value: false, source: "default" },
  autoAcceptMinConfidence: { value: "0.9", source: "default" },
  schedule: { value: "0 0 0 0 0", source: "default" },
  sectionReviewers: { value: [], source: "default" },
};

describe("knowledge settings client boundary", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ["company-1", "company-1"],
    ["with space", "with%20space"],
    ["with/slash", "with%2Fslash"],
    ["with?query", "with%3Fquery"],
    ["with#hash", "with%23hash"],
    ["会社", "%E4%BC%9A%E7%A4%BE"],
    ["already%2Fencoded", "already%252Fencoded"],
  ])("encodes %s as one segment for GET and PATCH", async (companyId, segment) => {
    const path = `/api/myrmidon/companies/${segment}/knowledge/settings`;
    const patch: KnowledgeSettingsPatch = { autoAcceptEnabled: false, sectionReviewers: [], schedule: "0 0 1 * *" };
    transport.get.mockResolvedValue(response);
    transport.patch.mockResolvedValue(response);

    expect(knowledgeSettingsPath(companyId)).toBe(path);
    expect(await fetchKnowledgeSettings(companyId)).toBe(response);
    expect(await patchKnowledgeSettings(companyId, patch)).toBe(response);
    expect(transport.get).toHaveBeenCalledExactlyOnceWith(path);
    expect(transport.patch).toHaveBeenCalledExactlyOnceWith(path, patch);
    expect(transport.patch.mock.calls[0][1]).toBe(patch);
    expect(patch).toEqual({ autoAcceptEnabled: false, sectionReviewers: [], schedule: "0 0 1 * *" });
  });

  it("propagates GET rejection unchanged", async () => {
    const error = new Error("GET failed");
    transport.get.mockRejectedValue(error);
    await expect(fetchKnowledgeSettings("company-1")).rejects.toBe(error);
  });

  it("propagates PATCH rejection unchanged", async () => {
    const error = new Error("PATCH failed");
    transport.patch.mockRejectedValue(error);
    await expect(patchKnowledgeSettings("company-1", { autoAcceptEnabled: false })).rejects.toBe(error);
  });
});

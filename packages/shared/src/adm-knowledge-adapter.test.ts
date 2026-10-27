import { describe, expect, it, vi } from "vitest";
import { createAdmKnowledgeAdapter, type AdmKnowledgeItem, type AdmKnowledgeRestPort } from "./adm-knowledge-adapter.js";

const policy: AdmKnowledgeItem = {
  id: "stable-item-id",
  slug: "adm/policy/deploy-safety",
  kind: "rule",
  title: "Deploy safety",
  summary: "Owner-approved deployment policy",
  status: "published",
  updatedAt: "2026-10-25T00:00:00.000Z",
  deliveredRevisionId: "stable-revision-id",
};
function rest(overrides: Partial<AdmKnowledgeRestPort> = {}): AdmKnowledgeRestPort {
  return {
    search: vi.fn(async () => [policy]),
    list: vi.fn(async () => [policy]),
    read: vi.fn(async () => policy),
    ...overrides,
  };
}

describe("ADM knowledge REST adapter", () => {
  it("searches with the namespace prefix, filters published items, and preserves stable IDs", async () => {
    const unpublished = { ...policy, id: "draft-id", status: "draft" };
    const api = rest({ search: vi.fn(async () => [policy, unpublished]) });
    const adapter = createAdmKnowledgeAdapter(api);
    await expect(adapter.search("deploy", "policy")).resolves.toEqual([policy]);
    expect(api.search).toHaveBeenCalledWith("deploy", { space: "adm/policy/", limit: 50 });
  });

  it("maps namespaces to knowledge kinds for published listing", async () => {
    const api = rest({ list: vi.fn(async () => [policy]) });
    await createAdmKnowledgeAdapter(api).list("policy", 12);
    expect(api.list).toHaveBeenCalledWith({ space: "adm/policy/", kind: "rule", status: "published", limit: 12 });
  });

  it("reads by stable ID and refuses unpublished or out-of-contract items", async () => {
    const api = rest({ read: vi.fn(async (id) => id === policy.id ? policy : null) });
    const adapter = createAdmKnowledgeAdapter(api);
    await expect(adapter.read(policy.id)).resolves.toEqual(policy);
    await expect(adapter.read("missing-id")).rejects.toMatchObject({ code: "ADM_NOT_FOUND" });
    expect(api.read).toHaveBeenCalledWith(policy.id);
    const draftApi = rest({ read: vi.fn(async () => ({ ...policy, status: "draft" })) });
    await expect(createAdmKnowledgeAdapter(draftApi).read(policy.id)).rejects.toMatchObject({ code: "ADM_NOT_FOUND" });
  });

  it("validates metadata and requires owner approval for rules", () => {
    const adapter = createAdmKnowledgeAdapter(rest());
    const valid = {
      schema_version: 1, slug: policy.slug, kind: "rule", title: policy.title,
      summary: policy.summary, tags: ["deployment"], triggers: ["deploy"], priority: 90,
      owner: "adm-owner", source_ref: "docs/deploy.md", sensitivity: "internal",
      status: "published", revision_id: "stable-revision-id", updated_at: policy.updatedAt,
      approver_kind: "owner",
    };
    expect(adapter.validateMetadata(valid)).toMatchObject({ slug: policy.slug, kind: "rule" });
    expect(() => adapter.validateMetadata({ ...valid, approver_kind: undefined })).toThrow(/invalid/i);
    expect(() => adapter.validateMetadata({ ...valid, triggers: ["unknown"] })).toThrow(/invalid/i);
  });

  it("maps REST failures to stable connector error codes without leaking upstream messages", async () => {
    const upstream = Object.assign(new Error("secret token must not escape"), { status: 429 });
    const adapter = createAdmKnowledgeAdapter(rest({ list: vi.fn(async () => { throw upstream; }) }));
    await expect(adapter.list("policy")).rejects.toMatchObject({ code: "ADM_RATE_LIMITED", message: "ADM knowledge request failed" });
  });
});

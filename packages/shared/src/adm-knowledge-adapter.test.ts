import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AdmContextBudget,
  createAdmKnowledgeAdapter,
  type AdmKnowledgeItem,
  type AdmKnowledgeMetadata,
  type AdmKnowledgeRestPort,
} from "./adm-knowledge-adapter.js";

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
    proposeRule: vi.fn(async () => ({ itemId: policy.id, revisionId: "proposal-revision-id", status: "proposed" as const })),
    writeLesson: vi.fn(async () => ({ itemId: "lesson-id", revisionId: "lesson-r1", status: "published" as const })),
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

  it("proposes rules without allowing self-publication and preserves the idempotency key", async () => {
    const api = rest({ read: vi.fn(async () => ({ ...policy, status: "proposed" })) });
    const result = await createAdmKnowledgeAdapter(api).proposeRule({
      slug: policy.slug, title: policy.title, summary: policy.summary ?? "", body: "Never deploy without approval.",
      sourceRef: "OPE-9262", idempotencyKey: "ope-9262:rule:1",
    });
    expect(result.status).toBe("proposed");
    expect(api.proposeRule).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "ope-9262:rule:1" }));
    expect(api.read).toHaveBeenCalledWith(policy.id);
    await expect(createAdmKnowledgeAdapter(rest()).proposeRule({
      slug: policy.slug, title: policy.title, summary: "", body: "body", sourceRef: "test", idempotencyKey: "bad",
    })).rejects.toMatchObject({ code: "ADM_INVALID_METADATA" });
  });

  it("rejects a published rule response", async () => {
    const api = rest({
      proposeRule: vi.fn(async () => ({ itemId: policy.id, revisionId: "r1", status: "published" as const })),
    });
    await expect(createAdmKnowledgeAdapter(api).proposeRule({
      slug: policy.slug, title: policy.title, summary: "", body: "body", sourceRef: "test", idempotencyKey: "ope-9262:rule:2",
    })).rejects.toMatchObject({ code: "ADM_FORBIDDEN" });
  });

  it("requires lesson publication read-back", async () => {
    const lesson = { ...policy, id: "lesson-id", slug: "adm/lessons/deploy", kind: "wiki", deliveredRevisionId: "lesson-r1" };
    const api = rest({ read: vi.fn(async () => lesson) });
    const result = await createAdmKnowledgeAdapter(api).writeLesson({
      slug: lesson.slug, title: "Lesson", summary: "", body: "Observed.", sourceRef: "test", idempotencyKey: "ope-9262:lesson:1",
    });
    expect(result.status).toBe("published");
    expect(api.read).toHaveBeenCalledWith(lesson.id);
  });

  it("rejects lesson publication when read-back fails or revision does not match", async () => {
    const lesson = { ...policy, id: "lesson-id", slug: "adm/lessons/deploy", kind: "wiki", deliveredRevisionId: "lesson-r1" };
    const missingApi = rest({
      writeLesson: vi.fn(async () => ({ itemId: lesson.id, revisionId: "lesson-r1", status: "published" as const })),
      read: vi.fn(async () => null),
    });
    await expect(createAdmKnowledgeAdapter(missingApi).writeLesson({
      slug: lesson.slug, title: "Lesson", summary: "", body: "Observed.", sourceRef: "test", idempotencyKey: "ope-9262:lesson:2",
    })).rejects.toMatchObject({ code: "ADM_UPSTREAM_UNAVAILABLE" });

    const mismatchApi = rest({
      writeLesson: vi.fn(async () => ({ itemId: lesson.id, revisionId: "lesson-r1", status: "published" as const })),
      read: vi.fn(async () => ({ ...lesson, deliveredRevisionId: "stale-revision" })),
    });
    await expect(createAdmKnowledgeAdapter(mismatchApi).writeLesson({
      slug: lesson.slug, title: "Lesson", summary: "", body: "Observed.", sourceRef: "test", idempotencyKey: "ope-9262:lesson:3",
    })).rejects.toMatchObject({ code: "ADM_UPSTREAM_UNAVAILABLE" });
  });

  it("handles base-revision conflict by rereading, calculating diff, and reproposing", async () => {
    let callCount = 0;
    const latestPolicy: AdmKnowledgeItem = {
      ...policy,
      deliveredRevisionId: "rev-2",
      summary: "Updated deployment policy v2",
    };
    const api = rest({
      read: vi.fn(async (id) => (id === policy.id ? latestPolicy : null)),
      proposeRule: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          const err = new Error("Conflict");
          Object.assign(err, { status: 409 });
          throw err;
        }
        return { itemId: policy.id, revisionId: "rev-3", status: "proposed" as const };
      }),
    });
    const adapter = createAdmKnowledgeAdapter(api);
    const result = await adapter.proposeRuleWithConflictRetry({
      itemId: policy.id,
      slug: policy.slug,
      title: policy.title,
      summary: "Updated deployment policy v3",
      body: "Never deploy on Friday without owner sign-off.",
      sourceRef: "OPE-9262",
      baseRevisionId: "rev-1",
      idempotencyKey: "ope-9262:rule:conflict-1",
    }, "ope-9262:rule:conflict-2");

    expect(result.conflictResolved).toBe(true);
    expect(result.diff).toContain("base: rev-1");
    expect(result.diff).toContain("latest: rev-2");
    expect(result.result.status).toBe("proposed");
    expect(api.proposeRule).toHaveBeenCalledTimes(2);
    expect(api.proposeRule).toHaveBeenLastCalledWith(expect.objectContaining({
      baseRevisionId: "rev-2",
      idempotencyKey: "ope-9262:rule:conflict-2",
    }));
  });

  it("enforces context budgets, trigger filtering, deduplication, and byte metrics", () => {
    const metrics: Array<{ bytesAdded: number; sessionBytes: number }> = [];
    const budget = new AdmContextBudget(12 * 1024, 2 * 1024, (event) => metrics.push(event));
    const metadata: AdmKnowledgeMetadata[] = [{ schema_version: 1, slug: policy.slug, kind: "rule", title: policy.title, summary: policy.summary ?? "", tags: [], triggers: ["deploy"], priority: 1, owner: "owner", source_ref: "test", sensitivity: "internal", status: "published", revision_id: "r1", updated_at: policy.updatedAt, approver_kind: "owner" }];
    expect(budget.sessionStart(metadata)).not.toContain("body");
    expect(budget.prompt(metadata, "incident")).toBe("");
    expect(budget.prompt(metadata, "deploy")).not.toBe("[]");
    expect(budget.prompt(metadata, "deploy")).toBe("");
    expect(metrics.some((event) => event.bytesAdded > 0)).toBe(true);
  });
  it("persists slug+revision dedupe per session across compaction", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adm-state-"));
    const statePath = join(tmpDir, "adm-budget-state-test.json");
    try {
      const metadata: AdmKnowledgeMetadata[] = [{ schema_version: 1, slug: policy.slug, kind: "rule", title: policy.title, summary: policy.summary ?? "", tags: [], triggers: ["deploy"], priority: 1, owner: "owner", source_ref: "test", sensitivity: "internal", status: "published", revision_id: "r1", updated_at: policy.updatedAt, approver_kind: "owner" }];
      const first = new AdmContextBudget(12 * 1024, 2 * 1024, undefined, { sessionId: "session-1", statePath });
      expect(first.prompt(metadata, "deploy")).not.toBe("");
      const resumed = new AdmContextBudget(12 * 1024, 2 * 1024, undefined, { sessionId: "session-1", statePath });
      expect(resumed.prompt(metadata, "deploy")).toBe("");
      const otherSession = new AdmContextBudget(12 * 1024, 2 * 1024, undefined, { sessionId: "session-2", statePath });
      expect(otherSession.prompt(metadata, "deploy")).not.toBe("");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maps REST failures to stable connector error codes without leaking upstream messages", async () => {
    const upstream = Object.assign(new Error("secret token must not escape"), { status: 429 });
    const adapter = createAdmKnowledgeAdapter(rest({ list: vi.fn(async () => { throw upstream; }) }));
    await expect(adapter.list("policy")).rejects.toMatchObject({ code: "ADM_RATE_LIMITED", message: "ADM knowledge request failed" });
  });
});

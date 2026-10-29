import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AdmContextBudget,
  createAdmKnowledgeAdapter,
  createAdmProductionHooks,
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
    approveRule: vi.fn(async ({ itemId, revisionId }) => ({
      ...policy,
      id: itemId,
      deliveredRevisionId: revisionId,
      status: "published",
    })),
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

  it("rejects a published rule response or premature publication read-back", async () => {
    const api = rest({
      proposeRule: vi.fn(async () => ({ itemId: policy.id, revisionId: "r1", status: "published" as const })),
    });
    await expect(createAdmKnowledgeAdapter(api).proposeRule({
      slug: policy.slug, title: policy.title, summary: "", body: "body", sourceRef: "test", idempotencyKey: "ope-9262:rule:2",
    })).rejects.toMatchObject({ code: "ADM_FORBIDDEN" });

    const prematurePublishedApi = rest({
      proposeRule: vi.fn(async () => ({ itemId: policy.id, revisionId: "r2", status: "proposed" as const })),
      read: vi.fn(async () => ({ ...policy, deliveredRevisionId: "r2", status: "published" })),
    });
    await expect(createAdmKnowledgeAdapter(prematurePublishedApi).proposeRule({
      slug: policy.slug, title: policy.title, summary: "", body: "body", sourceRef: "test", idempotencyKey: "ope-9262:rule:3",
    })).rejects.toMatchObject({ code: "ADM_FORBIDDEN" });
  });

  it("publishes rules only after owner approval, rejecting non-owner approvers", async () => {
    const publishedPolicy: AdmKnowledgeItem = {
      ...policy,
      deliveredRevisionId: "rev-approved",
      status: "published",
    };
    const api = rest({
      approveRule: vi.fn(async ({ itemId, revisionId }) => ({
        ...publishedPolicy,
        id: itemId,
        deliveredRevisionId: revisionId,
      })),
      read: vi.fn(async (id) => (id === policy.id ? { ...publishedPolicy, deliveredRevisionId: "rev-approved" } : null)),
    });
    const adapter = createAdmKnowledgeAdapter(api);

    await expect(adapter.approveRule({
      itemId: policy.id,
      revisionId: "rev-approved",
      approverKind: "agent",
    })).rejects.toMatchObject({ code: "ADM_FORBIDDEN" });
    expect(api.approveRule).not.toHaveBeenCalled();

    const approved = await adapter.approveRule({
      itemId: policy.id,
      revisionId: "rev-approved",
      approverKind: "owner",
    });
    expect(approved.status).toBe("published");
    expect(approved.deliveredRevisionId).toBe("rev-approved");
    expect(api.approveRule).toHaveBeenCalledWith({
      itemId: policy.id,
      revisionId: "rev-approved",
      approverKind: "owner",
    });

    const mismatchApi = rest({
      approveRule: vi.fn(async () => ({ ...publishedPolicy, deliveredRevisionId: "wrong-rev" })),
    });
    await expect(createAdmKnowledgeAdapter(mismatchApi).approveRule({
      itemId: policy.id,
      revisionId: "rev-approved",
      approverKind: "owner",
    })).rejects.toMatchObject({ code: "ADM_UPSTREAM_UNAVAILABLE" });
  });

  it("supports repeated idempotency keys across operations", async () => {
    const api = rest();
    const adapter = createAdmKnowledgeAdapter(api);
    const key = "ope-9877:idempotency:same-key";

    const res1 = await adapter.proposeRule({
      slug: policy.slug,
      title: policy.title,
      summary: policy.summary ?? "",
      body: "Rule body",
      sourceRef: "test",
      idempotencyKey: key,
    });
    const res2 = await adapter.proposeRule({
      slug: policy.slug,
      title: policy.title,
      summary: policy.summary ?? "",
      body: "Rule body",
      sourceRef: "test",
      idempotencyKey: key,
    });
    expect(res1).toEqual(res2);
    expect(api.proposeRule).toHaveBeenCalledTimes(2);
    expect(api.proposeRule).toHaveBeenNthCalledWith(1, expect.objectContaining({ idempotencyKey: key }));
    expect(api.proposeRule).toHaveBeenNthCalledWith(2, expect.objectContaining({ idempotencyKey: key }));
  });

  it("requires lesson publication read-back and supports draft and published modes", async () => {
    const draftLesson: AdmKnowledgeItem = {
      ...policy,
      id: "lesson-draft-id",
      slug: "adm/lessons/deploy-checklist",
      kind: "wiki",
      status: "draft",
      deliveredRevisionId: "draft-rev-1",
    };
    const draftApi = rest({
      writeLesson: vi.fn(async () => ({ itemId: draftLesson.id, revisionId: "draft-rev-1", status: "draft" as const })),
      read: vi.fn(async (id) => (id === draftLesson.id ? draftLesson : null)),
    });
    const draftResult = await createAdmKnowledgeAdapter(draftApi).writeLesson({
      slug: draftLesson.slug,
      title: "Draft Lesson",
      summary: "Draft checklist",
      body: "Draft body",
      sourceRef: "OPE-9877",
      idempotencyKey: "ope-9877:lesson:draft-1",
      status: "draft",
    });
    expect(draftResult.status).toBe("draft");
    expect(draftApi.writeLesson).toHaveBeenCalledWith(expect.objectContaining({ status: "draft" }));

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
    const metrics: Array<{ kind?: string; bytesAdded: number; sessionBytes: number }> = [];
    const budget = new AdmContextBudget(12 * 1024, 2 * 1024, (event) => metrics.push(event));
    const metadata: AdmKnowledgeMetadata[] = [{ schema_version: 1, slug: policy.slug, kind: "rule", title: policy.title, summary: policy.summary ?? "", tags: [], triggers: ["deploy"], priority: 1, owner: "owner", source_ref: "test", sensitivity: "internal", status: "published", revision_id: "r1", updated_at: policy.updatedAt, approver_kind: "owner" }];
    expect(budget.sessionStart(metadata)).not.toContain("body");
    expect(budget.prompt(metadata, "incident")).toBe("");
    expect(budget.prompt(metadata, "deploy")).not.toBe("[]");
    expect(budget.prompt(metadata, "deploy")).toBe("");
    expect(metrics.some((event) => event.bytesAdded > 0)).toBe(true);
  });

  it("integrates production hooks with deterministic trigger filtering, deduplication, and byte budget caps", () => {
    const metrics: Array<{ kind?: string; bytesAdded: number; sessionBytes: number }> = [];
    const budget = new AdmContextBudget(12 * 1024, 2 * 1024, (event) => metrics.push(event));
    const hooks = createAdmProductionHooks(budget);

    const items: AdmKnowledgeMetadata[] = [
      {
        schema_version: 1,
        slug: "adm/policy/deploy-safety",
        kind: "rule",
        title: "Deploy safety policy",
        summary: "Always check green CI before opening PR",
        tags: ["deploy"],
        triggers: ["deploy"],
        priority: 90,
        owner: "adm",
        source_ref: "docs/deploy.md",
        sensitivity: "internal",
        status: "published",
        revision_id: "rev-pol-1",
        updated_at: "2026-10-25T00:00:00.000Z",
        approver_kind: "owner",
      },
      {
        schema_version: 1,
        slug: "adm/trigger/ssh-boundary",
        kind: "rule",
        title: "SSH access boundary",
        summary: "SSH requires bastion certificate",
        tags: ["ssh"],
        triggers: ["ssh"],
        priority: 80,
        owner: "adm",
        source_ref: "docs/ssh.md",
        sensitivity: "internal",
        status: "published",
        revision_id: "rev-ssh-1",
        updated_at: "2026-10-25T00:00:00.000Z",
        approver_kind: "owner",
      },
    ];

    const sessionOutput = hooks.onSessionStart(items);
    expect(sessionOutput).not.toBe("");
    expect(sessionOutput).not.toContain("body");
    expect(Buffer.byteLength(sessionOutput, "utf8")).toBeLessThanOrEqual(12 * 1024);

    const unmatched = hooks.onUserPromptSubmit(items, "incident");
    expect(unmatched).toBe("");

    const deployPrompt = hooks.onUserPromptSubmit(items, "deploy");
    expect(deployPrompt).toContain("adm/policy/deploy-safety");
    expect(Buffer.byteLength(deployPrompt, "utf8")).toBeLessThanOrEqual(2 * 1024);

    const deployRepeat = hooks.onUserPromptSubmit(items, "deploy");
    expect(deployRepeat).toBe("");

    expect(metrics.length).toBeGreaterThanOrEqual(4);
    expect(metrics[0].kind).toBe("session_start");
    expect(metrics[0].bytesAdded).toBeGreaterThan(0);
    expect(metrics[1].kind).toBe("prompt");
    expect(metrics[1].bytesAdded).toBe(0);
    expect(metrics[2].kind).toBe("prompt");
    expect(metrics[2].bytesAdded).toBeGreaterThan(0);
    expect(metrics[3].kind).toBe("prompt");
    expect(metrics[3].bytesAdded).toBe(0);
  });

  it("enforces context budget limits: SessionStart <= 12 KB, prompt <= 2 KB, and zero bytes on trigger mismatch", () => {
    const metrics: Array<{ kind?: string; bytesAdded: number; sessionBytes: number }> = [];
    const budget = new AdmContextBudget(12 * 1024, 2 * 1024, (event) => metrics.push(event));

    const hugeItems: AdmKnowledgeMetadata[] = Array.from({ length: 150 }, (_, i) => ({
      schema_version: 1,
      slug: `adm/policy/policy-${i}`,
      kind: "rule",
      title: `Policy title ${i} `.repeat(5).slice(0, 160),
      summary: `Policy summary ${i} `.repeat(20).slice(0, 300),
      tags: ["deploy"],
      triggers: ["deploy" as const],
      priority: 50,
      owner: "adm",
      source_ref: "docs/ref.md",
      sensitivity: "internal" as const,
      status: "published" as const,
      revision_id: `rev-${i}`,
      updated_at: "2026-10-25T00:00:00.000Z",
      approver_kind: "owner" as const,
    }));

    const startResult = budget.sessionStart(hugeItems);
    expect(startResult).toBe("");
    expect(metrics[metrics.length - 1]).toEqual(expect.objectContaining({
      kind: "session_start",
      bytesAdded: 0,
    }));

    const unmatched = budget.prompt(hugeItems.slice(0, 1), "unmatched-trigger");
    expect(unmatched).toBe("");
    expect(metrics[metrics.length - 1]).toEqual(expect.objectContaining({
      kind: "prompt",
      bytesAdded: 0,
    }));

    const bigPromptItems: AdmKnowledgeMetadata[] = Array.from({ length: 30 }, (_, i) => ({
      schema_version: 1,
      slug: `adm/trigger/trigger-${i}`,
      kind: "rule",
      title: `Trigger title ${i} `.repeat(5).slice(0, 160),
      summary: `Trigger summary ${i} `.repeat(20).slice(0, 300),
      tags: ["deploy"],
      triggers: ["deploy" as const],
      priority: 50,
      owner: "adm",
      source_ref: "docs/ref.md",
      sensitivity: "internal" as const,
      status: "published" as const,
      revision_id: `rev-${i}`,
      updated_at: "2026-10-25T00:00:00.000Z",
      approver_kind: "owner" as const,
    }));
    const bigPromptResult = budget.prompt(bigPromptItems, "deploy");
    expect(bigPromptResult).toBe("");
    expect(metrics[metrics.length - 1]).toEqual(expect.objectContaining({
      kind: "prompt",
      bytesAdded: 0,
    }));
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

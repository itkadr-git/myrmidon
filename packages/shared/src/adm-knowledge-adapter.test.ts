import { describe, expect, it, vi } from "vitest";
import {
  createAdmKnowledgeAdapter,
  type AdmKnowledgeItem,
  type AdmKnowledgeRestPort,
  type AdmWriteResult,
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
    const api = rest({ read: vi.fn(async (id) => (id === policy.id ? policy : null)) });
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
      schema_version: 1,
      slug: policy.slug,
      kind: "rule",
      title: policy.title,
      summary: policy.summary,
      tags: ["deployment"],
      triggers: ["deploy"],
      priority: 90,
      owner: "adm-owner",
      source_ref: "docs/deploy.md",
      sensitivity: "internal",
      status: "published",
      revision_id: "stable-revision-id",
      updated_at: policy.updatedAt,
      approver_kind: "owner",
    };
    expect(adapter.validateMetadata(valid)).toMatchObject({ slug: policy.slug, kind: "rule" });
    expect(() => adapter.validateMetadata({ ...valid, approver_kind: undefined })).toThrow(/invalid/i);
    expect(() => adapter.validateMetadata({ ...valid, triggers: ["unknown"] })).toThrow(/invalid/i);
  });

  it("proposes rules without allowing self-publication and preserves the idempotency key", async () => {
    const api = rest({ read: vi.fn(async () => ({ ...policy, status: "proposed" })) });
    const result = await createAdmKnowledgeAdapter(api).proposeRule({
      slug: policy.slug,
      title: policy.title,
      summary: policy.summary ?? "",
      body: "Never deploy without approval.",
      sourceRef: "OPE-9262",
      idempotencyKey: "ope-9262:rule:1",
    });
    expect(result.status).toBe("proposed");
    expect(api.proposeRule).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "ope-9262:rule:1" }));
    expect(api.read).toHaveBeenCalledWith(policy.id);
    await expect(
      createAdmKnowledgeAdapter(rest()).proposeRule({
        slug: policy.slug,
        title: policy.title,
        summary: "",
        body: "body",
        sourceRef: "test",
        idempotencyKey: "bad",
      }),
    ).rejects.toMatchObject({ code: "ADM_INVALID_METADATA" });
  });

  it("rejects a published rule response or premature publication read-back", async () => {
    const api = rest({
      proposeRule: vi.fn(async () => ({ itemId: policy.id, revisionId: "r1", status: "published" as const })),
    });
    await expect(
      createAdmKnowledgeAdapter(api).proposeRule({
        slug: policy.slug,
        title: policy.title,
        summary: "",
        body: "body",
        sourceRef: "test",
        idempotencyKey: "ope-9262:rule:2",
      }),
    ).rejects.toMatchObject({ code: "ADM_FORBIDDEN" });

    const prematurePublishedApi = rest({
      proposeRule: vi.fn(async () => ({ itemId: policy.id, revisionId: "r2", status: "proposed" as const })),
      read: vi.fn(async () => ({ ...policy, deliveredRevisionId: "r2", status: "published" })),
    });
    await expect(
      createAdmKnowledgeAdapter(prematurePublishedApi).proposeRule({
        slug: policy.slug,
        title: policy.title,
        summary: "",
        body: "body",
        sourceRef: "test",
        idempotencyKey: "ope-9262:rule:3",
      }),
    ).rejects.toMatchObject({ code: "ADM_FORBIDDEN" });
  });

  it("maps 403 knowledge_rule_approve_forbidden to ADM_FORBIDDEN", async () => {
    const forbiddenErr = new Error("knowledge_rule_approve_forbidden: owner only");
    Object.assign(forbiddenErr, { status: 403 });
    const api = rest({
      proposeRule: vi.fn(async () => {
        throw forbiddenErr;
      }),
    });
    const adapter = createAdmKnowledgeAdapter(api);
    await expect(
      adapter.proposeRule({
        slug: policy.slug,
        title: policy.title,
        summary: "",
        body: "body",
        sourceRef: "test",
        idempotencyKey: "ope-9877:forbidden:1",
      }),
    ).rejects.toMatchObject({ code: "ADM_FORBIDDEN" });
  });

  it("supports idempotency deduplication returning cached result without calling upstream twice", async () => {
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
    expect(api.proposeRule).toHaveBeenCalledTimes(1);

    // With a different idempotency key, upstream is called again
    await adapter.proposeRule({
      slug: policy.slug,
      title: policy.title,
      summary: policy.summary ?? "",
      body: "Rule body",
      sourceRef: "test",
      idempotencyKey: "ope-9877:idempotency:different-key",
    });
    expect(api.proposeRule).toHaveBeenCalledTimes(2);
  });

  it("proves exactly-once effect and stable replay with stateful upstream across adapter instances", async () => {
    const proposals = new Map<string, AdmWriteResult>();
    const statefulRest: AdmKnowledgeRestPort = {
      search: vi.fn(async () => []),
      list: vi.fn(async () => []),
      read: vi.fn(async (id) => {
        for (const p of proposals.values()) {
          if (p.itemId === id) {
            return {
              ...policy,
              id: p.itemId,
              deliveredRevisionId: p.revisionId,
              status: "proposed",
            } as AdmKnowledgeItem;
          }
        }
        return null;
      }),
      proposeRule: vi.fn(async (input) => {
        const existing = proposals.get(input.idempotencyKey);
        if (existing) return existing;
        const result: AdmWriteResult = {
          itemId: `rule-${proposals.size + 1}`,
          revisionId: `rev-${proposals.size + 1}`,
          status: "proposed",
        };
        proposals.set(input.idempotencyKey, result);
        return result;
      }),
    };

    const adapter1 = createAdmKnowledgeAdapter(statefulRest);
    const adapter2 = createAdmKnowledgeAdapter(statefulRest);
    const key = "ope-9877:stateful-replay:1";

    const res1 = await adapter1.proposeRule({
      slug: policy.slug,
      title: policy.title,
      summary: policy.summary ?? "",
      body: "Rule body",
      sourceRef: "test",
      idempotencyKey: key,
    });
    const res2 = await adapter2.proposeRule({
      slug: policy.slug,
      title: policy.title,
      summary: policy.summary ?? "",
      body: "Rule body",
      sourceRef: "test",
      idempotencyKey: key,
    });

    expect(res1).toEqual(res2);
    expect(proposals.size).toBe(1);
    expect(statefulRest.proposeRule).toHaveBeenCalledTimes(2);
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
      slug: lesson.slug,
      title: "Lesson",
      summary: "",
      body: "Observed.",
      sourceRef: "test",
      idempotencyKey: "ope-9262:lesson:1",
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
    await expect(
      createAdmKnowledgeAdapter(missingApi).writeLesson({
        slug: lesson.slug,
        title: "Lesson",
        summary: "",
        body: "Observed.",
        sourceRef: "test",
        idempotencyKey: "ope-9262:lesson:2",
      }),
    ).rejects.toMatchObject({ code: "ADM_UPSTREAM_UNAVAILABLE" });

    const mismatchApi = rest({
      writeLesson: vi.fn(async () => ({ itemId: lesson.id, revisionId: "lesson-r1", status: "published" as const })),
      read: vi.fn(async () => ({ ...lesson, deliveredRevisionId: "stale-revision" })),
    });
    await expect(
      createAdmKnowledgeAdapter(mismatchApi).writeLesson({
        slug: lesson.slug,
        title: "Lesson",
        summary: "",
        body: "Observed.",
        sourceRef: "test",
        idempotencyKey: "ope-9262:lesson:3",
      }),
    ).rejects.toMatchObject({ code: "ADM_UPSTREAM_UNAVAILABLE" });
  });

  it("handles base-revision conflict by rereading, calculating diff (summary and body), and reproposing", async () => {
    let callCount = 0;
    const latestPolicy: AdmKnowledgeItem = {
      ...policy,
      deliveredRevisionId: "rev-2",
      summary: "Updated deployment policy v2",
      content: "Old body content v2",
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
    const result = await adapter.proposeRuleWithConflictRetry(
      {
        itemId: policy.id,
        slug: policy.slug,
        title: policy.title,
        summary: "Updated deployment policy v3",
        body: "Never deploy on Friday without owner sign-off.",
        sourceRef: "OPE-9262",
        baseRevisionId: "rev-1",
        idempotencyKey: "ope-9262:rule:conflict-1",
      },
      "ope-9262:rule:conflict-2",
    );

    expect(result.conflictResolved).toBe(true);
    expect(result.diff).toContain("base: rev-1");
    expect(result.diff).toContain("latest: rev-2");
    expect(result.diff).toContain("Old body content v2");
    expect(result.diff).toContain("Never deploy on Friday without owner sign-off.");
    expect(result.result.status).toBe("proposed");
    expect(api.proposeRule).toHaveBeenCalledTimes(2);
    expect(api.proposeRule).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseRevisionId: "rev-2",
        idempotencyKey: "ope-9262:rule:conflict-2",
      }),
    );
  });

  it("handles conflict retry when deliveredRevisionId is absent, falling back to revisionId", async () => {
    let callCount = 0;
    const latestPolicy: AdmKnowledgeItem = {
      ...policy,
      deliveredRevisionId: null,
      revisionId: "draft-rev-9",
      summary: "Draft revision 9",
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
        return { itemId: policy.id, revisionId: "rev-10", status: "proposed" as const };
      }),
    });
    const adapter = createAdmKnowledgeAdapter(api);
    const result = await adapter.proposeRuleWithConflictRetry(
      {
        itemId: policy.id,
        slug: policy.slug,
        title: policy.title,
        summary: "Updated proposal",
        body: "New body",
        sourceRef: "OPE-9877",
        idempotencyKey: "ope-9877:retry-no-deliv:1",
      },
      "ope-9877:retry-no-deliv:2",
    );

    expect(result.conflictResolved).toBe(true);
    expect(api.proposeRule).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseRevisionId: "draft-rev-9",
        idempotencyKey: "ope-9877:retry-no-deliv:2",
      }),
    );
  });

  it("propagates ADM_REVISION_CONFLICT if conflict retry encounters a secondary conflict", async () => {
    const latestPolicy: AdmKnowledgeItem = {
      ...policy,
      deliveredRevisionId: "rev-2",
    };
    const api = rest({
      read: vi.fn(async () => latestPolicy),
      proposeRule: vi.fn(async () => {
        const err = new Error("Conflict");
        Object.assign(err, { status: 409 });
        throw err;
      }),
    });
    const adapter = createAdmKnowledgeAdapter(api);
    await expect(
      adapter.proposeRuleWithConflictRetry(
        {
          slug: policy.slug,
          title: policy.title,
          summary: "Summary",
          body: "Body",
          sourceRef: "OPE-9877",
          idempotencyKey: "ope-9877:abort-conflict:1",
          onConflict: () => false,
        },
        "ope-9877:abort-conflict:2",
      ),
    ).rejects.toMatchObject({ code: "ADM_REVISION_CONFLICT" });
  });

  it("rejects conflict retry if onConflict callback is missing (owner approval gate enforced)", async () => {
    const latestPolicy: AdmKnowledgeItem = {
      ...policy,
      deliveredRevisionId: "rev-2",
      summary: "Updated deployment policy v2",
      content: "Old body content v2",
    };
    const api = rest({
      proposeRule: vi.fn(async () => {
        throw new AdmConnectorError("ADM_REVISION_CONFLICT", "Conflict detected");
      }),
      read: vi.fn(async () => latestPolicy),
    });
    const adapter = createAdmKnowledgeAdapter(api);
    await expect(
      adapter.proposeRuleWithConflictRetry(
        {
          slug: policy.slug,
          title: policy.title,
          summary: "Summary",
          body: "Body",
          sourceRef: "OPE-9877",
          idempotencyKey: "ope-9877:missing-onconflict:1",
        } as any,
        "ope-9877:missing-onconflict:2",
      ),
    ).rejects.toMatchObject({
      code: "ADM_REVISION_CONFLICT",
      message: expect.stringContaining("requires owner approval callback"),
    });
  });

  it("destructures cleanly without breaking this context", async () => {
    const api = rest();
    const { proposeRule } = createAdmKnowledgeAdapter(api);
    const res = await proposeRule({
      slug: policy.slug,
      title: policy.title,
      summary: policy.summary ?? "",
      body: "Body",
      sourceRef: "test",
      idempotencyKey: "ope-9877:destruct:1",
    });
    expect(res.status).toBe("proposed");
  });

  it("maps REST failures to stable connector error codes without leaking upstream messages", async () => {
    const upstream = Object.assign(new Error("secret token must not escape"), { status: 429 });
    const adapter = createAdmKnowledgeAdapter(rest({ list: vi.fn(async () => { throw upstream; }) }));
    await expect(adapter.list("policy")).rejects.toMatchObject({ code: "ADM_RATE_LIMITED", message: "ADM knowledge request failed" });
  });

  it("calls onConflict callback with generated diff for human review before retry", async () => {
    let callCount = 0;
    const latestPolicy: AdmKnowledgeItem = {
      ...policy,
      deliveredRevisionId: "rev-2",
      summary: "Updated deployment policy v2",
      content: "Old body content v2",
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
    let reviewedDiff = "";
    const adapter = createAdmKnowledgeAdapter(api);
    const result = await adapter.proposeRuleWithConflictRetry(
      {
        itemId: policy.id,
        slug: policy.slug,
        title: policy.title,
        summary: "Updated deployment policy v3",
        body: "Never deploy on Friday without owner sign-off.",
        sourceRef: "OPE-9877",
        baseRevisionId: "rev-1",
        idempotencyKey: "ope-9877:review-conflict:1",
        onConflict: (diff) => {
          reviewedDiff = diff;
          return true;
        },
      },
      "ope-9877:review-conflict:2",
    );

    expect(result.conflictResolved).toBe(true);
    expect(reviewedDiff).toContain("base: rev-1");
    expect(reviewedDiff).toContain("latest: rev-2");
    expect(reviewedDiff).toContain("Never deploy on Friday without owner sign-off.");
  });

  it("aborts conflict retry with ADM_REVISION_CONFLICT if onConflict callback returns false", async () => {
    const latestPolicy: AdmKnowledgeItem = {
      ...policy,
      deliveredRevisionId: "rev-2",
      summary: "Updated deployment policy v2",
      content: "Old body content v2",
    };
    const api = rest({
      read: vi.fn(async () => latestPolicy),
      proposeRule: vi.fn(async () => {
        const err = new Error("Conflict");
        Object.assign(err, { status: 409 });
        throw err;
      }),
    });
    const adapter = createAdmKnowledgeAdapter(api);
    await expect(
      adapter.proposeRuleWithConflictRetry(
        {
          itemId: policy.id,
          slug: policy.slug,
          title: policy.title,
          summary: "Summary",
          body: "Body",
          sourceRef: "OPE-9877",
          idempotencyKey: "ope-9877:abort-conflict:1",
          onConflict: () => false,
        },
        "ope-9877:abort-conflict:2",
      ),
    ).rejects.toMatchObject({ code: "ADM_REVISION_CONFLICT" });
  });

  it("integrates with production hook interface via createHookLoader", async () => {
    const api = rest({
      list: vi.fn(async () => [policy]),
    });
    const adapter = createAdmKnowledgeAdapter(api);
    const loader = adapter.createHookLoader();
    const loaded = await loader({ event: "SessionStart", triggers: [] });
    expect(loaded.degraded).toBe(false);
    expect(loaded.items).toHaveLength(1);
    expect(loaded.items[0]?.slug).toBe(policy.slug);

    const failingApi = rest({
      list: vi.fn(async () => { throw new Error("Network down"); }),
    });
    const failingLoader = createAdmKnowledgeAdapter(failingApi).createHookLoader();
    const degradedResult = await failingLoader({ event: "SessionStart", triggers: [] });
    expect(degradedResult.degraded).toBe(true);
    expect(degradedResult.items).toHaveLength(0);
  });
});

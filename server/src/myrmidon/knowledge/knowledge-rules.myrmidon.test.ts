// server/src/myrmidon/knowledge/knowledge-rules.myrmidon.test.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-3): the rules layer — `approver_kind` derived
// from the caste directory (§3.1), the resolver the delivery path reads
// (`knowledge.rules.resolved(nest, caste)`) and the delivered REGULATIONS.md
// form with its `Source:` line. No database: the read port is a fake.
//
// The acceptance criteria this file pins (§6 K-3):
//   - "approve правила SMM оператором → 403, владельцем → ok": the SMM caste is
//     sensitive, so its rules ask for `owner` and the board operator presenting
//     `operator` is refused by the code, not by a convention;
//   - "REGULATIONS.md байт в байт тот же при тех же Approved": rendering twice
//     from the same revisions gives the same bytes;
//   - "строка `Source:` в каждой секции" and "wikiPageId = slug".

import { describe, expect, it } from "vitest";
import { KnowledgeDomainError, assertApprovable } from "./domain.js";
import { canApproveRule, resolvedRules, ruleApproverKind, type RulesReadPort } from "./rules.js";
import { renderRegulationsMarkdown } from "../wiki-cortex/render.js";
import { approvedRegulationFromRule } from "../wiki-cortex/delivery.js";
import type { KnowledgeItemDto, KnowledgeRevisionDto } from "./store.js";

const SENSITIVE = { sensitive: new Set(["smm"]) };

function item(over: Partial<KnowledgeItemDto> & { slug: string }): KnowledgeItemDto {
  return {
    id: `item-${over.slug}`,
    companyId: "co-1",
    nestId: "co-1",
    kind: "rule",
    title: over.slug,
    summary: null,
    status: "published",
    folderPath: "",
    tags: [],
    roles: [],
    approvalRequired: true,
    approverKind: "operator",
    deliveredRevisionId: null,
    currentRevisionNumber: 1,
    supersededByItemId: null,
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    ...over,
  };
}

function revision(over: Partial<KnowledgeRevisionDto> & { id: string; itemId: string }): KnowledgeRevisionDto {
  return {
    revisionNumber: 1,
    status: "approved",
    content: "text",
    changeSummary: null,
    rolledBackFromRevisionId: null,
    approvedByKind: "owner",
    approvedBy: "user-1",
    approvedAt: "2026-10-10T00:00:00.000Z",
    createdAt: "2026-10-10T00:00:00.000Z",
    sources: [],
    ...over,
  };
}

function port(items: KnowledgeItemDto[], revisions: KnowledgeRevisionDto[]): RulesReadPort {
  return {
    async listItems(filter) {
      return items.filter((entry) => (!filter?.kind || entry.kind === filter.kind) && (!filter?.status || entry.status === filter.status));
    },
    async listRevisions(idOrSlug) {
      const id = items.find((entry) => entry.id === idOrSlug || entry.slug === idOrSlug)?.id;
      return revisions.filter((entry) => entry.itemId === id);
    },
  };
}

describe("ruleApproverKind: the approver comes from the caste directory, never from the caller", () => {
  it("hands a sensitive caste's rules to the owner and every other caste's to the operator", () => {
    expect(ruleApproverKind(["smm"], SENSITIVE)).toBe("owner");
    expect(ruleApproverKind(["engineer"], SENSITIVE)).toBe("operator");
    // One sensitive caste in the audience is enough: the rule binds it.
    expect(ruleApproverKind(["engineer", "smm"], SENSITIVE)).toBe("owner");
    // `*` names no sensitive caste: the company's own general rules stay the
    // board operator's (the owner reserved platform/SMM rules, not every rule).
    expect(ruleApproverKind(["*"], SENSITIVE)).toBe("operator");
  });
});

describe("approving a rule (S4 + §3.1)", () => {
  it("refuses the SMM rule to the board operator and lets the owner through", () => {
    const approverKind = ruleApproverKind(["smm"], SENSITIVE);
    const rule = { kind: "rule", approvalRequired: true, approverKind } as const;
    const operator = { actorType: "user", actorId: "user-op", kind: "operator" } as const;
    const owner = { actorType: "user", actorId: "user-owner", kind: "owner" } as const;

    expect(() => assertApprovable(rule, operator)).toThrow(KnowledgeDomainError);
    try {
      assertApprovable(rule, operator);
    } catch (error) {
      expect((error as KnowledgeDomainError).status).toBe(403);
    }
    expect(() => assertApprovable(rule, owner)).not.toThrow();
    expect(canApproveRule(approverKind, operator)).toBe(false);
    expect(canApproveRule(approverKind, owner)).toBe(true);
    // A higher grade covers a lower requirement; an agent presenting its caste
    // key covers nothing.
    expect(canApproveRule("operator", owner)).toBe(true);
    expect(canApproveRule("operator", { actorType: "agent", actorId: "a-1", kind: "smm" })).toBe(false);
  });
});

describe("resolvedRules: the resolver the delivery path asks", () => {
  it("returns the delivered revision of the published rules of the caste, and of the company-wide ones", async () => {
    const smm = item({ slug: "rules/smm/publications", title: "Публикации", roles: ["smm"], deliveredRevisionId: "rev-smm" });
    const everyone = item({ slug: "rules/tone", title: "Tone of voice", roles: ["*"], deliveredRevisionId: "rev-all" });
    const engineers = item({ slug: "rules/engineer/deploy", title: "Deploy", roles: ["engineer"], deliveredRevisionId: "rev-eng" });
    const draft = item({ slug: "rules/smm/draft", roles: ["smm"], status: "draft", deliveredRevisionId: "rev-draft" });
    const undelivered = item({ slug: "rules/smm/empty", roles: ["smm"], deliveredRevisionId: null });
    const revisions = [
      revision({ id: "rev-smm", itemId: smm.id, revisionNumber: 3, content: "publish only after review", sources: [{ kind: "decision", ref: "DECISIONS#29.09", note: null }] }),
      revision({ id: "rev-all", itemId: everyone.id, content: "be plain", sources: [] }),
      revision({ id: "rev-eng", itemId: engineers.id, content: "run the checks" }),
      revision({ id: "rev-draft", itemId: draft.id, content: "not yet" }),
    ];

    const resolved = await resolvedRules(port([smm, everyone, engineers, draft, undelivered], revisions), "smm");
    expect(resolved.map((rule) => rule.slug)).toEqual(["rules/smm/publications", "rules/tone"]);
    const [first] = resolved;
    expect(first).toMatchObject({ pageId: smm.id, title: "Публикации", revisionNumber: 3, roles: ["smm"] });
    expect(first!.sources).toEqual([{ kind: "decision", ref: "DECISIONS#29.09", note: null }]);

    const engineerRules = await resolvedRules(port([smm, everyone, engineers], revisions), "engineer");
    expect(engineerRules.map((rule) => rule.slug)).toEqual(["rules/engineer/deploy", "rules/tone"]);
  });
});

describe("REGULATIONS.md (the delivered form)", () => {
  const smm = item({ slug: "rules/smm/publications", title: "Публикации", roles: ["smm"], deliveredRevisionId: "rev-smm" });
  const revisions = [
    revision({ id: "rev-smm", itemId: smm.id, revisionNumber: 3, content: "publish only after review", sources: [{ kind: "decision", ref: "DECISIONS#29.09", note: null }] }),
  ];
  const deliver = async () => (await resolvedRules(port([smm], revisions), "smm")).map(approvedRegulationFromRule);

  it("names the page it was read from in every section, and the provenance the revision carries", async () => {
    const resolved = await resolvedRules(port([smm], revisions), "smm");
    const markdown = renderRegulationsMarkdown(await deliver());
    expect(markdown).toContain("## Публикации");
    expect(markdown).toContain("Source: rules/smm/publications · revision 3");
    expect(markdown).toContain("Provenance: decision:DECISIONS#29.09");
    expect(markdown).toContain("publish only after review");
    // wikiPageId = slug: the page key is the id the section names.
    expect(resolved[0]!.pageId).toBe(resolved[0]!.slug);
  });

  it("renders the same approved set byte for byte, twice", async () => {
    const first = renderRegulationsMarkdown(await deliver());
    const second = renderRegulationsMarkdown(await deliver());
    expect(second).toBe(first);
  });
});
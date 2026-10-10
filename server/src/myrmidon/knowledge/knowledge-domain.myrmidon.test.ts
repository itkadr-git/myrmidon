// server/src/myrmidon/knowledge/knowledge-domain.myrmidon.test.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-1): the pure domain — state machine (§2.4),
// invariants (§3.2), the S1–S9 rules (§3.3) and the canonical markdown-tree
// serialization. No database: everything here runs from plain objects.
//
// The 1 000-page acceptance criterion ("дерево 1 000 синтетических страниц
// < 300 мс p95") is measured on serializeKnowledgeTree, which is where the
// whole tree is assembled; the store's export reuses the same pure builder.

import { describe, expect, it } from "vitest";
import {
  KnowledgeDomainError,
  assertApprovable,
  assertItemTransition,
  assertRevisionTransition,
  assertRuleFields,
  assertSingleLine,
  assertValidSlug,
  canTransitionItem,
  draftPointerFields,
  extractLinkTargets,
  isKnowledgeItemStatus,
  isKnowledgeKind,
  normalizeLinkTarget,
  parseKnowledgeTree,
  planRollback,
  serializeKnowledgeTree,
  type KnowledgeTreePage,
} from "./domain.js";

const page = (over: Partial<KnowledgeTreePage> = {}): KnowledgeTreePage => ({
  slug: "a-page",
  title: "A page",
  summary: null,
  kind: "note",
  folder: "",
  tags: [],
  status: "draft",
  approvalRequired: false,
  approverKind: null,
  deliverToCastes: [], // myrmidon(1.7 KNOWLEDGE-2.0 L-3)
  content: "Body text.\n",
  ...over,
});

describe("knowledge domain — slugs and single-line metadata", () => {
  it("accepts slash slugs and refuses anything else", () => {
    assertValidSlug("ops/runbooks/db");
    assertValidSlug("x1");
    expect(() => assertValidSlug("Ops")).toThrowError(KnowledgeDomainError);
    expect(() => assertValidSlug("/lead")).toThrow(/invalid_slug|Slug/);
    expect(() => assertValidSlug("trailing/")).toThrow(/Slug/);
    expect(() => assertValidSlug("with space")).toThrow(/Slug/);
  });

  it("single-line fields must be non-empty and newline-free", () => {
    assertSingleLine("Title", "Title");
    expect(() => assertSingleLine("", "Title")).toThrow(/must not be empty/);
    expect(() => assertSingleLine("a\nb", "Title")).toThrow(/single line/);
  });

  it("status/kind guards", () => {
    expect(isKnowledgeKind("rule")).toBe(true);
    expect(isKnowledgeKind("meme")).toBe(false);
    expect(isKnowledgeItemStatus("superseded")).toBe(true);
    expect(isKnowledgeItemStatus("deleted")).toBe(false);
  });
});

describe("knowledge domain — [[…]] link syntax", () => {
  it("extracts normalized targets, stripping alias and anchor, deduped in order", () => {
    const text = "See [[run/a]] then [[run/b|the B runbook]] and [[run/a#x]] plus [[run/c]].";
    expect(extractLinkTargets(text)).toEqual(["run/a", "run/b", "run/c"]);
  });

  it("normalizeLinkTarget handles empty/garbage targets", () => {
    expect(normalizeLinkTarget("  ")).toBeNull();
    expect(normalizeLinkTarget("x|y#z")).toBe("x");
  });
});

describe("knowledge domain — item state machine (§2.4)", () => {
  it("legal edges", () => {
    expect(canTransitionItem("draft", "in_review")).toBe(true);
    expect(canTransitionItem("draft", "published")).toBe(true);
    expect(canTransitionItem("in_review", "draft")).toBe(true);
    expect(canTransitionItem("published", "archived")).toBe(true);
    expect(canTransitionItem("archived", "published")).toBe(true); // restore
    expect(canTransitionItem("archived", "superseded")).toBe(true);
  });

  it("illegal edges throw 409", () => {
    expect(() => assertItemTransition("superseded", "draft")).toThrow(/invalid_status_transition|cannot move/);
    expect(() => assertItemTransition("published", "draft")).toThrow(/cannot move/);
    expect(() => assertItemTransition("in_review", "superseded")).toThrow(/cannot move/);
  });

  it("revision lifecycle: approved is final, draft/submitted flow", () => {
    assertRevisionTransition("draft", "submitted");
    assertRevisionTransition("submitted", "approved");
    expect(() => assertRevisionTransition("approved", "draft")).toThrow(/invalid_status_transition|cannot move/);
  });
});

describe("knowledge domain — approval gate (S4, the 403 criterion)", () => {
  const rule = { kind: "rule" as const, approvalRequired: true, approverKind: "lead" };

  it("approval-required WITHOUT approver_kind is 403", () => {
    let caught: unknown;
    try {
      assertApprovable({ kind: "note", approvalRequired: true, approverKind: null }, { actorType: "user", actorId: "u", kind: "lead" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KnowledgeDomainError);
    expect((caught as KnowledgeDomainError).status).toBe(403);
    expect((caught as KnowledgeDomainError).code).toBe("rule_requires_approver_kind");
  });

  it("approver kind must match the rule's approver_kind", () => {
    expect(() => assertApprovable(rule, { actorType: "user", actorId: "u", kind: "eng" })).toThrow(/requires kind/);
    assertApprovable(rule, { actorType: "user", actorId: "u", kind: "lead" });
  });

  it("items without approval requirements always pass", () => {
    assertApprovable({ kind: "note", approvalRequired: false, approverKind: null }, { actorType: "agent", actorId: null, kind: null });
  });

  it("rules must demand approval AND an approver kind up front", () => {
    let a: unknown;
    try {
      assertRuleFields("rule", false, "lead");
    } catch (error) {
      a = error;
    }
    expect((a as KnowledgeDomainError).code).toBe("rule_requires_approval");
    let b: unknown;
    try {
      assertRuleFields("rule", true, null);
    } catch (error) {
      b = error;
    }
    expect((b as KnowledgeDomainError).code).toBe("rule_requires_approver_kind");
    assertRuleFields("note", false, null);
  });
});

describe("knowledge domain — rollback plan (S5)", () => {
  it("a rollback is one MORE revision (a copy) — never a pointer move back", () => {
    const plan = planRollback(
      { deliveredRevisionId: "rev-4", currentRevisionNumber: 4 },
      { revisionId: "rev-2", revisionNumber: 2, status: "approved" },
    );
    expect(plan.newRevisionNumber).toBe(5);
    expect(plan.rolledBackFromRevisionId).toBe("rev-2");
  });

  it("rolling back onto an unapproved revision is refused", () => {
    expect(() =>
      planRollback(
        { deliveredRevisionId: "rev-2", currentRevisionNumber: 2 },
        { revisionId: "rev-1", revisionNumber: 1, status: "draft" },
      ),
    ).toThrow(/approved/);
  });

  it("a rollback to the already-delivered revision is a no-op error", () => {
    expect(() =>
      planRollback(
        { deliveredRevisionId: "rev-2", currentRevisionNumber: 2 },
        { revisionId: "rev-2", revisionNumber: 2, status: "approved" },
      ),
    ).toThrow(/already/);
  });

  it("S3: the draft rule returns NO pointer fields", () => {
    expect(draftPointerFields()).toEqual({});
    expect("deliveredRevisionId" in draftPointerFields()).toBe(false);
  });
});

describe("knowledge domain — canonical markdown tree (export/import)", () => {
  it("serialize → parse round-trips and re-serializes byte-for-byte", () => {
    const doc = {
      nestId: "company-1",
      pages: [
        page({ slug: "run/a", title: "Runbook A" }),
        page({
          slug: "index",
          title: "Knowledge",
          content: "# Knowledge\n\nLinks [[run/a]].\n",
        }),
        page({
          slug: "rule/keep-it-simple",
          title: "Keep it simple",
          summary: "The rule of rules",
          kind: "rule",
          folder: "rule",
          tags: ["ops", "a"],
          approvalRequired: true,
          approverKind: "lead",
          status: "published",
          content: "## Steps\n\n1. do the thing\n",
        }),
      ],
    };
    const bytes = serializeKnowledgeTree(doc);
    const parsed = parseKnowledgeTree(bytes);
    // pages are canonical-sorted by slug
    expect(parsed.pages.map((p) => p.slug)).toEqual(["index", "rule/keep-it-simple", "run/a"]);
    expect(parsed.nestId).toBe("company-1");
    const reserialized = serializeKnowledgeTree(parsed);
    expect(reserialized.equals(bytes)).toBe(true);
    // metadata survives
    const rulePage = parsed.pages[1]!;
    expect(rulePage.tags).toEqual(["ops", "a"]);
    expect(rulePage.approverKind).toBe("lead");
    expect(rulePage.status).toBe("published");
    expect(rulePage.kind).toBe("rule");
    expect(parsed.pages[0]!.content).toContain("[[run/a]]");
  });

  it("body text containing pseudo-headers survives exactly", () => {
    const tricky = page({
      slug: "tricky",
      title: "Tricky",
      content: "leading\n--- item --- fake header\n=== myrmidon knowledge tree v1 === tail\nend\n",
    });
    const parsed = parseKnowledgeTree(serializeKnowledgeTree({ nestId: "n", pages: [tricky] }));
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0]!.content).toBe(tricky.content);
  });

  it("a foreign buffer fails closed", () => {
    expect(() => parseKnowledgeTree(Buffer.from("not a tree"))).toThrow(/knowledge tree/i);
    const good = serializeKnowledgeTree({ nestId: "n", pages: [page()] });
    // trailing garbage after the last page must not parse
    expect(() => parseKnowledgeTree(Buffer.concat([good, Buffer.from("junk\n")]))).toThrow(/page separator|knowledge tree/i);
  });

  it("1 000 synthetic pages serialize < 300 ms p95", () => {
    const pages: KnowledgeTreePage[] = Array.from({ length: 1000 }, (_, i) =>
      page({
        slug: `folder-${i % 17}/page-${String(i).padStart(4, "0")}`,
        title: `Page ${i}`,
        folder: `folder-${i % 17}`,
        tags: [`t${i % 7}`],
        content: `Body ${i} links [[folder-${(i + 1) % 17}/page-${String((i + 1) % 1000).padStart(4, "0")}]]\n`,
      }),
    );
    const durations: number[] = [];
    for (let run = 0; run < 21; run += 1) {
      const t0 = performance.now();
      const out = serializeKnowledgeTree({ nestId: "perf-nest", pages });
      const t1 = performance.now();
      expect(out.length).toBeGreaterThan(10_000);
      durations.push(t1 - t0);
    }
    // warm up once more before measuring to keep JIT noise out of the tail
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(300);
  });
});

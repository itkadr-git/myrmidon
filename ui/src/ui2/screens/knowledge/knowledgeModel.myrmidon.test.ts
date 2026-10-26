// ui/src/ui2/screens/knowledge/knowledgeModel.myrmidon.test.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-4): the acceptance criteria of the Knowledge
// screen as unit tests — the tree budget ("дерево < 300 мс"), `[[…]]` links,
// the sources panel, the revision diff and the rollback gate (A / O). The
// screen renders these decisions; if the model regresses, CI says which one.

import { describe, expect, it } from "vitest";
import { ui2Messages } from "../../i18n/locales";
import {
  KNOWLEDGE_TREE_BUDGET_MS,
  buildKnowledgeTree,
  diffKnowledgeRevisions,
  flattenKnowledgeTree,
  isKnowledgeReviewDue,
  knowledgeApproverLabelKey,
  knowledgeDiffChangeCount,
  knowledgeHref,
  knowledgeBodyToMarkdown,
  resolveKnowledgeMarkdownHref,
  knowledgeLinkLabel,
  knowledgeSourceLink,
  knowledgeStatusTone,
  knowledgeWriteGate,
  parseKnowledgeBody,
  pullRequestUrl,
  resolveKnowledgeLinkTarget,
  type KnowledgeBodySegment,
  type KnowledgeItemSummary,
} from "./knowledgeModel";

function item(overrides: Partial<KnowledgeItemSummary> = {}): KnowledgeItemSummary {
  return {
    id: overrides.id ?? overrides.slug ?? "id",
    spaceKey: overrides.spaceKey ?? "wiki",
    slug: overrides.slug ?? "page",
    title: overrides.title ?? "Page",
    parentSlug: overrides.parentSlug ?? null,
    status: overrides.status ?? "approved",
    revision: overrides.revision ?? 1,
    updatedAt: overrides.updatedAt ?? "2026-10-01T00:00:00.000Z",
  };
}

function links(segments: readonly KnowledgeBodySegment[]) {
  return segments.filter(
    (segment): segment is Extract<KnowledgeBodySegment, { type: "link" }> =>
      segment.type === "link",
  );
}

describe("myrmidon(1.6.6 KNOWLEDGE-2.0 K-4) knowledge tree", () => {
  it("nests children under their parent and keeps a cycle out of the tree", () => {
    const tree = buildKnowledgeTree([
      item({ slug: "root", title: "Root" }),
      item({ slug: "child-b", title: "B", parentSlug: "root" }),
      item({ slug: "child-a", title: "A", parentSlug: "root" }),
      item({ slug: "grand", title: "Grand", parentSlug: "child-a" }),
      item({ slug: "loop-a", title: "Loop A", parentSlug: "loop-b" }),
      item({ slug: "loop-b", title: "Loop B", parentSlug: "loop-a" }),
    ]);

    const space = tree.find((node) => node.item.spaceKey === "wiki");
    const root = space?.children.find((node) => node.item.slug === "root");
    expect(root?.depth).toBe(1);
    expect(root?.children.map((node) => node.item.slug)).toEqual(["child-a", "child-b"]);
    expect(root?.children[0]?.children.map((node) => node.item.slug)).toEqual(["grand"]);
    expect(root?.children[0]?.children[0]?.depth).toBe(3);

    // A parent chain that loops back remains visible without attaching into a cycle.
    expect(space?.children.map((node) => node.item.slug).sort()).toEqual(["loop-a", "loop-b", "root"]);
    expect(space?.children.find((node) => node.item.slug === "loop-a")?.children.map((node) => node.item.slug)).toEqual(["loop-b"]);
    const flattened = flattenKnowledgeTree(tree);
    expect(flattened.length).toBe(7);
  });

  it("nests slash-path pages into inferred folders and de-duplicates space/slug", () => {
    const tree = buildKnowledgeTree([
      item({ spaceKey: "docs", slug: "guides/index", title: "Guide index" }),
      item({ spaceKey: "docs", slug: "guides/setup", title: "Setup" }),
      item({ spaceKey: "docs", slug: "guides", title: "Guides" }),
      item({ spaceKey: "docs", slug: "guides/index", title: "Guide index duplicate" }),
      item({ spaceKey: "other", slug: "guides/index", title: "Other index" }),
    ]);
    const flattened = flattenKnowledgeTree(tree);
    const guides = flattened.find((node) => node.item.spaceKey === "docs" && node.item.slug === "guides");
    expect(guides?.children.map((node) => node.item.slug).sort()).toEqual(["guides/index", "guides/setup"]);
    expect(flattened.filter((node) => node.item.spaceKey === "docs" && node.item.slug === "guides/index")).toHaveLength(1);
    expect(flattened.find((node) => node.item.spaceKey === "docs" && node.item.slug === "guides/index")?.item.title).toBe("Guide index duplicate");
  });

  it("honors explicit parentSlug even when children arrive first and isolates spaces", () => {
    const tree = buildKnowledgeTree([
      item({ spaceKey: "docs", slug: "child", title: "Child", parentSlug: "parent" }),
      item({ spaceKey: "docs", slug: "parent", title: "Parent" }),
      item({ spaceKey: "other", slug: "child", title: "Other child", parentSlug: "parent" }),
    ]);
    const docs = tree.find((node) => node.item.spaceKey === "docs");
    const parent = docs?.children.find((node) => node.item.slug === "parent");
    expect(parent?.children.map((node) => node.item.slug)).toEqual(["child"]);
    expect(tree.find((node) => node.item.spaceKey === "other")?.children.map((node) => node.item.slug)).toEqual(["child"]);
  });

  it("catalogs visible UI labels and status text in English and Russian", () => {
    expect(ui2Messages.en["ui2.knowledge.sources.title"]).toBe("Sources");
    expect(ui2Messages.ru["ui2.knowledge.sources.title"]).toBe("Источники");
    expect(ui2Messages.ru["ui2.knowledge.item.status.pending_review"]).toBe("Требует одобрения");
    expect(ui2Messages.ru["ui2.knowledge.item.updated"]).toContain("Обновлено");
    expect(ui2Messages.ru["ui2.knowledge.item.reviewDue"]).toContain("пересмотреть");
  });


  it("builds a wide tree within the 300 ms budget of §6 K-4", () => {
    const items: KnowledgeItemSummary[] = [];
    for (let index = 0; index < 2000; index += 1) {
      items.push(
        item({
          slug: `leaf-${index}`,
          title: `Leaf ${index}`,
          parentSlug: index < 20 ? null : `leaf-${index % 20}`,
        }),
      );
    }
    const started = Date.now();
    const tree = buildKnowledgeTree(items);
    const elapsed = Date.now() - started;
    expect(tree.length).toBe(1);
    expect(flattenKnowledgeTree(tree).length).toBe(2001);
    expect(elapsed).toBeLessThan(KNOWLEDGE_TREE_BUDGET_MS);
  });
});

describe("myrmidon(1.6.6 KNOWLEDGE-2.0 K-4) [[…]] links", () => {
  it("turns a reference into a clickable segment with alias and anchor", () => {
    const segments = parseKnowledgeBody("See [[guide#top|the guide]] now");
    const [link] = links(segments);
    expect(link?.target).toBe("guide");
    expect(link?.anchor).toBe("top");
    expect(link?.raw).toBe("[[guide#top|the guide]]");
    expect(knowledgeLinkLabel(link!)).toBe("the guide");
    expect(link && knowledgeHref(resolveKnowledgeLinkTarget(link.target, "wiki", link.anchor)))
      .toBe("/knowledge/wiki/guide#top");
  });

  it("keeps code spans, fences and escaped brackets inert (§3.2)", () => {
    expect(links(parseKnowledgeBody("`[[in-code]]`"))).toHaveLength(0);
    expect(links(parseKnowledgeBody("```\n[[in-fence]]\n```"))).toHaveLength(0);
    expect(links(parseKnowledgeBody("\\[[not a link]]"))).toHaveLength(0);
    // The inert text survives rendering as plain text.
    const [first] = parseKnowledgeBody("`[[in-code]]`");
    expect(first?.type).toBe("text");
    expect(first && first.type === "text" ? first.text : "").toContain("[[in-code]]");
  });

  it("crosses spaces when the target carries a space key", () => {
    expect(resolveKnowledgeLinkTarget("decisions/adr-7", "wiki")).toEqual({
      spaceKey: "decisions",
      slug: "adr-7",
      anchor: null,
    });
    expect(knowledgeHref({ spaceKey: "wiki", slug: "a b", anchor: null })).toBe(
      "/knowledge/wiki/a%20b",
    );
    // OPE-9222: the current interface mounts the same screen at /wiki.
    expect(knowledgeHref({ spaceKey: "ops", slug: "a b", anchor: "x" }, "/wiki")).toBe(
      "/wiki/ops/a%20b#x",
    );
  });
});

describe("myrmidon(1.6.6 KNOWLEDGE-2.0 K-4) sources panel", () => {
  it("leads a source ref to the board route or the upstream URL", () => {
    expect(knowledgeSourceLink({ kind: "task", ref: "OPE-1" })).toEqual({
      kind: "internal",
      to: "/issues/OPE-1",
    });
    expect(knowledgeSourceLink({ kind: "PR", ref: "itkadr-git/myrmidon#1110" })).toEqual({
      kind: "external",
      href: "https://github.com/itkadr-git/myrmidon/pull/1110",
    });
    expect(knowledgeSourceLink({ kind: "decision", ref: "OPE-401" })).toEqual({
      kind: "internal",
      to: "/decisions",
    });
    expect(knowledgeSourceLink({ kind: "run", ref: "abc" })).toEqual({
      kind: "internal",
      to: "/runs/abc",
    });
    expect(knowledgeSourceLink({ kind: "url", ref: "https://example.test/x" })).toEqual({
      kind: "external",
      href: "https://example.test/x",
    });
    // Nothing to open stays plain text instead of a dead link.
    expect(knowledgeSourceLink({ kind: "url", ref: "" })).toBeNull();
    expect(knowledgeSourceLink({ kind: "lore", ref: "whatever" })).toBeNull();
    expect(pullRequestUrl("not-a-pr")).toBeNull();
  });
});

describe("myrmidon(1.6.6 KNOWLEDGE-2.0 K-4) revisions", () => {
  it("diffs two bodies line by line and counts the changed lines", () => {
    const diff = diffKnowledgeRevisions("a\nb\nc", "a\nc\nd");
    expect(diff).toEqual([
      { kind: "same", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
    expect(knowledgeDiffChangeCount(diff)).toBe(2);
    expect(knowledgeDiffChangeCount(diffKnowledgeRevisions("x", "x"))).toBe(0);
  });

  it("falls back to a trimmed comparison for a pathological page", () => {
    const head = Array.from({ length: 700 }, (_, index) => `line ${index}`);
    const tail = Array.from({ length: 700 }, (_, index) => `tail ${index}`);
    const diff = diffKnowledgeRevisions([...head, ...tail].join("\n"), [...head, "changed", ...tail].join("\n"));
    // 1400 lines a side: the full LCS is skipped, only the changed line shows.
    expect(knowledgeDiffChangeCount(diff)).toBe(1);
    expect(diff.filter((line) => line.kind === "add").map((line) => line.text)).toEqual(["changed"]);
  });

  it("flags a re-review only once it is due", () => {
    const now = new Date("2026-10-09T18:00:00.000Z");
    expect(isKnowledgeReviewDue({ reviewDueAt: "2026-10-09T17:59:59.000Z" }, now)).toBe(true);
    expect(isKnowledgeReviewDue({ reviewDueAt: "2026-10-09T18:00:00.000Z" }, now)).toBe(true);
    expect(isKnowledgeReviewDue({ reviewDueAt: "2026-10-10T00:00:00.000Z" }, now)).toBe(false);
    expect(isKnowledgeReviewDue({ reviewDueAt: null }, now)).toBe(false);
    expect(isKnowledgeReviewDue({}, now)).toBe(false);
  });
});

describe("myrmidon(1.6.6 KNOWLEDGE-2.0 K-4) write gate (A / O)", () => {
  it("lets the carrier write on its own and names the approver otherwise", () => {
    const byAgent = knowledgeWriteGate({ approverKind: "a", verdict: "allowed" });
    expect(byAgent).toEqual({
      allowed: true,
      approverKind: "agent",
      mode: "A",
      reasonKey: "ui2.knowledge.action.allowed",
    });
    const byOperator = knowledgeWriteGate({ approverKind: "o", verdict: "allowed" });
    expect(byOperator.mode).toBe("O");
    expect(byOperator.approverKind).toBe("operator");
  });

  it("keeps the verb disabled and names who has to approve", () => {
    const pending = knowledgeWriteGate({ approverKind: "owner", verdict: "approval_required" });
    expect(pending.allowed).toBe(false);
    expect(pending.approverKind).toBe("owner");
    expect(pending.mode).toBe("O");
    expect(pending.reasonKey).toBe("ui2.knowledge.action.needsApproval");

    const unknown = knowledgeWriteGate({ approverKind: "owner", verdict: "something-new" });
    expect(unknown.allowed).toBe(false);
    expect(unknown.reasonKey).toBe("ui2.knowledge.action.needsApproval");

    const forbidden = knowledgeWriteGate({ verdict: "forbidden" });
    expect(forbidden.allowed).toBe(false);
    expect(forbidden.approverKind).toBe("owner");
    expect(forbidden.reasonKey).toBe("ui2.knowledge.action.forbidden");
  });

  it("points every returned catalog key at both catalogs", () => {
    const keys = [
      knowledgeWriteGate({ verdict: "allowed" }).reasonKey,
      knowledgeWriteGate({ verdict: "forbidden" }).reasonKey,
      knowledgeWriteGate({}).reasonKey,
      knowledgeApproverLabelKey("agent"),
      knowledgeApproverLabelKey("operator"),
      knowledgeApproverLabelKey("owner"),
    ];
    for (const key of keys) {
      expect(ui2Messages.en[key as keyof typeof ui2Messages.en]).toBeTruthy();
      expect(ui2Messages.ru[key as keyof typeof ui2Messages.ru]).toBeTruthy();
    }
    expect(knowledgeStatusTone("approved")).toBe("ok");
    expect(knowledgeStatusTone("draft")).toBe("warning");
    expect(knowledgeStatusTone("archived")).toBe("muted");
  });
});
describe("OPE-5957 markdown body", () => {
  it("rewrites [[wiki]] links to markdown links on the screen's routes and keeps code intact", () => {
    const md = knowledgeBodyToMarkdown(
      parseKnowledgeBody("# Backups\nSee [[servers/vm-core|vm-core]] and `[[not]]`.\n"),
      "infra",
      "/wiki",
    );
    expect(md).toBe("# Backups\nSee [vm-core](/wiki/servers/vm-core) and `[[not]]`.\n");
  });

  it("resolves relative .md links against the folder of the page", () => {
    expect(resolveKnowledgeMarkdownHref("../servers/vm-core.md", "infra/backups")).toEqual({
      spaceKey: "infra/servers",
      slug: "vm-core",
      anchor: null,
    });
    expect(resolveKnowledgeMarkdownHref("other.md#top", "ops")).toEqual({
      spaceKey: "ops",
      slug: "other",
      anchor: "top",
    });
    expect(resolveKnowledgeMarkdownHref("https://example.com/a.md", "ops")).toBeNull();
    expect(resolveKnowledgeMarkdownHref("#x", "ops")).toBeNull();
    expect(resolveKnowledgeMarkdownHref("../../../x.md", "ops")).toBeNull();
    expect(resolveKnowledgeMarkdownHref("file.pdf", "ops")).toBeNull();
  });
});

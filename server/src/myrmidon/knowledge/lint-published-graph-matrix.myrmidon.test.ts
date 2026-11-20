import { describe, expect, it } from "vitest";
import { lintKnowledgePages, type KnowledgeLintFinding, type KnowledgeLintPage, type KnowledgeLintReport } from "./lint.js";

const statuses = ["draft", "in_review", "archived", "superseded"] as const;
const source = { kind: "document", ref: "spec" };
const page = (slug: string, content: string, status: KnowledgeLintPage["status"] = "published", sources: KnowledgeLintPage["sources"] = [source]): KnowledgeLintPage => ({ slug, content, status, sources });
const orphan = (slug: string): KnowledgeLintFinding => ({ kind: "orphan", slug, suggestion: "Add an inbound [[link]] from a related page or mark this page archived." });
const unresolved = (slug: string, target: string): KnowledgeLintFinding => ({ kind: "unresolved_link", slug, target, suggestion: `Create a published page for [[${target}]] or remove the link.` });

function checkFrozenPermutations(pages: KnowledgeLintPage[], expected: KnowledgeLintReport) {
  for (const item of pages) {
    for (const reference of item.sources) Object.freeze(reference);
    Object.freeze(item.sources);
    Object.freeze(item);
  }
  Object.freeze(pages);
  expect(lintKnowledgePages(pages)).toEqual(expected);
  expect(lintKnowledgePages(Object.freeze([...pages].reverse()))).toEqual(expected);
  if (pages.length > 1) {
    expect(lintKnowledgePages(Object.freeze([...pages.slice(1), pages[0]]))).toEqual(expected);
  }
}

describe("lint published knowledge graph", () => {
  it.each(statuses)("ignores inbound links from %s pages", (status) => {
    checkFrozenPermutations([page("published", ""), page("other", "[[published]]", status)], {
      findings: [orphan("published")],
      counts: { unresolved_link: 0, orphan: 1, missing_source: 0 },
    });
  });

  it.each(statuses)("reports published links to %s targets as unresolved", (status) => {
    checkFrozenPermutations([page("published", "[[other]]"), page("other", "", status)], {
      findings: [unresolved("published", "other"), orphan("published")],
      counts: { unresolved_link: 1, orphan: 1, missing_source: 0 },
    });
  });

  it("accepts mutual links between published pages and self-links as inbound", () => {
    checkFrozenPermutations([page("a", "[[b]]"), page("b", "[[a]]"), page("self", "[[self]]")], {
      findings: [], counts: { unresolved_link: 0, orphan: 0, missing_source: 0 },
    });
  });

  it("deduplicates alias and anchor targets per source, not across sources", () => {
    checkFrozenPermutations([
      page("a", "[[missing]] [[missing#part|alias]] [[missing|again]] [[b#part]]"),
      page("b", "[[missing|alias]] [[missing#other]] [[a]]", "published", []),
    ], {
      findings: [unresolved("a", "missing"), unresolved("b", "missing"), {
        kind: "missing_source", slug: "b", suggestion: "Attach at least one source reference before relying on this page.",
      }],
      counts: { unresolved_link: 2, orphan: 0, missing_source: 1 },
    });
  });

  it("returns an empty report for an empty snapshot and one with only unpublished pages", () => {
    const expected = { findings: [], counts: { unresolved_link: 0, orphan: 0, missing_source: 0 } };
    checkFrozenPermutations([], expected);
    checkFrozenPermutations(statuses.map((status) => page(status, "[[missing]]", status, [])), expected);
  });
});

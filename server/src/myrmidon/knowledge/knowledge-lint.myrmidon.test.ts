import { describe, expect, it } from "vitest";
import { lintKnowledgePages, type KnowledgeLintPage } from "./lint.js";

const page = (slug: string, content: string, sources: KnowledgeLintPage["sources"] = []): KnowledgeLintPage => ({
  slug,
  status: "published",
  content,
  sources,
});

describe("knowledge deterministic lint", () => {
  it("reports missing targets, disconnected published pages, and absent sources", () => {
    const report = lintKnowledgePages([
      page("a", "See [[missing]] and [[b]].", [{ kind: "document", ref: "spec" }]),
      page("b", "Connected.", [{ kind: "issue", ref: "OPE-1" }]),
      page("orphan", "No inbound links."),
    ]);

    expect(report.counts).toEqual({ unresolved_link: 1, orphan: 1, missing_source: 1 });
    expect(report.findings).toEqual([
      { kind: "unresolved_link", slug: "a", target: "missing", suggestion: "Create a published page for [[missing]] or remove the link." },
      { kind: "missing_source", slug: "orphan", suggestion: "Attach at least one source reference before relying on this page." },
      { kind: "orphan", slug: "orphan", suggestion: "Add an inbound [[link]] from a related page or mark this page archived." },
    ]);
  });

  it("ignores non-published pages and produces stable order", () => {
    const pages = [
      page("z", "See [[a]].", [{ kind: "url", ref: "https://example.test" }]),
      { ...page("a", "Draft."), status: "draft" as const },
    ];
    expect(lintKnowledgePages(pages)).toEqual(lintKnowledgePages([...pages].reverse()));
    expect(lintKnowledgePages(pages).findings).toEqual([]);
  });

  it("counts repeated targets once per source page", () => {
    const report = lintKnowledgePages([page("root", "[[absent]] [[absent#part|alias]]")]);
    expect(report.counts.unresolved_link).toBe(1);
  });
});

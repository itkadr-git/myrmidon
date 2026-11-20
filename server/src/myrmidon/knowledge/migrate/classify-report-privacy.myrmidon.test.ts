import { describe, expect, it } from "vitest";
import { buildClassifyReport, classesOf, type PlannedPage } from "./report.js";

const skipped = { controlFiles: 1, rawSources: 2, other: 3 };

function page(path: string, overrides: Partial<PlannedPage> = {}): PlannedPage {
  return {
    path, bytes: 42, plan: { class: "A", action: "import" }, seeded: false,
    target: null, hasFrontmatter: false, frontmatterKeys: [],
    malformedFrontmatterLines: 0, links: { total: 0, resolved: 0, unresolved: [] },
    ...overrides,
  };
}

describe("classify report privacy and accounting", () => {
  it("reports empty inputs and mismatched expectations", () => {
    const report = buildClassifyReport({ root: "wiki", skipped, pages: [], mapPaths: [], expectedTotal: 1, dryRun: true });
    expect(report.classes).toEqual({ A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 });
    expect(classesOf([])).toEqual({ A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 });
    expect(report.classSum).toEqual({ expected: 1, actual: 0, ok: false });
    expect(report.links).toEqual({ total: 0, resolved: 0, unresolved: 0, percent: 100, unresolvedTargets: [] });
    expect(report.warnings).toEqual([]);
  });

  it("counts pages and occurrences without exposing page content or changing input", () => {
    const sentinel = "SYNTHETIC_PRIVATE_CONTENT_9284";
    const pages: Array<PlannedPage & { body?: string }> = [
      page("z.md", { title: sentinel, plan: { class: "C", action: "merge" }, seeded: true, target: "shared", hasFrontmatter: true, frontmatterKeys: ["zeta", "title", "alpha"], malformedFrontmatterLines: 2, links: { total: 3, resolved: 1, unresolved: ["z", "x"] } }),
      { ...page("a.md", { plan: { class: "C", action: "merge" }, seeded: true, target: "shared", hasFrontmatter: true, frontmatterKeys: ["zeta", "beta"], malformedFrontmatterLines: 1, links: { total: 3, resolved: 1, unresolved: ["x", "x"] } }), body: sentinel },
      page("m.md", { plan: { class: "B", action: "drop" }, links: { total: 1, resolved: 0, unresolved: ["z"] } }),
      page("n.md", { plan: { class: "G", action: "replace_index" }, target: "single" }),
      page("b.md", { plan: { class: "A", action: "import" } }),
      page("d.md", { plan: { class: "C", action: "merge", mergeInto: "chosen" } }),
    ];
    const input = { root: "wiki", skipped: { ...skipped }, pages, mapPaths: ["z-orphan.md", "z.md", "a-orphan.md"], expectedTotal: 6, dryRun: false };
    const before = structuredClone(input);
    for (const item of pages) {
      Object.freeze(item.plan);
      Object.freeze(item.frontmatterKeys);
      Object.freeze(item.links.unresolved);
      Object.freeze(item.links);
      Object.freeze(item);
    }
    Object.freeze(pages);
    Object.freeze(input.mapPaths);
    Object.freeze(input.skipped);
    Object.freeze(input);

    const report = buildClassifyReport(input);
    expect(input).toEqual(before);
    expect(report.source).toEqual({ root: "wiki", pages: 6, skipped });
    expect(report.classes).toEqual({ A: 1, B: 1, C: 3, D: 0, E: 0, F: 0, G: 1 });
    expect(classesOf(pages)).toEqual({ A: 1, B: 1, C: 3, D: 0, E: 0, F: 0, G: 1 });
    expect(report.classSum).toEqual({ expected: 6, actual: 6, ok: true });
    expect(report.actions).toEqual({ merge: 3, drop: 1, replace_index: 1, import: 1 });
    expect(report.seededFromRules).toEqual(["a.md", "z.md"]);
    expect(report.orphanMapEntries).toEqual(["a-orphan.md", "z-orphan.md"]);
    expect(report.mergeNeedsDecision).toEqual(["a.md", "z.md"]);
    expect(report.sharedTargets).toEqual({ shared: ["z.md", "a.md"] });
    expect(report.links).toEqual({ total: 7, resolved: 2, unresolved: 5, percent: 28.6, unresolvedTargets: ["x", "z"] });
    expect(report.frontmatter).toEqual({ withBlock: 2, withoutBlock: 4, malformedLines: 3, keys: { zeta: 2, alpha: 1, beta: 1, title: 1 } });
    expect(Object.keys(report.frontmatter.keys)).toEqual(["zeta", "alpha", "beta", "title"]);
    expect(report.warnings).toEqual(["Some frontmatter blocks have malformed lines; see the per-page counts in the run log."]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).toContain("z.md");
    expect(serialized).toContain("alpha");
  });
});

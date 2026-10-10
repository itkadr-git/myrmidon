// server/src/myrmidon/knowledge/knowledge-delivery-index.myrmidon.test.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-3): the deterministic renderer and the caste
// filter behind `KNOWLEDGE_INDEX.md` — the file the bot's package carries
// beside REGULATIONS.md (arch. 2.0 §3.7). Pure functions, no database.

import { describe, expect, it } from "vitest";

import {
  ANY_CASTE,
  pageAppliesToCastes,
  renderKnowledgeIndex,
  selectIndexPages,
  type KnowledgeIndexPageInput,
} from "./delivery-index.js";

function page(overrides: Partial<KnowledgeIndexPageInput> = {}): KnowledgeIndexPageInput {
  return {
    slug: "onboarding",
    title: "Onboarding",
    summary: "How a newcomer starts",
    kind: "page",
    status: "published",
    deliverToCastes: [ANY_CASTE],
    ...overrides,
  };
}

describe("myrmidon(1.7 KNOWLEDGE-2.0 L-3) knowledge delivery index", () => {
  it("delivers a page to every caste via the `*` marker", () => {
    expect(pageAppliesToCastes([ANY_CASTE], "dev")).toBe(true);
    expect(pageAppliesToCastes([ANY_CASTE], "reviewer")).toBe(true);
  });

  it("delivers a page only to the castes it names", () => {
    expect(pageAppliesToCastes(["dev"], "dev")).toBe(true);
    expect(pageAppliesToCastes(["dev"], "reviewer")).toBe(false);
  });

  it("delivers nothing when the marker is empty or the agent has no caste", () => {
    expect(pageAppliesToCastes([], "dev")).toBe(false);
    expect(pageAppliesToCastes([ANY_CASTE], null)).toBe(false);
    expect(pageAppliesToCastes(["dev"], null)).toBe(false);
  });

  it("lists only published pages marked for the agent's caste, sorted by slug", () => {
    const pages = [
      page({ slug: "z-late", deliverToCastes: ["reviewer"] }),
      page({ slug: "m-every", deliverToCastes: [ANY_CASTE] }),
      page({ slug: "a-draft", status: "draft" }),
      page({ slug: "b-dev", deliverToCastes: ["dev"] }),
    ];
    expect(selectIndexPages({ caste: "dev", pages }).map((entry) => entry.slug)).toEqual(["b-dev", "m-every"]);
    expect(selectIndexPages({ caste: "reviewer", pages }).map((entry) => entry.slug)).toEqual(["m-every", "z-late"]);
    expect(selectIndexPages({ caste: null, pages })).toEqual([]);
  });

  it("renders the index deterministically: same pages — same bytes", () => {
    const input = {
      caste: "dev",
      rulesCount: 2,
      pages: [
        page({ slug: "b-dev", deliverToCastes: ["dev"] }),
        page({ slug: "m-every", deliverToCastes: [ANY_CASTE] }),
      ],
    };
    const first = renderKnowledgeIndex(input);
    const second = renderKnowledgeIndex(input);
    expect(first).toBe(second);
    expect(first).toContain("KNOWLEDGE_INDEX");
    expect(first).toContain("b-dev");
    expect(first).toContain("m-every");
    expect(first).toContain("wiki_read_page");
  });

  it("mentions the rules reminder when rules are delivered without pages", () => {
    const rendered = renderKnowledgeIndex({ caste: "dev", rulesCount: 3, pages: [] });
    expect(rendered).toContain("REGULATIONS.md");
    expect(rendered).not.toContain("- [");
  });
});

// server/src/myrmidon/wiki-cortex/wiki-knowledge-delivery.myrmidon.test.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-3, §3.7): the package delivery side — the
// knowledge index rides the same lane as REGULATIONS.md. Pure functions, no
// database: the delivery takes candidate pages and the rule count, and the
// same input must give the same bytes (the profile hash decides restarts).

import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_INDEX_WORKSPACE_FILE,
  loadKnowledgeIndexDelivery,
  type KnowledgeIndexInputPage,
} from "./delivery.js";

function page(overrides: Partial<KnowledgeIndexInputPage> = {}): KnowledgeIndexInputPage {
  return {
    slug: "onboarding",
    title: "Onboarding",
    summary: "How a newcomer starts",
    kind: "page",
    status: "published",
    deliverToCastes: ["*"],
    ...overrides,
  };
}

describe("myrmidon(1.7 KNOWLEDGE-2.0 L-3) package knowledge delivery", () => {
  it("delivers no file when nothing is picked and no rules are delivered", () => {
    const delivery = loadKnowledgeIndexDelivery({ companyId: "c1", caste: "dev", rulesCount: 0, pages: [] });
    expect(delivery.file).toBeNull();
    expect(delivery.indexSlugs).toEqual([]);
  });

  it("delivers the index file with the pages marked for the agent's caste", () => {
    const delivery = loadKnowledgeIndexDelivery({
      companyId: "c1",
      caste: "dev",
      rulesCount: 0,
      pages: [page({ slug: "a-dev", deliverToCastes: ["dev"] }), page({ slug: "z-other", deliverToCastes: ["ops"] })],
    });
    expect(delivery.file?.path).toBe(KNOWLEDGE_INDEX_WORKSPACE_FILE);
    expect(delivery.indexSlugs).toEqual(["a-dev"]);
    expect(delivery.caste).toBe("dev");
    expect(delivery.file?.content).toContain("a-dev");
    expect(delivery.file?.content).not.toContain("z-other");
  });

  it("still renders the rules reminder when rules are delivered but no pages are marked", () => {
    const delivery = loadKnowledgeIndexDelivery({ companyId: "c1", caste: "dev", rulesCount: 2, pages: [] });
    expect(delivery.file?.path).toBe(KNOWLEDGE_INDEX_WORKSPACE_FILE);
    expect(delivery.indexSlugs).toEqual([]);
    expect(delivery.file?.content).toContain("2 company rule(s)");
  });

  it("is deterministic: same input — same bytes", () => {
    const input = { companyId: "c1", caste: "dev", rulesCount: 1, pages: [page()] };
    expect(loadKnowledgeIndexDelivery(input).file?.content).toBe(loadKnowledgeIndexDelivery(input).file?.content);
  });

  it("normalizes a blank caste to no caste (no pages match)", () => {
    const delivery = loadKnowledgeIndexDelivery({
      companyId: "c1",
      caste: "   ",
      rulesCount: 0,
      pages: [page({ deliverToCastes: ["*"] })],
    });
    expect(delivery.caste).toBeNull();
    expect(delivery.file).toBeNull();
  });
});

// server/src/myrmidon/foraging/knowledge-port.myrmidon.test.ts
//
// myrmidon(1.7-KNOWLEDGE-L5): the finding → knowledge-proposal port.
// Quarantine first (`foraging-inbox` corpus dataset), then the proposal
// (trust=external, pending). The suggestion id is the finding's candidate_ref.

import { describe, expect, it, vi } from "vitest";
import {
  FORAGING_INBOX_DATASET,
  buildProposalBody,
  buildQuarantineMarkdown,
  createForagingKnowledgePort,
  type ForagingQuarantineStore,
} from "./knowledge-port.js";
import type { ForagingCandidateInput } from "./domain.js";

function finding(overrides: Partial<ForagingCandidateInput> = {}): ForagingCandidateInput {
  return {
    companyId: "11111111-1111-4111-8111-111111111111",
    sourceId: "src-1",
    role: "writer",
    url: "https://example.org/post",
    skillKey: "writer.style",
    summary: "The style guide adds a rule about em dashes.",
    diff: { added: ["Use em dashes sparingly."], removed: ["Never use em dashes."] },
    detectedAt: new Date("2026-10-10T12:00:00Z"),
    ...overrides,
  };
}

function quarantineSpy() {
  const calls = { find: 0, createdDatasets: [] as Array<{ name: string }>, documents: [] as Array<{ datasetId: string; title: string; sourceUri: string; metadata: Record<string, unknown> }> };
  const datasets = new Map<string, string>();
  const store: ForagingQuarantineStore = {
    async findDatasetByName(_companyId, name) {
      calls.find += 1;
      const id = datasets.get(name);
      return id ? { id } : null;
    },
    async createDataset(input) {
      calls.createdDatasets.push({ name: input.name });
      const id = `ds-${datasets.size + 1}`;
      datasets.set(input.name, id);
      return { id };
    },
    async createDocument(input) {
      calls.documents.push({ datasetId: input.datasetId, title: input.title, sourceUri: input.sourceUri, metadata: input.metadata });
      return `doc-${calls.documents.length}`;
    },
  };
  return { store, calls };
}

describe("foraging knowledge port (1.7 L-5)", () => {
  it("creates the foraging-inbox dataset lazily and quarantines the raw page text before proposing", async () => {
    const q = quarantineSpy();
    const suggest = vi.fn(async () => ({ id: "sug-1", targetItemId: null, status: "pending", createdAt: new Date().toISOString() }));
    const port = createForagingKnowledgePort({ knowledge: () => ({ suggest }), quarantine: q.store });

    const ref = await port.createFindingCandidate(finding());

    expect(ref).toBe("sug-1");
    expect(q.calls.createdDatasets).toEqual([{ name: FORAGING_INBOX_DATASET }]);
    expect(q.calls.documents).toHaveLength(1);
    expect(q.calls.documents[0]!.sourceUri).toBe("https://example.org/post");
    // The order is quarantine first, then the suggestion.
    expect(suggest).toHaveBeenCalledTimes(1);
  });

  it("proposes exactly one pending suggestion with trust=external and the url as source", async () => {
    const q = quarantineSpy();
    const suggest = vi.fn(async () => ({ id: "sug-2", targetItemId: null, status: "pending", createdAt: new Date().toISOString() }));
    const port = createForagingKnowledgePort({ knowledge: () => ({ suggest }), quarantine: q.store });

    await port.createFindingCandidate(finding());

    expect(suggest).toHaveBeenCalledWith({ actorType: "system", actorId: "foraging" }, expect.objectContaining({ trust: "external", sourceKind: "url", sourceRef: "https://example.org/post" }));
  });

  it("fails closed when the quarantine fails: no proposal at all", async () => {
    const suggest = vi.fn(async () => ({ id: "sug-3", targetItemId: null, status: "pending", createdAt: new Date().toISOString() }));
    const store: ForagingQuarantineStore = {
      async findDatasetByName() {
        throw new Error("db down");
      },
      async createDataset() {
        throw new Error("db down");
      },
      async createDocument() {
        throw new Error("db down");
      },
    };
    const port = createForagingKnowledgePort({ knowledge: () => ({ suggest }), quarantine: store, log: { warn: () => {} } });

    const ref = await port.createFindingCandidate(finding());

    expect(ref).toBeNull();
    expect(suggest).not.toHaveBeenCalled();
  });

  it("still answers null when only the knowledge suggest fails (the finding stays unverified)", async () => {
    const q = quarantineSpy();
    const port = createForagingKnowledgePort({
      knowledge: () => ({
        suggest: async () => {
          throw new Error("suggest refused");
        },
      }),
      quarantine: q.store,
      log: { warn: () => {} },
    });

    const ref = await port.createFindingCandidate(finding());

    expect(ref).toBeNull();
    // The quarantine document was still written — the raw capture is kept.
    expect(q.calls.documents).toHaveLength(1);
  });

  it("reuses the existing foraging-inbox dataset on the next finding", async () => {
    const q = quarantineSpy();
    const suggest = vi.fn(async () => ({ id: "sug-4", targetItemId: null, status: "pending", createdAt: new Date().toISOString() }));
    const port = createForagingKnowledgePort({ knowledge: () => ({ suggest }), quarantine: q.store });

    await port.createFindingCandidate(finding());
    await port.createFindingCandidate(finding({ sourceId: "src-2" }));

    expect(q.calls.createdDatasets).toHaveLength(1);
    expect(q.calls.documents).toHaveLength(2);
  });

  it("builds a single-line proposal body (knowledge bodies are single-line) that cites the url", () => {
    const body = buildProposalBody(finding());
    expect(body).not.toMatch(/[\r\n]/);
    expect(body).toContain("[foraging:writer]");
    expect(body).toContain("https://example.org/post");
    expect(body).toContain("em dashes");
  });

  it("keeps the quarantined markdown bounded and carries the capture header", () => {
    const input = finding();
    const md = buildQuarantineMarkdown(input, Array.from({ length: 1000 }, (_, i) => `line ${i}`));
    expect(md).toContain("# Foraging finding (quarantine)");
    expect(md).toContain("url: https://example.org/post");
    expect(md.length).toBeLessThanOrEqual(64 * 1024);
    expect(md).toContain("line 399");
    expect(md).not.toContain("line 400\n");
  });
});

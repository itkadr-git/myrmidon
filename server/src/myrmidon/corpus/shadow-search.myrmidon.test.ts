import { describe, expect, it, vi } from "vitest";
import { createCorpusShadowSearch } from "./shadow-search.js";
import type { CorpusMcpPort } from "./contract.js";

const search = vi.fn(async () => ({ query: "q", datasets: ["dataset-1"], topK: 10, hits: [{ chunkId: "chunk-1" }] }));
const listDatasets = vi.fn(async () => [{ id: "dataset-1", name: "contracts", documentCount: 1 }]);
const port = { search, listDatasets } as unknown as CorpusMcpPort;
const provider = vi.fn(async (companyId: string) => companyId === "company-1" ? port : null);

vi.mock("./index.js", () => ({ myrmidonCorpusMcpDeps: () => ({ port: provider }) }));

describe("createCorpusShadowSearch", () => {
  it("uses the production tenant-scoped corpus port", async () => {
    const shadow = createCorpusShadowSearch({} as never);
    await expect(shadow.search({ companyId: "company-1", dataset: "contracts", text: "q" }))
      .resolves.toEqual([{ chunkId: "chunk-1" }]);
    expect(provider).toHaveBeenCalledWith("company-1");
    expect(search).toHaveBeenCalledWith({ query: "q", datasets: ["dataset-1"], topK: 10, minScore: null });
  });

  it("rejects missing company or unknown/ambiguous dataset scope", async () => {
    search.mockClear();
    const shadow = createCorpusShadowSearch({} as never);
    await expect(shadow.search({ companyId: "", dataset: "contracts", text: "q" })).rejects.toThrow("missing company scope");
    listDatasets.mockResolvedValueOnce([]);
    await expect(shadow.search({ companyId: "company-1", dataset: "missing", text: "q" })).rejects.toThrow("dataset not found");
    listDatasets.mockResolvedValueOnce([
      { id: "a", name: "same", documentCount: 1 },
      { id: "b", name: "same", documentCount: 1 },
    ]);
    await expect(shadow.search({ companyId: "company-1", dataset: "same", text: "q" })).rejects.toThrow("ambiguous");
    expect(search).not.toHaveBeenCalled();
  });

  it("finds the dataset a RAGFlow dataset id points at through the importer's name suffix", async () => {
    search.mockClear();
    listDatasets.mockResolvedValueOnce([
      { id: "dataset-1", name: "RAGFlow: demo [abc123]", documentCount: 1 },
      { id: "dataset-2", name: "RAGFlow: demo [abc1234]", documentCount: 1 },
      { id: "dataset-3", name: "contracts", documentCount: 1 },
    ]);
    const shadow = createCorpusShadowSearch({} as never);
    await expect(shadow.search({ companyId: "company-1", dataset: "abc123", text: "q" }))
      .resolves.toEqual([{ chunkId: "chunk-1" }]);
    expect(search).toHaveBeenCalledWith({ query: "q", datasets: ["dataset-1"], topK: 10, minScore: null });
  });

  it("does not take a partial or unbracketed id for a RAGFlow dataset id, and refuses a shared one", async () => {
    search.mockClear();
    const shadow = createCorpusShadowSearch({} as never);
    listDatasets.mockResolvedValueOnce([{ id: "dataset-1", name: "RAGFlow: demo [abc123]", documentCount: 1 }]);
    await expect(shadow.search({ companyId: "company-1", dataset: "c123", text: "q" })).rejects.toThrow("dataset not found");
    listDatasets.mockResolvedValueOnce([{ id: "dataset-1", name: "RAGFlow: abc123 [other]", documentCount: 1 }]);
    await expect(shadow.search({ companyId: "company-1", dataset: "abc123", text: "q" })).rejects.toThrow("dataset not found");
    listDatasets.mockResolvedValueOnce([
      { id: "dataset-1", name: "RAGFlow: first [abc123]", documentCount: 1 },
      { id: "dataset-2", name: "RAGFlow: second [abc123]", documentCount: 1 },
    ]);
    await expect(shadow.search({ companyId: "company-1", dataset: "abc123", text: "q" })).rejects.toThrow("ambiguous");
    expect(search).not.toHaveBeenCalled();
  });
});

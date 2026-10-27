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
});

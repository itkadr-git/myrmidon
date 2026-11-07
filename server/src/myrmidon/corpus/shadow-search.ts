import type { Db } from "@myrmidon/db";
import { myrmidonCorpusMcpDeps } from "./index.js";
import type { CorpusMcpPort } from "./contract.js";
import type { CorpusShadowSearch, CorpusShadowSearchQuery } from "../corpus-shadow.js";

/**
 * Does a module dataset answer to the dataset hint of a RAGFlow call? The hint is the module
 * dataset id, its exact name, or a RAGFlow dataset id: the RAGFlow importer names its datasets
 * `RAGFlow: <name> [<RAGFlow dataset id>]`, so the id closes the name in square brackets.
 */
function datasetMatchesHint(dataset: { id: string; name: string }, hint: string): boolean {
  return dataset.id === hint || dataset.name === hint || dataset.name.endsWith(`[${hint}]`);
}

/** Adapt the production, company-scoped SearchIndex port used by corpus MCP. */
export function createCorpusShadowSearch(db: Db): CorpusShadowSearch {
  return {
    async search(input: CorpusShadowSearchQuery) {
      if (!input.companyId) throw new Error("missing company scope for corpus shadow search");
      const port = await myrmidonCorpusMcpDeps(db).port(input.companyId) as CorpusMcpPort | null;
      if (!port) throw new Error("corpus SearchIndex port is not configured");
      const datasets = await port.listDatasets();
      const hint = input.dataset;
      const matches = hint ? datasets.filter((dataset) => datasetMatchesHint(dataset, hint)) : datasets;
      if (hint && matches.length !== 1) {
        throw new Error(matches.length === 0 ? "dataset not found in company scope" : "dataset is ambiguous in company scope");
      }
      const response = await port.search({
        query: input.text,
        datasets: matches.map((dataset) => dataset.id),
        topK: 10,
        minScore: null,
      });
      return response.hits.slice(0, 10).map((hit) => ({ chunkId: hit.chunkId }));
    },
  };
}

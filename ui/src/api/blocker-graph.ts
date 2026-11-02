import { api } from "./client";
import type { BlockerRootFanout } from "@myrmidon/shared";

export interface BlockerGraphRootsResponse {
  roots: BlockerRootFanout[];
  limit: number;
  generatedAt: string;
}

export const blockerGraphApi = {
  roots: (companyId: string, limit?: number) =>
    api.get<BlockerGraphRootsResponse>(
      `/companies/${encodeURIComponent(companyId)}/blocker-graph/roots${typeof limit === "number" ? `?limit=${limit}` : ""}`
    ),
};

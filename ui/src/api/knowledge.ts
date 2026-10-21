import { api } from "./client";

export interface KnowledgeSuggestion {
  id: string;
  targetItemId: string | null;
  body: string;
  rationale: string | null;
  sourceKind: string | null;
  sourceRef: string | null;
  status: "pending" | "accepted" | "declined";
  createdAt: string;
}

export const knowledgeApi = {
  listSuggestions: async (companyId: string, status = "pending") =>
    api.get<{ suggestions: KnowledgeSuggestion[] }>(
      `/myrmidon/companies/${companyId}/knowledge/suggestions?status=${encodeURIComponent(status)}`,
    ).then((result) => result.suggestions),
  editSuggestion: (companyId: string, id: string, body: string, rationale: string) =>
    api.patch<{ suggestion: { id: string; status: string } }>(
      `/myrmidon/companies/${companyId}/knowledge/suggestions/${id}`,
      { body, rationale },
    ),
  decideSuggestion: (companyId: string, id: string, decision: "accepted" | "declined", reason?: string) =>
    api.post<{ suggestion: { id: string; status: string } }>(
      `/myrmidon/companies/${companyId}/knowledge/suggestions/${id}/decision`,
      { decision, reason },
    ),
};

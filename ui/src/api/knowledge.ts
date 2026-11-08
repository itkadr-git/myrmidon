import { api } from "./client";

export interface KnowledgeSuggestion {
  id: string;
  targetItemId: string | null;
  body: string;
  status: "pending" | "accepted" | "declined";
  trust: string | null;
  createdAt: string;
}

export const knowledgeApi = {
  listSuggestions: (companyId: string) =>
    api.get<{ suggestions: KnowledgeSuggestion[] }>(
      `/myrmidon/companies/${companyId}/knowledge/suggestions?status=pending`,
    ).then((result) => result.suggestions),
};

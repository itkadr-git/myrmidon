import { api } from "@/api/client";

export interface KnowledgeSuggestion {
  id: string;
  body: string;
  targetItemId: string | null;
  rationale: string | null;
}
const root = (companyId: string) => `/myrmidon/companies/${encodeURIComponent(companyId)}/knowledge`;
export const knowledgeReviewApi = {
  pending: (companyId: string) => api.get<{ suggestions: KnowledgeSuggestion[] }>(`${root(companyId)}/suggestions?status=pending`),
  decide: (companyId: string, id: string, action: "accept" | "decline") =>
    api.post(`${root(companyId)}/suggestions/${encodeURIComponent(id)}/${action}`, {}),
  saveDraft: (companyId: string, suggestion: KnowledgeSuggestion, input: { content: string; title: string; slug: string }) =>
    suggestion.targetItemId
      ? api.post(`${root(companyId)}/items/${encodeURIComponent(suggestion.targetItemId)}/draft`, { content: input.content })
      : api.post(`${root(companyId)}/items`, { content: input.content, title: input.title.trim(), slug: input.slug.trim() }),
};

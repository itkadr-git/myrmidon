import { api } from "@/api/client";

export interface KnowledgeSuggestion {
  id: string;
  body: string;
  targetItemId: string | null;
  rationale: string | null;
}
const root = (companyId: string) => `/myrmidon/companies/${encodeURIComponent(companyId)}/knowledge`;
export const knowledgeReviewApi = {
  pending: async (companyId: string) => {
    const response = await api.get<unknown>(`${root(companyId)}/suggestions?status=pending`);
    if (!response || typeof response !== "object" || !("suggestions" in response) || !Array.isArray(response.suggestions) ||
        !response.suggestions.every((row: unknown) => row !== null && typeof row === "object" &&
          "id" in row && typeof row.id === "string" && "body" in row && typeof row.body === "string" &&
          (!('targetItemId' in row) || row.targetItemId === null || typeof row.targetItemId === "string") &&
          (!('rationale' in row) || row.rationale === null || typeof row.rationale === "string"))) {
      throw new Error("Invalid pending suggestions response");
    }
    return response as { suggestions: KnowledgeSuggestion[] };
  },
  decide: (companyId: string, id: string, action: "accept" | "decline") =>
    api.post(`${root(companyId)}/suggestions/${encodeURIComponent(id)}/${action}`, {}),
  saveDraft: (companyId: string, suggestion: KnowledgeSuggestion, input: { content: string; title: string; slug: string }) =>
    suggestion.targetItemId
      ? api.post(`${root(companyId)}/items/${encodeURIComponent(suggestion.targetItemId)}/draft`, { content: input.content })
      : api.post(`${root(companyId)}/items`, { content: input.content, title: input.title.trim(), slug: input.slug.trim() }),
};

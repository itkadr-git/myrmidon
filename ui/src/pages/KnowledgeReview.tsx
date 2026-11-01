import { useQuery } from "@tanstack/react-query";
import { knowledgeApi } from "../api/knowledge";
import { useCompany } from "../context/CompanyContext";
import { useTranslation } from "@/i18n";

// The detailed rationale and decision controls are delivered by L-1.2/L-1.3.
export function KnowledgeReview() {
  const { selectedCompanyId } = useCompany();
  const { t } = useTranslation();
  const { data: suggestions = [], isLoading, isError } = useQuery({
    queryKey: ["knowledge-suggestions", selectedCompanyId],
    queryFn: () => knowledgeApi.listSuggestions(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <h1 className="text-2xl font-semibold">{t("area.inbox-status-cards-2.inbox.knowledgeReview")}</h1>
      {isLoading && <p role="status">{t("area.inbox-status-cards-2.inbox.knowledgeLoading")}</p>}
      {isError && <p role="alert">{t("area.inbox-status-cards-2.inbox.knowledgeLoadFailed")}</p>}
      {!isLoading && !isError && suggestions.length === 0 && <p>{t("area.inbox-status-cards-2.inbox.emptyFiltered")}</p>}
      {suggestions.map((suggestion) => (
        <article key={suggestion.id} className="rounded-lg border bg-card p-4">
          <p className="whitespace-pre-wrap break-words text-sm">{suggestion.body}</p>
        </article>
      ))}
    </main>
  );
}

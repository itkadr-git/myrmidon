import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import { Ui2Page, Ui2Section } from "../../components/ui2Primitives";
import { Ui2EmptyStateView, Ui2ErrorState, Ui2SkeletonRows } from "../../components/ui2StateViews";
import { knowledgeApi } from "./knowledgeApi";

export function Ui2KnowledgeReview() {
  const { selectedCompanyId } = useCompany();
  const { t } = useUi2I18n();
  const query = useQuery({
    queryKey: ["knowledge", "suggestions", selectedCompanyId],
    queryFn: () => knowledgeApi.suggestions(selectedCompanyId ?? ""),
    enabled: Boolean(selectedCompanyId),
  });
  return (
    <Ui2Page title={t("ui2.knowledgeReview.title")} subtitle={t("ui2.knowledgeReview.subtitle")}>
      {query.isLoading ? <Ui2SkeletonRows rows={3} /> : null}
      {query.isError ? <Ui2ErrorState message={t("ui2.knowledgeReview.error")} /> : null}
      {query.isSuccess && query.data.suggestions.length === 0 ?
        <Ui2EmptyStateView title={t("ui2.knowledgeReview.empty")} variant="done" /> : null}
      {query.data?.suggestions.map((suggestion) => (
        <Ui2Section key={suggestion.id} title={suggestion.body}>
          <p className="text-sm">{t("ui2.knowledgeReview.recommendation", { recommendation: suggestion.recommendation === "declined" ? t("ui2.knowledgeReview.reject") : t("ui2.knowledgeReview.accept") })}</p>
          {suggestion.rationale ? <p className="text-sm text-muted-foreground">{suggestion.rationale}</p> : null}
          {suggestion.sourceRef ? <p className="text-xs text-muted-foreground">{suggestion.sourceKind ? `${suggestion.sourceKind}: ` : ""}{suggestion.sourceRef}</p> : null}
        </Ui2Section>
      ))}
    </Ui2Page>
  );
}
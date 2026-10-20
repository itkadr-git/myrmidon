import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { baselineApi, baselineMetricsKey } from "@/api/baseline";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import { Ui2EmptyState, Ui2ErrorNote, Ui2Loading, Ui2Page, Ui2Section, Ui2Tile, Ui2Tiles } from "../../components/ui2Primitives";

export function Ui2QualityScreen() {
  const { t } = useUi2I18n();
  const { selectedCompanyId } = useCompany();
  const query = useQuery({ queryKey: baselineMetricsKey(selectedCompanyId ?? ""), queryFn: () => baselineApi.metrics(selectedCompanyId!), enabled: Boolean(selectedCompanyId), staleTime: 60_000 });
  if (query.isLoading) return <Ui2Page title={t("ui2.quality.title")}><Ui2Loading label={t("ui2.common.loading")} /></Ui2Page>;
  if (query.isError) return <Ui2Page title={t("ui2.quality.title")}><Ui2ErrorNote message={t("ui2.common.error")} retryLabel={t("ui2.common.retry")} onRetry={() => void query.refetch()} /></Ui2Page>;
  const projects = query.data?.byProject ?? [];
  const total = projects.reduce((sum, row) => sum + row.tasksCompleted, 0);
  const returned = projects.reduce((sum, row) => sum + row.returnRate.returned, 0);
  const enteredReview = projects.reduce((sum, row) => sum + row.returnRate.enteredReview, 0);
  const runs = projects.reduce((sum, row) => sum + row.runsPerTask.total, 0);
  const successPercent = runs ? Math.max(0, Math.round((1 - returned / runs) * 100)) : null;
  return (
    <Ui2Page title={t("ui2.quality.title")} subtitle={t("ui2.quality.subtitle")}>
      {!projects.length ? <Ui2EmptyState title={t("ui2.quality.empty")} body={t("ui2.quality.emptyHint")} /> : <>
        <Ui2Tiles>
          <Ui2Tile label={t("ui2.quality.completed")} value={String(total)} />
          <Ui2Tile label={t("ui2.quality.reviewed")} value={String(enteredReview)} />
          <Ui2Tile label={t("ui2.quality.defects")} value={String(returned)} tone={returned ? "warning" : "ok"} />
          <Ui2Tile label={t("ui2.quality.successRate")} value={successPercent == null ? t("ui2.common.unknown") : `${successPercent}%`} tone={successPercent == null ? "default" : successPercent >= 90 ? "ok" : "warning"} />
        </Ui2Tiles>
        <Ui2Section title={t("ui2.quality.byProject")}>
          <div className="overflow-x-auto"><table className="w-full min-w-[36rem] text-left text-sm"><thead><tr className="border-b border-border text-muted-foreground"><th className="p-2">{t("ui2.quality.project")}</th><th className="p-2">{t("ui2.quality.completed")}</th><th className="p-2">{t("ui2.quality.defects")}</th><th className="p-2">{t("ui2.quality.successRate")}</th></tr></thead><tbody>{projects.map((row) => { const rate = row.runsPerTask.total ? Math.max(0, Math.round((1 - row.returnRate.returned / row.runsPerTask.total) * 100)) : null; return <tr className="border-b border-border last:border-0" key={row.key ?? "unassigned"}><td className="p-2">{row.key ?? t("ui2.quality.unassigned")}</td><td className="p-2 tabular-nums">{row.tasksCompleted}</td><td className="p-2 tabular-nums">{row.returnRate.returned}</td><td className="p-2 tabular-nums">{rate == null ? t("ui2.common.unknown") : `${rate}%`}</td></tr>; })}</tbody></table></div>
        </Ui2Section>
      </>}
    </Ui2Page>
  );
}

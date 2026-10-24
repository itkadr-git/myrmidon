import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { deployJobsApi, deployJobsQueryKey, type DeployJobView } from "@/components/myrmidon/deployJobsApi";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import { Ui2EmptyState, Ui2ErrorNote, Ui2Loading, Ui2Page, Ui2Section, Ui2Tile, Ui2Tiles, Ui2StatusDot } from "../../components/ui2Primitives";

export function Ui2SystemScreen() {
  const { t } = useUi2I18n();
  const healthQuery = useQuery({ queryKey: ["ui2", "system", "health"], queryFn: healthApi.get, staleTime: 30_000 });
  const deployQuery = useQuery({ queryKey: deployJobsQueryKey, queryFn: () => deployJobsApi.get(), staleTime: 30_000 });
  const health = healthQuery.data;
  if (healthQuery.isLoading || deployQuery.isLoading) return <Ui2Page title={t("ui2.system.title")}><Ui2Loading label={t("ui2.common.loading")} /></Ui2Page>;
  if (healthQuery.isError || deployQuery.isError) return <Ui2Page title={t("ui2.system.title")}><Ui2ErrorNote message={t("ui2.common.error")} retryLabel={t("ui2.common.retry")} onRetry={() => { void healthQuery.refetch(); void deployQuery.refetch(); }} /></Ui2Page>;
  if (!health) return <Ui2Page title={t("ui2.system.title")}><Ui2EmptyState title={t("ui2.system.empty")} /></Ui2Page>;

  const git = health.serverInfo?.git;
  const deploys = deployQuery.data?.history ?? [];
  const currentDeploy = deployQuery.data?.job;
  const recentDeploys = currentDeploy && !deploys.some((deploy: DeployJobView) => deploy.id === currentDeploy.id)
    ? [currentDeploy, ...deploys]
    : deploys;
  const healthy = health.status === "ok";
  return (
    <Ui2Page title={t("ui2.system.title")} subtitle={t("ui2.system.subtitle")}>
      <Ui2Tiles>
        <Ui2Tile label={t("ui2.system.stack")} value={healthy ? t("ui2.system.healthy") : t("ui2.system.unavailable")} tone={healthy ? "ok" : "danger"} />
        <Ui2Tile label={t("ui2.system.version")} value={health.version ?? t("ui2.common.unknown")} />
        <Ui2Tile label={t("ui2.system.deployment")} value={health.deploymentMode ?? t("ui2.common.unknown")} />
        <Ui2Tile label={t("ui2.system.started")} value={health.serverInfo?.processStartedAt ? new Date(health.serverInfo.processStartedAt).toLocaleString() : t("ui2.common.unknown")} />
      </Ui2Tiles>
      <Ui2Section title={t("ui2.system.healthTitle")}>
        <div className="flex items-center gap-2 text-sm"><Ui2StatusDot tone={healthy ? "ok" : "danger"} />{healthy ? t("ui2.system.healthy") : t("ui2.system.unavailable")}</div>
        {health.cloud ? <p className="text-sm text-muted-foreground">{t("ui2.system.cloud")} · {health.cloud.stackDisplayName ?? health.cloud.stackSlug ?? t("ui2.common.unknown")}</p> : null}
      </Ui2Section>
      <Ui2Section title={t("ui2.system.deployTitle")}>
        {recentDeploys.length ? <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-left text-sm"><thead><tr className="border-b border-border text-muted-foreground"><th className="p-2">{t("ui2.system.deployVersion")}</th><th className="p-2">{t("ui2.system.deployStatus")}</th><th className="p-2">{t("ui2.system.deployDate")}</th><th className="p-2">{t("ui2.system.deployCommit")}</th></tr></thead><tbody>{recentDeploys.map((deploy: DeployJobView) => <tr key={deploy.id} className="border-b border-border last:border-0"><td className="p-2">{deploy.version ?? t("ui2.common.unknown")}</td><td className="p-2">{deploy.status}</td><td className="p-2 whitespace-nowrap">{new Date(deploy.createdAt).toLocaleString()}</td><td className="p-2 font-mono">{deploy.commit?.slice(0, 12) ?? t("ui2.common.unknown")}</td></tr>)}</tbody></table></div> : <Ui2EmptyState title={t("ui2.system.noDeploys")} />}
      </Ui2Section>
    </Ui2Page>
  );
}

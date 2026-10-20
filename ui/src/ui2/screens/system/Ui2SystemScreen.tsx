import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import { Ui2EmptyState, Ui2ErrorNote, Ui2Loading, Ui2Page, Ui2Section, Ui2Tile, Ui2Tiles, Ui2StatusDot } from "../../components/ui2Primitives";

export function Ui2SystemScreen() {
  const { t } = useUi2I18n();
  const query = useQuery({ queryKey: ["ui2", "system", "health"], queryFn: healthApi.get, staleTime: 30_000 });
  const health = query.data;
  if (query.isLoading) return <Ui2Page title={t("ui2.system.title")}><Ui2Loading label={t("ui2.common.loading")} /></Ui2Page>;
  if (query.isError) return <Ui2Page title={t("ui2.system.title")}><Ui2ErrorNote message={t("ui2.common.error")} retryLabel={t("ui2.common.retry")} onRetry={() => void query.refetch()} /></Ui2Page>;
  if (!health) return <Ui2Page title={t("ui2.system.title")}><Ui2EmptyState title={t("ui2.system.empty")} /></Ui2Page>;

  const git = health.serverInfo?.git;
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
        {git?.available ? <div className="flex flex-col gap-2 text-sm"><div className="font-mono">{git.shortSha} · {git.branchName ?? t("ui2.common.unknown")}</div><div className="text-muted-foreground">{git.subject}</div></div> : <Ui2EmptyState title={t("ui2.system.noDeploys")} />}
      </Ui2Section>
    </Ui2Page>
  );
}

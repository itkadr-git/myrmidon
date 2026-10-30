import { useQuery } from "@tanstack/react-query";
import { fleetApi, type FleetHost } from "@/api/fleet";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { BLOCKER_DASHBOARD_PANELS } from "@/lib/blockerDashboardPanels";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import { Ui2EmptyStateView, Ui2ErrorState, Ui2SkeletonRows } from "../../components/ui2StateViews";
import { Ui2Page, Ui2Section, Ui2StatusDot, Ui2Tiles, Ui2Tile } from "../../components/ui2Primitives";
import { Ui2FleetSites } from "./Ui2FleetSites";

function hostTone(host: FleetHost): "ok" | "warning" | "danger" | "muted" {
  if (host.origin === "none" || (host.ageSec !== null && host.ageSec > 300)) return "danger";
  if ((host.cpuPercent ?? 0) >= 90 || (host.memoryPercent ?? 0) >= 90 || (host.diskPercent ?? 0) >= 90) return "warning";
  return "ok";
}

export function Ui2Fleet() {
  const { t } = useUi2I18n();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const query = useQuery({ queryKey: queryKeys.fleet(companyId), queryFn: () => fleetApi.dashboard(companyId), enabled: Boolean(companyId), refetchInterval: 30_000 });
  // The site badges are an addition to the dashboard: while they load, or if they fail, the rest of the screen stands.
  const sitesQuery = useQuery({ queryKey: queryKeys.fleetSiteOverview(companyId), queryFn: () => fleetApi.sitesOverview(companyId), enabled: Boolean(companyId), refetchInterval: 30_000 });
  const sites = sitesQuery.data?.sites ?? [];
  if (query.isLoading || !companyId) return <Ui2Page title={t("ui2.screens.fleet.title" as never)}><Ui2SkeletonRows rows={4} /></Ui2Page>;
  if (query.isError) return <Ui2Page title={t("ui2.screens.fleet.title" as never)}><Ui2ErrorState message={t("ui2.common.error")} detail={query.error instanceof Error ? query.error.message : null} retryLabel={t("ui2.common.retry")} onRetry={() => void query.refetch()} /></Ui2Page>;
  const data = query.data;
  const hosts = data?.hosts ?? [];
  const containers = data?.containers ?? [];
  const sourceErrors = (data?.sources ?? []).filter((source) => source.error).map((source) => source.error as string);
  const monitoringError = !data?.ok || sourceErrors.length > 0;
  return <Ui2Page title={t("ui2.screens.fleet.title" as never)} subtitle={t("ui2.screens.fleet.subtitle" as never)}>
    {monitoringError ? <Ui2ErrorState message={t("ui2.screens.fleet.monitoringError" as never)} detail={sourceErrors.join(" · ") || t("ui2.screens.fleet.monitoringUnavailable" as never)} /> : null}
    {data?.blockerPanels ? <Ui2Section title={t("ui2.screens.fleet.blockerDashboard" as never)}>
      <Ui2Tiles>{BLOCKER_DASHBOARD_PANELS.filter((panel) => panel.id !== "root_fanout").map((panel) => {
        const value = panel.id === "blocked_age" ? data.blockerPanels?.blockedAgeSeconds : panel.id === "missing_fields" ? data.blockerPanels?.missingFields : data.blockerPanels?.terminal;
        return <Ui2Tile key={panel.id} label={panel.title} value={value == null ? "—" : `${value} ${panel.unit}`} />;
      })}<Ui2Tile label={t("ui2.screens.fleet.rootFanout" as never)} value={`${data.blockerPanels.rootFanout.length} roots`} hint={`Alert above ${data.blockerPanels.fanoutLimit}`} /></Ui2Tiles>
      {data.blockerPanels.rootFanout.length > 0 ? <div className="flex flex-col divide-y divide-border">{data.blockerPanels.rootFanout.map((root) => <a className="flex justify-between py-2 text-sm hover:underline" href={`/issues/${encodeURIComponent(root.root)}`} key={root.root}><span>{root.root}</span><span className="font-mono">{root.fanout}</span></a>)}</div> : null}
    </Ui2Section> : null}
    <Ui2FleetSites companyId={companyId} sites={sites} loading={sitesQuery.isLoading} failed={sitesQuery.isError} />
    {!monitoringError && hosts.length === 0 && containers.length === 0 && sites.length === 0 ? <Ui2EmptyStateView variant="done" title={t("ui2.screens.fleet.empty" as never)} body={t("ui2.screens.fleet.emptyBody" as never)} /> : null}
    {hosts.length > 0 ? <Ui2Section title={t("ui2.screens.fleet.hosts" as never)}><div className="flex flex-col divide-y divide-border">{hosts.map((host) => <div className="flex flex-wrap items-center justify-between gap-3 py-3" key={host.name}><div className="flex items-center gap-2"><Ui2StatusDot tone={hostTone(host)} /><span className="font-medium">{host.name}</span></div><span className="text-xs text-muted-foreground">{t("ui2.screens.fleet.metrics" as never, { cpu: host.cpuPercent ?? "—", memory: host.memoryPercent ?? "—", disk: host.diskPercent ?? "—" })}</span></div>)}</div></Ui2Section> : null}
    {containers.length > 0 ? <Ui2Section title={t("ui2.screens.fleet.services" as never)}><div className="flex flex-col divide-y divide-border">{containers.map((container) => <div className="flex items-center justify-between gap-3 py-3" key={container.name}><div className="flex items-center gap-2"><Ui2StatusDot tone={container.state === "running" ? "ok" : container.state === "stopped" ? "danger" : "muted"} /><span>{container.name}</span></div><span className="text-xs text-muted-foreground">{t(`ui2.screens.fleet.states.${container.state}` as never)}</span></div>)}</div></Ui2Section> : null}
  </Ui2Page>;
}
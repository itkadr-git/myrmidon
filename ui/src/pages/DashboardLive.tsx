import { useEffect } from "react";
import { ArrowLeft, RadioTower } from "lucide-react";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";

const DASHBOARD_LIVE_RUN_LIMIT = 50;

export function DashboardLive() {
  const { t } = useTranslation();
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: t("area.inbox-status-cards-1.dashboard-live.breadcrumbDashboard"), href: "/dashboard" },
      { label: t("area.inbox-status-cards-1.dashboard-live.breadcrumbLiveRuns") },
    ]);
  }, [setBreadcrumbs, t]);

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={RadioTower}
        message={companies.length === 0 ? t("area.inbox-status-cards-1.dashboard-live.emptyCreate") : t("area.inbox-status-cards-1.dashboard-live.emptySelect")}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("area.inbox-status-cards-1.dashboard-live.backToDashboard")}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-normal text-foreground">{t("area.inbox-status-cards-1.dashboard-live.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("area.inbox-status-cards-1.dashboard-live.description")}
          </p>
        </div>
        <div className="text-sm text-muted-foreground">{t("area.inbox-status-cards-1.dashboard-live.showingUpTo", { limit: DASHBOARD_LIVE_RUN_LIMIT })}</div>
      </div>

      <ActiveAgentsPanel
        companyId={selectedCompanyId}
        title={t("area.inbox-status-cards-1.dashboard-live.activeRecent")}
        minRunCount={DASHBOARD_LIVE_RUN_LIMIT}
        fetchLimit={DASHBOARD_LIVE_RUN_LIMIT}
        cardLimit={DASHBOARD_LIVE_RUN_LIMIT}
        emptyMessage={t("area.inbox-status-cards-1.dashboard-live.activeEmpty")}
        queryScope="dashboard-live"
        showMoreLink={false}
      />
    </div>
  );
}

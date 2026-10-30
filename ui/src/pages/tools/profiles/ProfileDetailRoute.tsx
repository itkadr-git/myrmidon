import { useEffect } from "react";
import { useTranslation } from "@/i18n";
import { useParams } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { advancedTabHref } from "../tool-tabs";
import { ToolsAdminGate } from "./ToolsAdminGate";
import { ProfileDetail } from "./ProfileDetail";

export function ProfileDetailRoute() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const params = useParams<{ profileId?: string }>();
  const { t } = useTranslation();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("area.tools-profiles-2.profile-detail-route.breadcrumbCompany"), href: "/dashboard" },
      { label: t("area.tools-profiles-2.profile-detail-route.breadcrumbApps"), href: "/apps" },
      { label: t("area.tools-profiles-2.profile-detail-route.breadcrumbProfiles"), href: advancedTabHref("profiles") },
      { label: t("area.tools-profiles-2.profile-detail-route.breadcrumbDetail") },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name, t]);

  if (!selectedCompanyId || !params.profileId) {
    return <div className="p-6 text-sm text-muted-foreground">{t("area.tools-profiles-2.profile-detail-route.selectPrompt")}</div>;
  }

  return (
    <ToolsAdminGate>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 sm:p-6">
        <ProfileDetail companyId={selectedCompanyId} profileId={params.profileId} />
      </div>
    </ToolsAdminGate>
  );
}

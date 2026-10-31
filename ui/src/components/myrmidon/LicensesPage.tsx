// myrmidon(LICENSING): Settings → Instance → Licenses.
import { useEffect } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useTranslation } from "@/i18n";
import { LicensingSettingsPanel } from "./LicensingSettingsPanel";
import { useIsInstanceAdmin } from "./licensingApi";

export function LicensesPage() {
  const { t } = useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const isInstanceAdmin = useIsInstanceAdmin();

  useEffect(() => {
    setBreadcrumbs([
      { label: t("settingsNav.general"), href: "/company/settings" },
      { label: t("licensing.title") },
    ]);
  }, [setBreadcrumbs, t]);

  return (
    <div className="max-w-3xl space-y-4" data-testid="licenses-page">
      {isInstanceAdmin === null ? null : isInstanceAdmin ? (
        <LicensingSettingsPanel />
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="licenses-admin-only">
          {t("licensing.adminOnly")}
        </p>
      )}
    </div>
  );
}

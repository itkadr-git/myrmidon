import type { ToolProfileWithDetails } from "@paperclipai/shared";
import { useTranslation } from "@/i18n";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { allowedToolsLabel, type GatewayAppRow, gatewayAppDisplayName } from "../gateway-helpers";

/**
 * Apps & tools tab — which apps this gateway exposes and how many tools each
 * contributes, derived from the bound access profile. Missing credentials
 * surface as "Needs attention", carried from the connection health status.
 */
export function AppsToolsPanel({
  apps,
  profile,
}: {
  apps: GatewayAppRow[];
  profile: ToolProfileWithDetails | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {profile
          ? t("area.apps-gateways-1.apps-tools-panel.introWithProfile", { name: profile.name, allowed: allowedToolsLabel(profile) })
          : t("area.apps-gateways-1.apps-tools-panel.intro")}
      </p>

      {apps.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t("area.apps-gateways-1.apps-tools-panel.empty")}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-(--sz-32rem) text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5">{t("area.apps-gateways-1.apps-tools-panel.colApp")}</th>
                <th className="px-4 py-2.5">{t("area.apps-gateways-1.apps-tools-panel.colTools")}</th>
                <th className="px-4 py-2.5">{t("area.apps-gateways-1.apps-tools-panel.colStatus")}</th>
                <th className="px-4 py-2.5 text-right" />
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => {
                const href = app.connection
                  ? `/apps/${app.connection.id}/permissions`
                  : `/apps/app/${app.application.id}/permissions`;
                return (
                  <tr key={app.application.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <Link to={href} className="font-medium text-foreground hover:underline">
                        {gatewayAppDisplayName(app)}
                      </Link>
                      {app.needsAttention && app.attentionReason ? (
                        <div className="text-xs text-muted-foreground">{app.attentionReason}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {t("area.apps-gateways-1.apps-tools-panel.toolCount", { count: app.toolCount })}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                          app.needsAttention
                            ? "border-foreground bg-foreground text-background"
                            : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                        )}
                      >
                        {app.needsAttention ? t("area.apps-gateways-1.apps-tools-panel.needsAttention") : t("area.apps-gateways-1.apps-tools-panel.healthy")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link to={href} className="text-xs font-medium text-primary hover:underline">
                        {t("area.apps-gateways-1.apps-tools-panel.open")}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

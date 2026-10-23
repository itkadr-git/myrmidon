import { useQuery } from "@tanstack/react-query";
import {
  BadgeCheck, // myrmidon(LICENSING)
  ChevronLeft,
  Clock3,
  Cpu,
  Download,
  FlaskConical,
  KeyRound,
  ListChecks,
  MailPlus,
  MonitorCog,
  Puzzle,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  UserRoundPen,
  Users,
} from "lucide-react";
import type { PluginRecord } from "@myrmidon/shared";
import { sidebarBadgesApi } from "@/api/sidebarBadges";
import { pluginsApi } from "@/api/plugins";
import { ApiError } from "@/api/client";
import { Link, NavLink } from "@/lib/router";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "@/lib/instance-settings";
import { SIDEBAR_SCROLL_RESET_STATE } from "@/lib/navigation-scroll";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { usePluginSlots } from "@/plugins/slots";
import { SidebarNavItem } from "./SidebarNavItem.production";
import { useAccessHubAvailability } from "@/components/myrmidon/access-hub/accessHubAvailability";
import { LICENSES_PATH, useIsInstanceAdmin } from "@/components/myrmidon/licensingApi"; // myrmidon(LICENSING)
import { useTranslation } from "@/i18n"; // myrmidon(LICENSING)

/**
 * Sandbox-provider-only plugins (e.g. E2B, exe.dev, Modal) have no per-plugin
 * settings page, so a sidebar entry would lead nowhere useful. Filter them out
 * here. Plugins that mix a sandbox provider with other contributions still
 * appear.
 */
function isSandboxProviderOnly(plugin: PluginRecord): boolean {
  const drivers = plugin.manifestJson.environmentDrivers ?? [];
  if (drivers.length === 0) return false;
  return drivers.every((d) => d.kind === "sandbox_provider");
}

export function CompanySettingsSidebar() {
  const { t } = useTranslation(); // myrmidon(LICENSING)
  const isInstanceAdmin = useIsInstanceAdmin(); // myrmidon(LICENSING)
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { hidden: hiddenSettings } = useHiddenSettings();
  const showPage = (pageKey: string) => !hiddenSettings.has(pageKey);
  const showPlugins = showPage("instance.plugins");
  // Probed only when the Access hub entry is visible; shares its cache entry
  // with the screen itself.
  const accessHubAvailability = useAccessHubAvailability(selectedCompanyId, showPage("company.secrets"));
  // Import is floored server-side on cloud-managed instances (403 cloud_managed), so the
  // nav entry is hidden rather than dead-ending. Export stays available.
  const isCloud = Boolean(useCloudInstance());
  const { slots: companySettingsPluginSlots } = usePluginSlots({
    slotTypes: ["companySettingsPage"],
    companyId: selectedCompanyId,
    enabled: !!selectedCompanyId,
  });
  const { data: badges } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.sidebarBadges(selectedCompanyId)
      : ["sidebar-badges", "__disabled__"] as const,
    queryFn: async () => {
      try {
        return await sidebarBadgesApi.get(selectedCompanyId!);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          return null;
        }
        throw error;
      }
    },
    enabled: !!selectedCompanyId,
    retry: false,
    refetchInterval: 15_000,
  });
  const { data: plugins } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
    // The listing only feeds the per-plugin subtree below; skip it when the
    // operator hides the Plugins surface.
    enabled: showPlugins,
  });
  const sidebarPlugins = (plugins ?? []).filter((plugin) => !isSandboxProviderOnly(plugin));

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      <div className="flex flex-col gap-1 px-3 py-3 shrink-0">
        <Link
          to="/dashboard"
          onClick={() => {
            if (isMobile) setSidebarOpen(false);
          }}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{selectedCompany?.name ?? t("area.shell-sidebar-layout-1.company-settings-sidebar.company")}</span>
        </Link>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem to="/company/settings" label={t("area.shell-sidebar-layout-1.company-settings-sidebar.general")} icon={SlidersHorizontal} end />
          {showPage("instance.profile") && (
            <SidebarNavItem
              to={`${INSTANCE_SETTINGS_PATH_PREFIX}/profile`}
              label={t("area.shell-sidebar-layout-1.company-settings-sidebar.profile")}
              icon={UserRoundPen}
              end
            />
          )}
          {showPage("company.members") && (
            <SidebarNavItem
              to="/company/settings/members"
              label={t("area.shell-sidebar-layout-1.company-settings-sidebar.members")}
              icon={Users}
              badge={badges?.joinRequests ?? 0}
              end
            />
          )}
          {companySettingsPluginSlots
            .filter((slot) => slot.routePath)
            .map((slot) => (
              <SidebarNavItem
                key={`${slot.pluginKey}:${slot.id}`}
                to={`/company/settings/${slot.routePath}`}
                label={slot.displayName}
                icon={Puzzle}
                end
              />
            ))}
          {showPage("company.invites") && (
            <SidebarNavItem to="/company/settings/invites" label={t("area.shell-sidebar-layout-1.company-settings-sidebar.invites")} icon={MailPlus} end />
          )}
          {showPage("company.secrets") && (
            <SidebarNavItem to="/company/settings/secrets" label={t("area.shell-sidebar-layout-1.company-settings-sidebar.secrets")} icon={KeyRound} end />
          )}
          {showPage("company.secrets") && (
            <SidebarNavItem
              to="/company/settings/access-hub"
              label={t("area.shell-sidebar-layout-1.company-settings-sidebar.accessHub")}
              icon={ShieldCheck}
              // The screen exists before its server API: while the instance
              // answers 404/501 the entry says so instead of leading to a
              // screen that only shows the not-available notice.
              textBadge={accessHubAvailability === "unavailable" ? t("area.shell-sidebar-layout-1.company-settings-sidebar.soon") : undefined}
              end
            />
          )}
          {showPage("instance.environments") && (
            <SidebarNavItem
              to={`${INSTANCE_SETTINGS_PATH_PREFIX}/environments`}
              label={t("area.shell-sidebar-layout-1.company-settings-sidebar.environments")}
              icon={MonitorCog}
              end
            />
          )}
          {showPage("instance.access") && (
            <SidebarNavItem
              to={`${INSTANCE_SETTINGS_PATH_PREFIX}/access`}
              label={t("area.shell-sidebar-layout-1.company-settings-sidebar.access")}
              icon={Shield}
              end
            />
          )}
          {/* myrmidon(LICENSING): closed-module licenses, instance admin only */}
          {isInstanceAdmin && (
            <SidebarNavItem to={LICENSES_PATH} label={t("licensing.title")} icon={BadgeCheck} end />
          )}
          {/* myrmidon(ROLE-SCOPED-TOKENS): scoped board API key management */}
          {showPage("instance.access") && (
            <SidebarNavItem
              to={`${INSTANCE_SETTINGS_PATH_PREFIX}/board-api-keys`}
              label={t("area.shell-sidebar-layout-1.company-settings-sidebar.boardApiKeys")}
              icon={KeyRound}
              end
            />
          )}
          {showPage("instance.heartbeats") && (
            <SidebarNavItem
              to={`${INSTANCE_SETTINGS_PATH_PREFIX}/heartbeats`}
              label={t("area.shell-sidebar-layout-1.company-settings-sidebar.heartbeats")}
              icon={Clock3}
              end
            />
          )}
          {showPage("company.export") && (
            <SidebarNavItem to="/company/export" label={t("area.shell-sidebar-layout-1.company-settings-sidebar.export")} icon={Download} />
          )}
          {!isCloud && showPage("company.import") && (
            <SidebarNavItem to="/company/import" label={t("area.shell-sidebar-layout-1.company-settings-sidebar.import")} icon={Upload} end />
          )}
          {showPage("instance.experimental") && (
            <SidebarNavItem
              to={`${INSTANCE_SETTINGS_PATH_PREFIX}/experimental`}
              label={t("area.shell-sidebar-layout-1.company-settings-sidebar.experimental")}
              icon={FlaskConical}
            />
          )}
          {/* myrmidon(FEATURES): fork features with live health */}
          <SidebarNavItem
            to={`${INSTANCE_SETTINGS_PATH_PREFIX}/features`}
            label={t("area.shell-sidebar-layout-1.company-settings-sidebar.features")}
            icon={ListChecks}
          />
          {showPlugins && (
            <SidebarNavItem
              to={`${INSTANCE_SETTINGS_PATH_PREFIX}/plugins`}
              label={t("area.shell-sidebar-layout-1.company-settings-sidebar.plugins")}
              icon={Puzzle}
            />
          )}
          {showPlugins && sidebarPlugins.length > 0 ? (
            <div className="ml-4 mt-1 flex flex-col gap-0.5 border-l border-border/70 pl-3">
              {sidebarPlugins.map((plugin) => (
                <NavLink
                  key={plugin.id}
                  to={`${INSTANCE_SETTINGS_PATH_PREFIX}/plugins/${plugin.id}`}
                  state={SIDEBAR_SCROLL_RESET_STATE}
                  className={({ isActive }) =>
                    [
                      "rounded-md px-2 py-1.5 text-xs transition-colors",
                      isActive
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    ].join(" ")
                  }
                >
                  {plugin.manifestJson.displayName ?? plugin.packageName}
                </NavLink>
              ))}
            </div>
          ) : null}
          {showPage("instance.adapters") && (
            <SidebarNavItem
              to={`${INSTANCE_SETTINGS_PATH_PREFIX}/adapters`}
              label={t("area.shell-sidebar-layout-1.company-settings-sidebar.adapters")}
              icon={Cpu}
            />
          )}
        </div>
      </nav>
    </aside>
  );
}

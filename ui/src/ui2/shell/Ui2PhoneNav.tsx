// myrmidon(UI-0a): UI-2.0 phone frame — 56px header (logo + status) and the
// bottom tab bar (Center / Decisions / Agents / Servers / Commander / More) at 390px.
// Touch targets: tab items 60px high (screen-map §3.3: >= 44px, bar items 60).
// Desktop rail is hidden on phone; pages render in the column between the
// two bars.
import { useTranslation } from "@/i18n";
import { Link, useLocation } from "@/lib/router";
import { MyrmidonLockup } from "@/components/myrmidon/MyrmidonLockup"; // myrmidon(B1a)
import { UI2_PHONE_TABS } from "../navModel";
import { useUi2AttentionCount } from "../useUi2Status";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { useCompany } from "@/context/CompanyContext";

function PhoneTab({
  to,
  icon: Icon,
  label,
  active,
  badge,
}: {
  to: string;
  icon: typeof GaugeIcon;
  label: string;
  active: boolean;
  badge?: number;
}) {
  return (
    <Link
      to={to}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        height: "var(--myr-phone-tabbar-height)",
        color: active ? "var(--myr-ink)" : "var(--myr-ink-muted)",
        textDecoration: "none",
        position: "relative",
        minWidth: 44,
      }}
    >
      <span style={{ position: "relative", display: "inline-flex" }}>
        <Icon aria-hidden="true" style={{ width: 20, height: 20 }} />
        {badge != null && badge > 0 ? (
          <span
            style={{
              position: "absolute",
              top: -6,
              right: -10,
              background: "var(--myr-inverse-surface)",
              color: "var(--myr-on-navy)",
              borderRadius: "var(--myr-radius-sm)",
              fontSize: "var(--myr-text-nano)",
              fontWeight: 700,
              lineHeight: 1,
              padding: "2px 5px",
            }}
          >
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
      </span>
      <span
        style={{
          fontSize: "var(--myr-text-nano)",
          fontWeight: active ? 700 : 500,
          maxWidth: 64,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {active ? (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 0,
            left: "25%",
            right: "25%",
            height: 2,
            background: "var(--myr-navy-deep)",
            borderRadius: "var(--myr-radius-sm)",
          }}
        />
      ) : null}
    </Link>
  );
}

// lucide icon type alias kept local to dodge an import cycle in types.
import type { Gauge as GaugeIcon } from "lucide-react";

export function Ui2PhoneHeader() {
  const { t } = useTranslation();
  return (
    <div
      className="myr-ui2__phone-header"
      style={{
        height: "var(--myr-phone-topbar-height)",
        display: "flex",
        alignItems: "center",
        gap: "var(--myr-space-1)",
        padding: "0 var(--myr-space-2)",
        background: "var(--myr-surface-raised)",
        borderBottom: "1px solid var(--myr-hairline)",
      }}
    >
      <MyrmidonLockup className="max-h-6 w-auto" decorative />
      <span style={{ marginLeft: "auto", fontSize: "var(--myr-text-nano)", color: "var(--myr-ink-muted)" }}>
        {t("ui2.phone.status", { defaultValue: "Owner · Web" })}
      </span>
    </div>
  );
}

export function isUi2PhoneTabActive(tabPath: string, pathname: string): boolean {
  const normalizedPath = pathname.split("?")[0].replace(/\/$/, "") || "/";
  const normalizedTabPath = tabPath.replace(/\/$/, "") || "/";
  if (normalizedTabPath === "/agents/all") return normalizedPath === "/agents/all";
  if (normalizedTabPath === "/agents") return normalizedPath === "/agents" || normalizedPath.startsWith("/agents/") && !normalizedPath.startsWith("/agents/all");
  return normalizedPath === normalizedTabPath || normalizedPath.startsWith(`${normalizedTabPath}/`);
}

export function Ui2PhoneTabBar() {
  const { t } = useTranslation();
  const location = useLocation();
  const attentionCount = useUi2AttentionCount();
  const { selectedCompany } = useCompany();

  return (
    <div>
    <nav
      className="myr-ui2__phone-tabbar"
      style={{
        height: "var(--myr-phone-tabbar-height)",
        display: "grid",
        gridTemplateColumns: `repeat(${UI2_PHONE_TABS.length}, 1fr)`,
        background: "var(--myr-surface-raised)",
        borderTop: "1px solid var(--myr-hairline)",
      }}
      aria-label={t("ui2.nav.railLabel", { defaultValue: "Main navigation" })}
    >
      {UI2_PHONE_TABS.map((tab) => {
        const active = isUi2PhoneTabActive(tab.to, location.pathname);
        return (
          <PhoneTab
            key={tab.labelKey}
            to={tab.to}
            icon={tab.icon}
            label={t(tab.labelKey)}
            active={active}
            badge={tab.badge === "attention" ? (attentionCount ?? undefined) : undefined}
          />
        );
      })}
    </nav>
    {selectedCompany ? <PluginLauncherOutlet
      placementZones={["sidebar"]}
      context={{ companyId: selectedCompany?.id, companyPrefix: selectedCompany?.issuePrefix }}
      className="flex flex-wrap justify-center gap-1"
      itemClassName="text-(length:--text-nano)"
    /> : null}
    </div>
  );
}

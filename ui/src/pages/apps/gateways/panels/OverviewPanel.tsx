import { Copy } from "lucide-react";
import type { ToolMcpGatewayWithTokens, ToolProfileWithDetails } from "@myrmidon/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useToast } from "@/context/ToastContext";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useTranslation } from "@/i18n";
import {
  activeTokenCount,
  allowedToolsLabel,
  expiringTokenCount,
  formatScope,
  type GatewayAppRow,
  gatewayAppDisplayName,
  isGatewayOn,
} from "../gateway-helpers";

export function OverviewPanel({
  gateway,
  profile,
  apps,
  agentNames,
  projectNames,
  toggleDisabled,
  onToggle,
}: {
  gateway: ToolMcpGatewayWithTokens;
  profile: ToolProfileWithDetails | undefined;
  apps: GatewayAppRow[];
  agentNames: Map<string, string>;
  projectNames: Map<string, string>;
  toggleDisabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { pushToast } = useToast();
  const endpoint = `${typeof window !== "undefined" ? window.location.origin : ""}${gateway.endpointPath}`;
  const active = activeTokenCount(gateway);
  const expiring = expiringTokenCount(gateway);
  const needsAttention = apps.filter((app) => app.needsAttention);
  const on = isGatewayOn(gateway);

  const snippet = [
    "{",
    '  "mcpServers": {',
    `    "paperclip-${gateway.displaySlug}": {`,
    `      "url": "${endpoint}",`,
    '      "headers": { "Authorization": "Bearer pcgw_•••_TOKEN" }',
    "    }",
    "  }",
    "}",
  ].join("\n");

  async function copy(value: string, label: string) {
    try {
      await copyTextToClipboard(value);
      pushToast({ title: t("area.apps-gateways-2.overview-panel.copied"), body: label, tone: "success" });
    } catch {
      pushToast({ title: t("area.apps-gateways-2.overview-panel.copyFailed"), body: t("area.apps-gateways-2.overview-panel.clipboardUnavailable"), tone: "error" });
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border p-4">
          <div className="text-xs font-medium text-muted-foreground">{on ? t("area.apps-gateways-2.overview-panel.on") : t("area.apps-gateways-2.overview-panel.off")}</div>
          <div className="mt-2">
            <ToggleSwitch checked={on} disabled={toggleDisabled} onCheckedChange={onToggle} aria-label={t("area.apps-gateways-2.overview-panel.toggleGateway")} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t("area.apps-gateways-2.overview-panel.toggleHint")}</p>
        </div>
        <StatCard label={t("area.apps-gateways-2.overview-panel.statApps")}>
          {t("area.apps-gateways-2.overview-panel.appsCount", { count: apps.length })}
          {profile ? ` · ${allowedToolsLabel(profile)}` : ""}
        </StatCard>
        <StatCard label={t("area.apps-gateways-2.overview-panel.statTokens")}>
          {expiring > 0
            ? t("area.apps-gateways-2.overview-panel.tokensActiveExpiring", { active, expiring })
            : t("area.apps-gateways-2.overview-panel.tokensActive", { active })}
        </StatCard>
        <StatCard label={t("area.apps-gateways-2.overview-panel.statHealth")}>
          {needsAttention.length === 0
            ? t("area.apps-gateways-2.overview-panel.allGreen")
            : t("area.apps-gateways-2.overview-panel.needsAttentionCount", { count: needsAttention.length })}
        </StatCard>
      </div>

      <section className="rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t("area.apps-gateways-2.overview-panel.whoCanUse")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("area.apps-gateways-2.overview-panel.whoCanUseHint")}
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Chip>{t("area.apps-gateways-2.overview-panel.chipScope", { value: formatScope(gateway, projectNames, agentNames) })}</Chip>
          <Chip>{t("area.apps-gateways-2.overview-panel.chipProfile", { name: profile?.name ?? t("area.apps-gateways-2.overview-panel.profileUnavailable") })}</Chip>
          <Chip>{t("area.apps-gateways-2.overview-panel.chipActiveTokens", { count: active })}</Chip>
        </div>
      </section>

      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold text-foreground">{t("area.apps-gateways-2.overview-panel.appsInGateway")}</h3>
        {apps.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {t("area.apps-gateways-2.overview-panel.appsEmpty")}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {apps.map((app) => (
              <AppRow key={app.application.id} app={app} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-border bg-muted/30 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">{t("area.apps-gateways-2.overview-panel.howClientsConnect")}</h3>
          <Button variant="outline" size="sm" onClick={() => void copy(snippet, t("area.apps-gateways-2.overview-panel.clientConfig"))}>
            <Copy className="mr-1 h-3.5 w-3.5" />
            {t("area.apps-gateways-2.overview-panel.copy")}
          </Button>
        </div>
        <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-3 font-mono text-xs text-muted-foreground">
          {snippet}
        </pre>
      </section>
    </div>
  );
}

function StatCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-semibold text-foreground">{children}</div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground">
      {children}
    </span>
  );
}

function AppRow({ app }: { app: GatewayAppRow }) {
  const { t } = useTranslation();
  const href = app.connection
    ? `/apps/${app.connection.id}/permissions`
    : `/apps/app/${app.application.id}/permissions`;
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <Link to={href} className="font-medium text-foreground hover:underline">
          {gatewayAppDisplayName(app)}
        </Link>
        <div className="text-xs text-muted-foreground">
          {t("area.apps-gateways-2.overview-panel.toolsCount", { count: app.toolCount })}
          {app.needsAttention && app.attentionReason ? ` · ${app.attentionReason}` : ""}
        </div>
      </div>
      <span
        className={cn(
          "shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
          app.needsAttention
            ? "border-foreground bg-foreground text-background"
            : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        )}
      >
        {app.needsAttention ? t("area.apps-gateways-2.overview-panel.needsAttention") : t("area.apps-gateways-2.overview-panel.healthy")}
      </span>
    </li>
  );
}

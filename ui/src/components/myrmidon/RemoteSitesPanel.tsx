import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";

export type RemoteSiteStatus = "reachable" | "degraded" | "unreachable" | "draining" | "quarantined" | "disabled";
export type RemoteSiteAction = "restart" | "stop" | "move" | "drain" | "resume";
export interface RemoteBotRow { agent: string; imageDigest: string; state: string; drift: boolean; apiBaseUrl: string; }
export interface RemoteSiteRow {
  name: string; status: RemoteSiteStatus; lastSeenAt: string | null; capacity: { used: number; total: number };
  botCount: number; driftCount: number; clientCertNotAfter: string | null; bots: RemoteBotRow[];
}
export interface RemoteSitesPanelProps {
  sites: RemoteSiteRow[]; loading?: boolean; error?: string | null; nowMs?: number; healthTtlMs?: number;
  allowedActions?: Partial<Record<RemoteSiteAction, boolean>>;
  onAction?: (action: RemoteSiteAction, site: RemoteSiteRow, bot?: RemoteBotRow) => void;
}

const actions: RemoteSiteAction[] = ["restart", "stop", "move", "drain", "resume"];
const statusKeys: Record<RemoteSiteStatus, string> = { reachable: "reachable", degraded: "degraded", unreachable: "unreachable", draining: "draining", quarantined: "quarantined", disabled: "disabled" };
const actionKeys: RemoteSiteAction[] = actions;

export function RemoteSitesPanel({ sites, loading = false, error = null, nowMs = Date.now(), healthTtlMs = 60_000, allowedActions = {}, onAction }: RemoteSitesPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  if (loading) return <p role="status">{t("remoteSites.loading")}</p>;
  if (error) return <p role="alert">{t("remoteSites.error", { error })}</p>;
  if (!sites.length) return <p>{t("remoteSites.empty")}</p>;
  const toggle = (name: string) => setExpanded(current => { const next = new Set(current); next.has(name) ? next.delete(name) : next.add(name); return next; });
  return <section aria-label={t("remoteSites.title")} className="min-w-0 space-y-3" data-testid="remote-sites-panel">
    <p className="text-xs text-muted-foreground">{t("remoteSites.fixture")}</p>
    <div className="grid min-w-0 gap-3">
      {sites.map(site => {
        const seen = site.lastSeenAt ? Date.parse(site.lastSeenAt) : NaN;
        const stale = !Number.isFinite(seen) || nowMs - seen > healthTtlMs;
        const expired = !!site.clientCertNotAfter && Date.parse(site.clientCertNotAfter) <= nowMs;
        const open = expanded.has(site.name);
        return <article key={site.name} className="min-w-0 overflow-hidden rounded-lg border bg-card p-3" data-testid={`remote-site-${site.name}`}>
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><h3 className="break-words font-semibold">{site.name}</h3>
              <p>{t(`remoteSites.status.${statusKeys[site.status]}`)}{stale ? ` · ${t("remoteSites.stale")}` : ""}</p>
              {expired ? <p role="alert">{t("remoteSites.expired")}</p> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <span>{t("remoteSites.capacity", { used: site.capacity.used, total: site.capacity.total })}</span><span>{t("remoteSites.botsCount", { count: site.botCount })}</span><span>{t("remoteSites.driftCount", { count: site.driftCount })}</span>
              <Button variant="outline" size="sm" aria-expanded={open} aria-label={t(open ? "remoteSites.hideBots" : "remoteSites.showBots", { name: site.name })} onClick={() => toggle(site.name)}>{open ? t("remoteSites.hideBotsLabel") : t("remoteSites.showBotsLabel")}</Button>
            </div>
          </div>
          {open ? <div className="mt-3 min-w-0 space-y-3" data-testid={`remote-site-bots-${site.name}`}>
            {site.bots.map(bot => <div key={bot.agent} className="min-w-0 break-words rounded-md border p-3">
              <h4 className="font-medium">{bot.agent}</h4><p>{t("remoteSites.image")} <code className="break-all">{bot.imageDigest}</code></p><p>{t("remoteSites.state")} {bot.state}{bot.drift ? ` · ${t("remoteSites.drift")}` : ""}</p><p className="break-all">{t("remoteSites.api")} {bot.apiBaseUrl}</p>
              <div className="mt-2 flex flex-wrap gap-2">{actionKeys.map(action => <Button key={action} size="sm" variant="outline" disabled={!onAction || allowedActions[action] !== true || stale || expired || site.status === "unreachable" || site.status === "disabled"} onClick={() => onAction?.(action, site, bot)}>{t(`remoteSites.action.${action}`)}</Button>)}</div>
            </div>)}
            {!site.bots.length ? <p>{t("remoteSites.noBots")}</p> : null}
          </div> : null}
        </article>;
      })}
    </div>
  </section>;
}

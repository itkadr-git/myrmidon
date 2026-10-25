// myrmidon(1.6.6 REMOTE-SITES-T8): the table of remote execution sites for the current UI: status, last
// answer, capacity, drift, key lifetime, and per site its bots with restart / stop / move / log.
// Presentation only: RemoteSitesSection owns the requests.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { siteCertState } from "@/lib/remoteSites";

export type RemoteSiteStatus = "reachable" | "degraded" | "unreachable" | "draining" | "quarantined" | "disabled" | "unknown";
export type RemoteSiteAction = "restart" | "stop" | "move" | "drain" | "resume" | "logs";

export interface RemoteBotRow {
  botKey: string;
  agent: string;
  state: string;
  image: string | null;
  drift: boolean;
  driftFields: string[];
  apiBaseUrl: string | null;
  pinned: boolean;
}

export interface RemoteSiteRow {
  name: string;
  status: RemoteSiteStatus;
  /** The registry status as stored: draining shows Resume, active shows Drain. */
  registryStatus: string;
  autoDrained: boolean;
  lastSeenAt: string | null;
  capacity: {
    cpus: { used: number; total: number };
    memoryMb: { used: number; total: number };
    bots: { used: number; total: number | null };
  };
  botCount: number;
  driftCount: number | null;
  clientCertNotAfter: string | null;
  /** undefined: not asked yet or loading; null: the request failed. */
  bots?: RemoteBotRow[] | null;
}

export interface RemoteSitesPanelProps {
  sites: RemoteSiteRow[];
  loading?: boolean;
  error?: string | null;
  fixture?: boolean;
  nowMs?: number;
  healthTtlMs?: number;
  /** A request is running: the buttons wait. */
  busy?: boolean;
  /** Where a bot can be moved: other active sites, then the board host ("local"). */
  moveTargets?: (site: RemoteSiteRow) => string[];
  logsByBot?: Record<string, string>;
  /** Last failed action, shown under the site it belongs to. */
  failure?: { site: string; message: string } | null;
  notice?: string | null;
  onExpand?: (site: RemoteSiteRow) => void;
  onAction?: (action: RemoteSiteAction, site: RemoteSiteRow, bot?: RemoteBotRow, target?: string) => void;
}

const BOARD_HOST = "local";
const STATE_KEYS = ["running", "stopped", "missing", "unhealthy", "unknown"];

function BotRowView({
  bot, site, usable, busy, targets, logs, onAction,
}: {
  bot: RemoteBotRow; site: RemoteSiteRow; usable: boolean; busy: boolean; targets: string[]; logs?: string;
  onAction?: RemoteSitesPanelProps["onAction"];
}) {
  const { t } = useTranslation();
  const [confirmStop, setConfirmStop] = useState(false);
  const [target, setTarget] = useState("");
  const disabled = !onAction || !usable || busy;
  return (
    <div className="min-w-0 break-words rounded-md border p-3" data-testid={`remote-bot-${bot.botKey}`}>
      <h4 className="font-medium">{bot.agent}</h4>
      {bot.image ? <p>{t("remoteSites.image")} <code className="break-all">{bot.image}</code></p> : null}
      <p>
        {t("remoteSites.state")} {t(`remoteSites.botState.${STATE_KEYS.includes(bot.state) ? bot.state : "unknown"}`)}
        {bot.pinned ? ` · ${t("remoteSites.pinned")}` : ""}
      </p>
      {bot.drift ? <p role="status" data-testid={`remote-bot-drift-${bot.botKey}`}>{t("remoteSites.botDrift", { fields: bot.driftFields.join(", ") })}</p> : null}
      {bot.apiBaseUrl ? <p className="break-all">{t("remoteSites.api")} {bot.apiBaseUrl}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onAction?.("restart", site, bot)}>{t("remoteSites.action.restart")}</Button>
        {confirmStop ? (
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => { setConfirmStop(false); onAction?.("stop", site, bot); }}>{t("remoteSites.action.confirmStop")}</Button>
        ) : (
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => setConfirmStop(true)}>{t("remoteSites.action.stop")}</Button>
        )}
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onAction?.("logs", site, bot)}>
          {logs === undefined ? t("remoteSites.action.logs") : t("remoteSites.action.hideLogs")}
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          aria-label={t("remoteSites.moveTo")}
          value={target}
          disabled={disabled}
          onChange={(event) => setTarget(event.target.value)}
        >
          <option value="">{t("remoteSites.moveTo")}</option>
          {targets.map((name) => <option key={name} value={name}>{name === BOARD_HOST ? t("remoteSites.boardHost") : name}</option>)}
        </select>
        <Button size="sm" variant="outline" disabled={disabled || !target || bot.pinned} onClick={() => onAction?.("move", site, bot, target)}>{t("remoteSites.action.move")}</Button>
      </div>
      {logs !== undefined ? (
        <pre className="mt-2 max-h-64 overflow-auto rounded-md border bg-muted p-2 text-xs" data-testid={`remote-bot-logs-${bot.botKey}`}>{logs || t("remoteSites.logsEmpty")}</pre>
      ) : null}
    </div>
  );
}

export function RemoteSitesPanel({
  sites, loading = false, error = null, fixture = false, nowMs = Date.now(), healthTtlMs = 60_000, busy = false,
  moveTargets, logsByBot = {}, failure = null, notice = null, onExpand, onAction,
}: RemoteSitesPanelProps) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  if (loading) return <p role="status">{t("remoteSites.loading")}</p>;
  if (error) return <p role="alert">{t("remoteSites.error", { error })}</p>;
  if (!sites.length) return <p>{t("remoteSites.empty")}</p>;
  const toggle = (site: RemoteSiteRow) => {
    const opening = !expanded.has(site.name);
    setExpanded((current) => { const next = new Set(current); if (opening) next.add(site.name); else next.delete(site.name); return next; });
    if (opening) onExpand?.(site);
  };
  return <section aria-label={t("remoteSites.title")} className="min-w-0 space-y-3" data-testid="remote-sites-panel">
    {fixture ? <p className="text-xs text-muted-foreground">{t("remoteSites.fixture")}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <div className="grid min-w-0 gap-3">
      {sites.map((site) => {
        const seen = site.lastSeenAt ? Date.parse(site.lastSeenAt) : NaN;
        const stale = !Number.isFinite(seen) || nowMs - seen > healthTtlMs;
        const cert = siteCertState(site.clientCertNotAfter, nowMs);
        const expired = cert.state === "expired";
        const certDate = site.clientCertNotAfter ? new Date(site.clientCertNotAfter).toLocaleDateString(i18n.language) : "";
        const open = expanded.has(site.name);
        // A bot can be acted on while the site is not fenced and its key is valid; the server has the last word.
        const usable = !expired && site.status !== "disabled" && site.status !== "quarantined";
        const bots = site.capacity.bots.total === null ? String(site.capacity.bots.used) : `${site.capacity.bots.used}/${site.capacity.bots.total}`;
        return <article key={site.name} className="min-w-0 overflow-hidden rounded-lg border bg-card p-3" data-testid={`remote-site-${site.name}`}>
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><h3 className="break-words font-semibold">{site.name}</h3>
              <p data-testid={`remote-site-status-${site.name}`}>
                {t(`remoteSites.status.${site.status}`)}{site.autoDrained && site.status !== "reachable" ? ` · ${t("remoteSites.autoDrained")}` : ""}{stale ? ` · ${t("remoteSites.stale")}` : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                {site.lastSeenAt ? t("remoteSites.lastSeen", { time: new Date(site.lastSeenAt).toLocaleString(i18n.language) }) : t("remoteSites.neverSeen")}
              </p>
              <p className="text-xs" role={expired ? "alert" : undefined} data-testid={`remote-site-cert-${site.name}`}>
                {cert.state === "unknown"
                  ? t("remoteSites.certUnknown")
                  : expired
                    ? t("remoteSites.expired", { date: certDate })
                    : cert.state === "soon"
                      ? t("remoteSites.certSoon", { date: certDate, days: cert.days ?? 0 })
                      : t("remoteSites.certOk", { date: certDate, days: cert.days ?? 0 })}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span data-testid={`remote-site-capacity-${site.name}`}>
                {t("remoteSites.capacity", {
                  usedCpus: site.capacity.cpus.used, totalCpus: site.capacity.cpus.total,
                  usedMem: site.capacity.memoryMb.used, totalMem: site.capacity.memoryMb.total, bots,
                })}
              </span>
              <span>{t("remoteSites.botsCount", { count: site.botCount })}</span>
              <span data-testid={`remote-site-drift-${site.name}`}>{site.driftCount === null ? t("remoteSites.driftUnknown") : t("remoteSites.driftCount", { count: site.driftCount })}</span>
              <Button variant="outline" size="sm" aria-expanded={open} aria-label={t(open ? "remoteSites.hideBots" : "remoteSites.showBots", { name: site.name })} onClick={() => toggle(site)}>{open ? t("remoteSites.hideBotsLabel") : t("remoteSites.showBotsLabel")}</Button>
              {site.registryStatus === "active" ? <Button variant="outline" size="sm" disabled={!onAction || busy} onClick={() => onAction?.("drain", site)}>{t("remoteSites.action.drain")}</Button> : null}
              {site.registryStatus === "draining" ? <Button variant="outline" size="sm" disabled={!onAction || busy || expired} onClick={() => onAction?.("resume", site)}>{t("remoteSites.action.resume")}</Button> : null}
            </div>
          </div>
          {failure && failure.site === site.name ? <p className="mt-2 text-sm text-destructive" role="alert">{t("remoteSites.actionFailed", { error: failure.message })}</p> : null}
          {open ? <div className="mt-3 min-w-0 space-y-3" data-testid={`remote-site-bots-${site.name}`}>
            {site.bots === undefined ? <p role="status">{t("remoteSites.botsLoading")}</p> : null}
            {site.bots === null ? <p role="alert">{t("remoteSites.botsError")}</p> : null}
            {site.bots ? site.bots.map((bot) => (
              <BotRowView key={bot.botKey} bot={bot} site={site} usable={usable} busy={busy} targets={moveTargets ? moveTargets(site) : []} logs={logsByBot[bot.botKey]} onAction={onAction} />
            )) : null}
            {site.bots && !site.bots.length ? <p>{t("remoteSites.noBots")}</p> : null}
          </div> : null}
        </article>;
      })}
    </div>
  </section>;
}

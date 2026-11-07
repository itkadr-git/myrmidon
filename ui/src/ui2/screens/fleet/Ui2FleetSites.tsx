// myrmidon(1.6.6 REMOTE-SITES-T8): the execution-site part of the UI2 fleet screen: the table of sites
// (status, last answer, capacity, drift, key lifetime), the bots of a site with restart / stop / move / log,
// drain and resume, and the form that adds a site.
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fleetApi, type FleetSiteBot, type FleetSiteOverview, type FleetSiteState } from "@/api/fleet";
import { buildEnrollBody, EMPTY_ENROLL_FORM, siteCertState, type EnrollFormValues } from "@/lib/remoteSites";
import { queryKeys } from "@/lib/queryKeys";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import { Ui2ErrorNote, Ui2Section, Ui2StatusDot } from "../../components/ui2Primitives";

const BOARD_HOST = "local";

function siteTone(state: FleetSiteState): "ok" | "warning" | "danger" | "muted" {
  if (state === "healthy") return "ok";
  if (state === "degraded" || state === "draining") return "warning";
  if (state === "unreachable" || state === "quarantined") return "danger";
  return "muted";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const INPUT_CLASS = "ui2-input w-full rounded-md border border-border bg-background px-2 py-1 text-sm";
const BUTTON_CLASS = "ui2-button rounded-md border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50";

function BotRow({ companyId, bot, otherSites, usable }: { companyId: string; bot: FleetSiteBot; otherSites: string[]; usable: boolean }) {
  const { t } = useUi2I18n();
  const queryClient = useQueryClient();
  const [confirmStop, setConfirmStop] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.fleetSites(companyId) });
  const restart = useMutation({ mutationFn: () => fleetApi.restartBot(bot.botKey), onSuccess: () => { setFailure(null); void refresh(); }, onError: (e) => setFailure(errorText(e)) });
  const stop = useMutation({ mutationFn: () => fleetApi.stopBot(bot.botKey), onSuccess: () => { setFailure(null); setConfirmStop(false); void refresh(); }, onError: (e) => setFailure(errorText(e)) });
  const logsMutation = useMutation({ mutationFn: () => fleetApi.botLogs(bot.botKey), onSuccess: (data) => { setFailure(null); setLogs(data.logs); }, onError: (e) => setFailure(errorText(e)) });
  const move = useMutation({
    mutationFn: () => fleetApi.moveBot(bot.botKey, target),
    onSuccess: (data) => { setFailure(null); setNote(t("ui2.screens.fleet.botMoved", { phase: data.move.phase })); void refresh(); },
    onError: (e) => setFailure(errorText(e)),
  });
  const busy = restart.isPending || stop.isPending || move.isPending;
  const destinations = [...otherSites, BOARD_HOST];
  return (
    <div className="ui2-fleet-bot flex flex-col gap-2 py-3" data-testid={`bot-${bot.botKey}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{bot.agentName}</span>
          <span className="text-xs" data-testid={`bot-state-${bot.botKey}`}>{t(`ui2.screens.fleet.botStates.${bot.state}` as never)}</span>
          {bot.pinned ? <span className="text-xs text-muted-foreground">{t("ui2.screens.fleet.botPinned")}</span> : null}
          {bot.drift ? <span className="text-xs text-destructive" data-testid={`bot-drift-${bot.botKey}`}>{t("ui2.screens.fleet.botDrift", { fields: bot.driftFields.join(", ") })}</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BUTTON_CLASS} disabled={!usable || busy} onClick={() => restart.mutate()}>{t("ui2.screens.fleet.botRestart")}</button>
          {confirmStop ? (
            <button type="button" className={BUTTON_CLASS} disabled={!usable || busy} onClick={() => stop.mutate()}>{t("ui2.screens.fleet.botStopConfirm")}</button>
          ) : (
            <button type="button" className={BUTTON_CLASS} disabled={!usable || busy} onClick={() => setConfirmStop(true)}>{t("ui2.screens.fleet.botStop")}</button>
          )}
          <button type="button" className={BUTTON_CLASS} disabled={!usable || logsMutation.isPending} onClick={() => (logs === null ? logsMutation.mutate() : setLogs(null))}>
            {logs === null ? t("ui2.screens.fleet.botLogs") : t("ui2.screens.fleet.botLogsHide")}
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {bot.image ? <code className="break-all">{bot.image}</code> : null}
        {bot.apiBaseUrl ? <code className="break-all">{bot.apiBaseUrl}</code> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className={INPUT_CLASS + " max-w-xs"} aria-label={t("ui2.screens.fleet.botMoveTo")} value={target} onChange={(e) => setTarget(e.target.value)} disabled={!usable || busy}>
          <option value="">{t("ui2.screens.fleet.botMoveTo")}</option>
          {destinations.map((name) => (
            <option key={name} value={name}>{name === BOARD_HOST ? t("ui2.screens.fleet.botMoveBoardHost") : name}</option>
          ))}
        </select>
        <button type="button" className={BUTTON_CLASS} disabled={!usable || busy || !target || bot.pinned} onClick={() => move.mutate()}>{t("ui2.screens.fleet.botMove")}</button>
      </div>
      {note ? <p className="text-xs" role="status">{note}</p> : null}
      {failure ? <p className="text-xs text-destructive" role="alert">{t("ui2.screens.fleet.siteActionFailed", { error: failure })}</p> : null}
      {logs !== null ? (
        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted p-2 text-xs" data-testid={`bot-logs-${bot.botKey}`}>{logs || t("ui2.screens.fleet.botLogsEmpty")}</pre>
      ) : null}
    </div>
  );
}

function SiteBots({ companyId, site, otherSites, usable }: { companyId: string; site: FleetSiteOverview; otherSites: string[]; usable: boolean }) {
  const { t } = useUi2I18n();
  const query = useQuery({ queryKey: queryKeys.fleetSiteBots(companyId, site.name), queryFn: () => fleetApi.siteBots(companyId, site.name), refetchInterval: 30_000 });
  if (query.isLoading) return <p className="text-xs text-muted-foreground" role="status">{t("ui2.screens.fleet.botsLoading")}</p>;
  if (query.isError) return <Ui2ErrorNote message={t("ui2.screens.fleet.botsError")} />;
  const bots = query.data?.bots ?? [];
  if (bots.length === 0) return <p className="text-xs text-muted-foreground">{t("ui2.screens.fleet.botsEmpty")}</p>;
  return (
    <div className="flex flex-col divide-y divide-border" data-testid={`site-bots-${site.name}`}>
      {bots.map((bot) => <BotRow key={bot.botKey} companyId={companyId} bot={bot} otherSites={otherSites} usable={usable} />)}
    </div>
  );
}

function SiteCard({ companyId, site, otherSites, now }: { companyId: string; site: FleetSiteOverview; otherSites: string[]; now: number }) {
  const { t, locale } = useUi2I18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.fleetSites(companyId) });
  const drain = useMutation({ mutationFn: () => fleetApi.drainSite(companyId, site.name), onSuccess: () => { setFailure(null); void refresh(); }, onError: (e) => setFailure(errorText(e)) });
  const resume = useMutation({ mutationFn: () => fleetApi.resumeSite(companyId, site.name), onSuccess: () => { setFailure(null); void refresh(); }, onError: (e) => setFailure(errorText(e)) });
  const cert = siteCertState(site.clientCertNotAfter, now);
  const expired = site.certExpired || cert.state === "expired";
  const certDate = site.clientCertNotAfter ? new Date(site.clientCertNotAfter).toLocaleDateString(locale) : "";
  const usable = !expired && site.status !== "disabled" && site.status !== "quarantined";
  const bots = site.capacity.bots.total === null ? String(site.capacity.bots.used) : `${site.capacity.bots.used}/${site.capacity.bots.total}`;
  return (
    <div className="ui2-fleet-site flex flex-col gap-2 py-3" data-testid={`site-${site.name}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Ui2StatusDot tone={siteTone(site.state)} />
          <span className="font-medium">{site.name}</span>
          <span data-testid={`site-badge-${site.name}`} className="text-xs">
            {t(`ui2.screens.fleet.siteStates.${site.state}` as never)}
            {site.autoDrained && site.state !== "healthy" ? ` · ${t("ui2.screens.fleet.siteAutoDrained")}` : ""}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {site.lastSeenAt ? t("ui2.screens.fleet.siteLastSeen", { time: new Date(site.lastSeenAt).toLocaleString(locale) }) : t("ui2.screens.fleet.siteNeverSeen")}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span data-testid={`site-capacity-${site.name}`}>
          {t("ui2.screens.fleet.siteCapacity", {
            usedCpus: site.capacity.cpus.used,
            totalCpus: site.capacity.cpus.total,
            usedMem: site.capacity.memoryMb.used,
            totalMem: site.capacity.memoryMb.total,
            bots,
          })}
        </span>
        <span data-testid={`site-drift-${site.name}`}>
          {site.driftCount === null ? t("ui2.screens.fleet.siteDriftUnknown") : t("ui2.screens.fleet.siteDrift", { count: site.driftCount })}
        </span>
        <span data-testid={`site-cert-${site.name}`} role={expired ? "alert" : undefined} className={expired ? "text-destructive" : cert.state === "soon" ? "text-foreground" : undefined}>
          {cert.state === "unknown"
            ? t("ui2.screens.fleet.siteCertUnknown")
            : expired
              ? t("ui2.screens.fleet.siteCertExpired", { date: certDate })
              : cert.state === "soon"
                ? t("ui2.screens.fleet.siteCertSoon", { date: certDate, days: cert.days ?? 0 })
                : t("ui2.screens.fleet.siteCertOk", { date: certDate, days: cert.days ?? 0 })}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BUTTON_CLASS} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? t("ui2.screens.fleet.siteBotsHide") : t("ui2.screens.fleet.siteBotsShow")}
        </button>
        {site.status === "active" ? (
          <button type="button" className={BUTTON_CLASS} disabled={drain.isPending} onClick={() => drain.mutate()}>{t("ui2.screens.fleet.siteDrain")}</button>
        ) : null}
        {site.status === "draining" ? (
          <button type="button" className={BUTTON_CLASS} disabled={resume.isPending || expired} onClick={() => resume.mutate()}>{t("ui2.screens.fleet.siteResume")}</button>
        ) : null}
      </div>
      {failure ? <p className="text-xs text-destructive" role="alert">{t("ui2.screens.fleet.siteActionFailed", { error: failure })}</p> : null}
      {open ? <SiteBots companyId={companyId} site={site} otherSites={otherSites} usable={usable} /> : null}
    </div>
  );
}

type FieldKey = keyof EnrollFormValues;
const FIELD_LABEL: Record<FieldKey, string> = {
  name: "ui2.screens.fleet.addName",
  url: "ui2.screens.fleet.addUrl",
  tokenSecret: "ui2.screens.fleet.addToken",
  maxCpus: "ui2.screens.fleet.addMaxCpus",
  maxMemoryMb: "ui2.screens.fleet.addMaxMemory",
  maxBots: "ui2.screens.fleet.addMaxBots",
  gatewayPortStart: "ui2.screens.fleet.addPortStart",
  gatewayPortEnd: "ui2.screens.fleet.addPortEnd",
};
const FIELD_ORDER: FieldKey[] = ["name", "url", "tokenSecret", "maxCpus", "maxMemoryMb", "maxBots", "gatewayPortStart", "gatewayPortEnd"];

function AddSiteForm({ companyId }: { companyId: string }) {
  const { t } = useUi2I18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EnrollFormValues>(EMPTY_ENROLL_FORM);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const enroll = useMutation({
    mutationFn: (body: Parameters<typeof fleetApi.enrollSite>[1]) => fleetApi.enrollSite(companyId, body),
    onSuccess: (data) => {
      setProblem(null);
      setDone(t("ui2.screens.fleet.addDone", { name: data.site.name }));
      setForm(EMPTY_ENROLL_FORM);
      void queryClient.invalidateQueries({ queryKey: queryKeys.fleetSites(companyId) });
    },
    onError: (e) => { setDone(null); setProblem(errorText(e)); },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    const result = buildEnrollBody(form);
    if (!result.ok) {
      setProblem(t(`ui2.screens.fleet.addProblem.${result.problem}` as never, { field: t(FIELD_LABEL[result.field] as never) }));
      return;
    }
    setProblem(null);
    enroll.mutate(result.body);
  }
  if (!open) {
    return <button type="button" className={BUTTON_CLASS + " self-start"} onClick={() => setOpen(true)}>{t("ui2.screens.fleet.addSite")}</button>;
  }
  return (
    <form className="ui2-fleet-add flex flex-col gap-3" onSubmit={submit} data-testid="add-site-form">
      <p className="text-xs text-muted-foreground">{t("ui2.screens.fleet.addSiteHint")}</p>
      {FIELD_ORDER.map((field) => (
        <label key={field} className="flex flex-col gap-1 text-xs">
          <span>{t(FIELD_LABEL[field] as never)}</span>
          <input className={INPUT_CLASS} name={field} value={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value })} autoComplete="off" />
        </label>
      ))}
      {problem ? <p className="text-xs text-destructive" role="alert" data-testid="add-site-problem">{problem}</p> : null}
      {done ? <p className="text-xs" role="status">{done}</p> : null}
      <div className="flex gap-2">
        <button type="submit" className={BUTTON_CLASS} disabled={enroll.isPending}>{enroll.isPending ? t("ui2.screens.fleet.addSubmitting") : t("ui2.screens.fleet.addSubmit")}</button>
      </div>
    </form>
  );
}

export function Ui2FleetSites({ companyId, sites, loading, failed }: { companyId: string; sites: FleetSiteOverview[]; loading: boolean; failed: boolean }) {
  const { t } = useUi2I18n();
  const now = Date.now();
  return (
    <Ui2Section title={t("ui2.screens.fleet.sites")}>
      {sites.length === 0 && !loading && !failed ? <p className="text-xs text-muted-foreground">{t("ui2.screens.fleet.siteEmpty")}</p> : null}
      {sites.length > 0 ? (
        <div className="flex flex-col divide-y divide-border">
          {sites.map((site) => (
            <SiteCard key={site.name} companyId={companyId} site={site} otherSites={sites.filter((s) => s.name !== site.name && s.status === "active").map((s) => s.name)} now={now} />
          ))}
        </div>
      ) : null}
      <AddSiteForm companyId={companyId} />
    </Ui2Section>
  );
}

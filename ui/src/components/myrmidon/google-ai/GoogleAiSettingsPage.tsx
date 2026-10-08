// myrmidon(GOOGLE-AI-CONNECT-UI): Settings → Google AI Pro page.
//
// The owner connects the board to their Google AI Pro subscription through the
// private bridge. The screen carries, in order: the ToS disclosure (read BEFORE
// the connect button — the ToS research), the one-time sign-in flow (paste the
// exported cookies JSON, the minimum acceptable path from the session runbook),
// the connection status with Reconnect/Disconnect, the bridge health
// (quota and session), the per-agent grants, the trial-image button, and the
// usage journal. The pasted secret is write-only: nothing here ever renders it
// back, and the server never echoes it.
//
// The view takes props and fires callbacks; the container below owns the data.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/api/client";
import type {
  GaiCapability,
  GaiConnection,
  GaiGenerateResult,
  GaiGrantTargetKind,
  GaiHealth,
  GaiJournalEntry,
  GaiStateView,
} from "@paperclipai/shared/myrmidon-google-ai-connector";
import { GAI_CAPABILITIES } from "@paperclipai/shared/myrmidon-google-ai-connector";
import { gaiApi, gaiStateQueryKey, type GaiSetGrantInput } from "./gaiApi";

const SELECT_CLASS = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

function readable(t: (key: string) => string, error: unknown): string {
  if (error instanceof ApiError) return error.message || t("googleAi.requestFailed");
  if (error instanceof Error) return error.message;
  return t("googleAi.requestFailed");
}

function fmtTime(t: (key: string, options?: Record<string, unknown>) => string, iso: string | null): string {
  if (!iso) return t("googleAi.neverChecked");
  return t("googleAi.lastChecked", { at: new Date(iso).toLocaleString() });
}

const STATUS_KEYS: Record<GaiConnection["status"], string> = {
  connected: "googleAi.statusConnected",
  stale: "googleAi.statusStale",
  error: "googleAi.statusError",
};

export interface GoogleAiSettingsPageViewProps {
  companyId: string;
  state: GaiStateView | null;
  journal: GaiJournalEntry[];
  loading: boolean;
  error: string | null;
  notice: string | null;
  pending: boolean;
  trialResult: GaiGenerateResult | null;
  trialError: string | null;
  onConnect: (cookieJson: string) => void;
  onReconnect: (cookieJson: string) => void;
  onDisconnect: () => void;
  onCheck: () => void;
  onTrial: (prompt: string) => void;
  onSetGrant: (input: GaiSetGrantInput) => void;
  onRemoveGrant: (grantId: string) => void;
}

export function GoogleAiSettingsPageView(props: GoogleAiSettingsPageViewProps) {
  const { t } = useTranslation();
  const [paste, setPaste] = useState("");
  const [trialPrompt, setTrialPrompt] = useState("");
  const [grantCapability, setGrantCapability] = useState<GaiCapability>("generate_image");
  const [grantTargetKind, setGrantTargetKind] = useState<GaiGrantTargetKind>("agent");
  const [grantAgentId, setGrantAgentId] = useState("");
  const [grantCaste, setGrantCaste] = useState("");

  const connection = props.state?.connection ?? null;
  const health = props.state?.health ?? null;
  const grants = props.state?.grants ?? [];
  const capabilities = props.state?.capabilities ?? [];
  const enabledFor = (capability: GaiCapability) =>
    capabilities.find((entry) => entry.id === capability)?.enabled ?? true;

  if (props.loading) {
    return <div className="p-4 text-sm text-muted-foreground">{t("googleAi.loading")}</div>;
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">{t("googleAi.title")}</h2>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">{t("googleAi.intro")}</p>

      {props.error ? <div className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">{props.error}</div> : null}
      {props.notice ? <div className="rounded-md border border-border p-2 text-sm" data-testid="myrmidon-gai-notice">{props.notice}</div> : null}

      {/* ToS disclosure — visible before any connect action. */}
      <section className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/5 p-3" data-testid="myrmidon-gai-disclosure">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("googleAi.riskTitle")}</h3>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>{t("googleAi.risk1")}</li>
          <li>{t("googleAi.risk2")}</li>
          <li>{t("googleAi.risk3")}</li>
        </ol>
      </section>

      {/* Status + the paste box */}
      <section className="space-y-3 rounded-md border border-border p-3" data-testid="myrmidon-gai-connection">
        {connection ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span data-testid="myrmidon-gai-status" className="font-medium">{t(STATUS_KEYS[connection.status])}</span>
            <span className="text-muted-foreground">{fmtTime(t, connection.lastCheckedAt)}</span>
            {connection.lastError ? (
              <span className="text-muted-foreground" data-testid="myrmidon-gai-last-error">{connection.lastError}</span>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="myrmidon-gai-not-connected">{t("googleAi.notConnected")}</p>
        )}
        {connection ? <p className="text-xs text-muted-foreground">{t("googleAi.connectedOn", { at: new Date(connection.connectedAt).toLocaleString() })}</p> : null}

        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase text-muted-foreground">{t("googleAi.howToTitle")}</p>
          <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
            <li>{t("googleAi.howTo1")}</li>
            <li>{t("googleAi.howTo2")}</li>
            <li>{t("googleAi.howTo3")}</li>
          </ol>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">{t("googleAi.pasteLabel")}</span>
          <textarea
            className="min-h-24 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
            value={paste}
            onChange={(event) => setPaste(event.target.value)}
            placeholder={t("googleAi.pastePlaceholder")}
            data-testid="myrmidon-gai-paste"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={props.pending || paste.trim().length === 0}
            onClick={() => props.onConnect(paste)}
            data-testid="myrmidon-gai-connect"
          >
            {t("googleAi.connect")}
          </Button>
          {connection ? (
            <>
              <Button
                variant="outline"
                disabled={props.pending || paste.trim().length === 0}
                onClick={() => props.onReconnect(paste)}
                data-testid="myrmidon-gai-reconnect"
              >
                {t("googleAi.reconnect")}
              </Button>
              <Button variant="outline" disabled={props.pending} onClick={() => props.onDisconnect()} data-testid="myrmidon-gai-disconnect">
                {t("googleAi.disconnect")}
              </Button>
            </>
          ) : null}
          {connection ? (
            <Button variant="outline" disabled={props.pending} onClick={() => props.onCheck()} data-testid="myrmidon-gai-check">
              {t("googleAi.checkNow")}
            </Button>
          ) : null}
        </div>
      </section>

      {/* Bridge health */}
      {health ? <HealthSection t={t} health={health} deliveryMode={props.state?.deliveryMode ?? "off"} /> : null}

      {/* Grants */}
      <section className="space-y-2 rounded-md border border-border p-3" data-testid="myrmidon-gai-grants">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("googleAi.grantsTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("googleAi.grantsHint")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("googleAi.capabilityLabel")}</span>
            <select
              className={SELECT_CLASS}
              value={grantCapability}
              onChange={(event) => setGrantCapability(event.target.value as GaiCapability)}
              data-testid="myrmidon-gai-grant-capability"
            >
              {GAI_CAPABILITIES.map((capability) => (
                <option key={capability} value={capability}>
                  {capability}
                  {enabledFor(capability) ? "" : ` — ${t("googleAi.disabled")}`}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("googleAi.targetKindLabel")}</span>
            <select
              className={SELECT_CLASS}
              value={grantTargetKind}
              onChange={(event) => setGrantTargetKind(event.target.value as GaiGrantTargetKind)}
              data-testid="myrmidon-gai-grant-target-kind"
            >
              <option value="agent">{t("googleAi.targetAgent")}</option>
              <option value="caste">{t("googleAi.targetCaste")}</option>
              <option value="all">{t("googleAi.targetAll")}</option>
            </select>
          </label>
          {grantTargetKind === "agent" ? (
            <label className="min-w-40 flex-1 space-y-1 text-xs">
              <span className="text-muted-foreground">{t("googleAi.agentIdLabel")}</span>
              <Input value={grantAgentId} onChange={(event) => setGrantAgentId(event.target.value)} data-testid="myrmidon-gai-grant-agent" />
            </label>
          ) : null}
          {grantTargetKind === "caste" ? (
            <label className="min-w-40 flex-1 space-y-1 text-xs">
              <span className="text-muted-foreground">{t("googleAi.casteLabel")}</span>
              <Input value={grantCaste} onChange={(event) => setGrantCaste(event.target.value)} data-testid="myrmidon-gai-grant-caste" />
            </label>
          ) : null}
          <Button
            disabled={
              props.pending
              || (grantTargetKind === "agent" && grantAgentId.trim().length === 0)
              || (grantTargetKind === "caste" && grantCaste.trim().length === 0)
            }
            onClick={() =>
              props.onSetGrant({
                capability: grantCapability,
                targetKind: grantTargetKind,
                agentId: grantTargetKind === "agent" ? grantAgentId.trim() : undefined,
                caste: grantTargetKind === "caste" ? grantCaste.trim() : undefined,
              })
            }
            data-testid="myrmidon-gai-grant-add"
          >
            {t("googleAi.addGrant")}
          </Button>
        </div>
        {grants.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="myrmidon-gai-no-grants">{t("googleAi.noGrants")}</p>
        ) : (
          <ul className="space-y-1 text-xs" data-testid="myrmidon-gai-grant-list">
            {grants.map((grant) => (
              <li key={grant.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1">
                <span>
                  <span className="font-medium">{grant.capability}</span>{" "}
                  <span className="text-muted-foreground">
                    {grant.targetKind === "all" ? t("googleAi.targetAll") : `${t(`googleAi.target${grant.targetKind === "agent" ? "Agent" : "Caste"}`)}: ${grant.targetKind === "agent" ? grant.agentId : grant.caste}`}
                  </span>
                </span>
                <Button variant="outline" size="sm" disabled={props.pending} onClick={() => props.onRemoveGrant(grant.id)} data-testid={`myrmidon-gai-grant-remove-${grant.id}`}>
                  {t("googleAi.remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Trial image */}
      <section className="space-y-2 rounded-md border border-border p-3" data-testid="myrmidon-gai-trial">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("googleAi.trialTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("googleAi.trialIntro")}</p>
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">{t("googleAi.trialPromptLabel")}</span>
          <Input
            value={trialPrompt}
            onChange={(event) => setTrialPrompt(event.target.value)}
            placeholder={t("googleAi.trialPromptPlaceholder")}
            data-testid="myrmidon-gai-trial-prompt"
          />
        </label>
        <Button disabled={props.pending || connection === null} onClick={() => props.onTrial(trialPrompt)} data-testid="myrmidon-gai-trial-run">
          {t("googleAi.trialRun")}
        </Button>
        {props.trialError ? <p className="text-sm text-destructive" data-testid="myrmidon-gai-trial-error">{props.trialError}</p> : null}
        {props.trialResult ? <TrialResult t={t} result={props.trialResult} /> : null}
      </section>

      {/* Journal */}
      <section className="space-y-2 rounded-md border border-border p-3" data-testid="myrmidon-gai-journal">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("googleAi.journalTitle")}</h3>
        {props.journal.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="myrmidon-gai-no-journal">{t("googleAi.noJournal")}</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {props.journal.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2">
                <span className="w-36 shrink-0 text-muted-foreground">{new Date(entry.at).toLocaleString()}</span>
                <span className="w-28 shrink-0">{entry.actorKind === "owner" ? t("googleAi.actorOwner") : entry.actor}</span>
                <span className="w-24 shrink-0 font-medium">{entry.action}</span>
                <span className={entry.ok ? "text-muted-foreground" : "text-destructive"} data-testid={`myrmidon-gai-journal-${entry.id}`}>
                  {entry.ok ? t("googleAi.done") : t("googleAi.refusedWord")} — {entry.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function HealthSection(props: { t: (key: string, options?: Record<string, unknown>) => string; health: GaiHealth | null; deliveryMode: string }) {
  const { t, health } = props;
  return (
    <section className="space-y-1 rounded-md border border-border p-3 text-sm" data-testid="myrmidon-gai-health">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("googleAi.healthTitle")}</h3>
      {!health ? (
        <p className="text-muted-foreground" data-testid="myrmidon-gai-health-none">{t("googleAi.bridgeUnreachable")}</p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span data-testid="myrmidon-gai-health-session">
            {t("googleAi.healthSession")}: {health.session === "ok" ? t("googleAi.sessionOk") : t("googleAi.sessionStale")}
          </span>
          <span>{t("googleAi.healthImages")}: {health.quota.images.used ?? "?"} / {health.quota.images.limit ?? "?"}</span>
          <span>
            {t("googleAi.healthVideos")}: {health.quota.videos.used ?? "?"} / {health.quota.videos.limit ?? "?"}
            {health.quota.paused ? ` — ${t("googleAi.healthPaused", { until: health.quota.pausedUntil ?? "" })}` : ""}
          </span>
          <span>{t("googleAi.healthVersion")}: {health.version ?? "?"}</span>
          <span className="text-muted-foreground">{t("googleAi.deliveryLabel")}: {props.deliveryMode}</span>
        </div>
      )}
    </section>
  );
}

function TrialResult(props: { t: (key: string) => string; result: GaiGenerateResult }) {
  const { t, result } = props;
  return (
    <div className="space-y-1 rounded-md border border-border p-2 text-xs" data-testid="myrmidon-gai-trial-result">
      {result.text ? (
        <p>
          <span className="text-muted-foreground">{t("googleAi.trialText")}: </span>
          {result.text}
        </p>
      ) : null}
      {result.imagePaths.length > 0 ? (
        <ul>
          <li className="text-muted-foreground">{t("googleAi.trialImages")}</li>
          {result.imagePaths.map((path) => (
            <li key={path} className="font-mono">{path}</li>
          ))}
        </ul>
      ) : null}
      {result.error ? <p className="text-destructive">{result.error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Container: the data and the mutations.
// ---------------------------------------------------------------------------

export function GoogleAiSettingsPage() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const [notice, setNotice] = useState<string | null>(null);
  const [trialResult, setTrialResult] = useState<GaiGenerateResult | null>(null);
  const [trialError, setTrialError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Settings", href: "/company/settings" }, { label: t("googleAi.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const stateQuery = useQuery({
    queryKey: [...gaiStateQueryKey, companyId],
    queryFn: () => gaiApi.state(companyId),
    enabled: companyId.length > 0,
  });
  const journalQuery = useQuery({
    queryKey: [...gaiStateQueryKey, "journal", companyId],
    queryFn: () => gaiApi.journal(companyId),
    enabled: companyId.length > 0,
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: gaiStateQueryKey }),
      queryClient.invalidateQueries({ queryKey: [...gaiStateQueryKey, "journal"] }),
    ]);
  };

  const connectMutation = useMutation({
    mutationFn: (cookieJson: string) => gaiApi.connect(companyId, cookieJson),
    onSuccess: (result) => {
      setNotice(t("googleAi.kept", { kept: result.keptCookies.join(", "), ignored: result.ignoredCookies }));
      void refresh();
    },
    onError: (error) => setNotice(readable(t, error)),
  });

  const reconnectMutation = useMutation({
    mutationFn: (cookieJson: string) => gaiApi.reconnect(companyId, cookieJson),
    onSuccess: (result) => {
      setNotice(t("googleAi.kept", { kept: result.keptCookies.join(", "), ignored: result.ignoredCookies }));
      void refresh();
    },
    onError: (error) => setNotice(readable(t, error)),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => gaiApi.disconnect(companyId),
    onSuccess: () => {
      setNotice(t("googleAi.disconnected"));
      void refresh();
    },
    onError: (error) => setNotice(readable(t, error)),
  });

  const checkMutation = useMutation({
    mutationFn: () => gaiApi.check(companyId),
    onSuccess: (result) => {
      if (result.staleNow) setNotice(t("googleAi.staleNow"));
      void refresh();
    },
    onError: (error) => setNotice(readable(t, error)),
  });

  const trialMutation = useMutation({
    mutationFn: (prompt: string) => gaiApi.trial(companyId, prompt.trim().length > 0 ? prompt.trim() : undefined),
    onSuccess: (result) => {
      setTrialResult(result);
      setTrialError(result.ok ? null : (result.error ?? t("googleAi.requestFailed")));
      void refresh();
    },
    onError: (error) => {
      setTrialResult(null);
      setTrialError(readable(t, error));
    },
  });

  const grantMutation = useMutation({
    mutationFn: (input: GaiSetGrantInput) => gaiApi.setGrant(companyId, input),
    onSuccess: () => {
      void refresh();
    },
    onError: (error) => setNotice(readable(t, error)),
  });

  const removeGrantMutation = useMutation({
    mutationFn: (grantId: string) => gaiApi.removeGrant(grantId, companyId),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(readable(t, error)),
  });

  if (!companyId) {
    return <div className="p-4 text-sm text-muted-foreground" data-testid="myrmidon-gai-no-company">{t("googleAi.noCompany")}</div>;
  }

  const pending =
    connectMutation.isPending
    || reconnectMutation.isPending
    || disconnectMutation.isPending
    || checkMutation.isPending
    || trialMutation.isPending
    || grantMutation.isPending
    || removeGrantMutation.isPending;

  return (
    <GoogleAiSettingsPageView
      companyId={companyId}
      state={stateQuery.data ?? null}
      journal={journalQuery.data?.entries ?? []}
      loading={stateQuery.isLoading || journalQuery.isLoading}
      error={stateQuery.error ? readable(t, stateQuery.error) : journalQuery.error ? readable(t, journalQuery.error) : null}
      notice={notice}
      pending={pending}
      trialResult={trialResult}
      trialError={trialError}
      onConnect={(cookieJson) => connectMutation.mutate(cookieJson)}
      onReconnect={(cookieJson) => reconnectMutation.mutate(cookieJson)}
      onDisconnect={() => disconnectMutation.mutate()}
      onCheck={() => checkMutation.mutate()}
      onTrial={(prompt) => trialMutation.mutate(prompt)}
      onSetGrant={(input) => grantMutation.mutate(input)}
      onRemoveGrant={(grantId) => removeGrantMutation.mutate(grantId)}
    />
  );
}

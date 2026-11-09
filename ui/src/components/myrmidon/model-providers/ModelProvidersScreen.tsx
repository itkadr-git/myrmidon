// myrmidon(1.6.1 MODEL-PROVIDERS C): the "Model providers" settings screen —
// layout + local interaction state; the wire state (queries, mutations) lives
// in ModelProvidersContainer.tsx so tests can drive both tiers separately.
//
// Sections:
//   1. Add provider form — type (dashscope|openai|google|openai-compatible),
//      display name, base URL, API key, free/paid flag. The key input is
//      write-only: it lives in local state only while the form is open and is
//      cleared on save; the saved provider renders a hasKey dot, never the
//      value. Rotate uses the same rule — a "new key" field that exists only
//      while the rotate form is open.
//   2. Provider cards — type/name/base URL, free/paid flag, models list with
//      enable checkboxes and per-model free/paid flags (owner rule: free
//      models first, free DashScope models at the very top), remove with
//      confirmation, rotate.
//   3. Change log — the add/rotate/remove/models_updated entries from the
//      Part A API.
//
// Key non-leak rule (tested): after any save the component renders only the
// API's key-free fields; the raw key never enters props, cache or DOM.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Boxes, KeyRound, Trash2, X } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/api/client";
import {
  modelProvidersApi,
  BUILTIN_MODEL_PROVIDER_TYPES,
  MODEL_PROVIDER_TYPES,
  sortModels,
  type AddModelProviderInput,
  type LitellmChannelsResponse,
  type ModelProviderChannelsView,
  type ModelProviderType,
  type ModelProvidersView,
  type ModelProviderView,
  type PoolAccountOAuthBeginResult,
} from "./modelProvidersApi";
import { HindsightModelGroupsPanel } from "../hindsight-models/HindsightModelGroupsPanel";

export function sanitizeErrorMessage(message: string): string {
  if (!message) return "";
  return message
    .replace(/(Bearer\s+)[A-Za-z0-9_.-]+/gi, "$1<redacted>")
    .replace(/(authorization["':\s=]+)[A-Za-z0-9_.-]+/gi, "$1<redacted>")
    .replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/gi, "<redacted>")
    .replace(/\b(pcp_[A-Za-z0-9_]+)\b/gi, "<redacted>")
    .replace(/(:\/\/[^:]+:)[^@]+(@)/g, "$1<redacted>$2")
    .replace(/(api[_-]?key["':\s=]+)[A-Za-z0-9_.-]+/gi, "$1<redacted>")
    .replace(/(secrets\/)[A-Za-z0-9_.-]+/gi, "$1<redacted>");
}

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

const POOL_PROVIDER_TYPES = ["chatgpt-pool", "antigravity-pool", "google-ai-pool"];

function isPoolProvider(type?: string): boolean {
  return POOL_PROVIDER_TYPES.includes(type ?? "");
}

function actorLabel(type?: string): string {
  // myrmidon(OPE-12361): labels come from the locale catalog (RU/EN parity).
  if (type === "agent") return "агент";
  if (type === "board") return "доска";
  if (type === "system") return "система";
  return "пользователь";
}

/** Null-safe epoch seconds for the pool reset date display (OPE-12361). */
function summaryNextResetEpoch(summary: NonNullable<ModelProviderChannelsView["summary"]>): number | null {
  return typeof summary.nextResetAt === "number" ? summary.nextResetAt : null;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function providerTypeLabel(type: ModelProviderType): string {
  return type; // machine-facing value shown in mono — not translated prose
}

const EMPTY_FORM: AddModelProviderInput = {
  type: "dashscope",
  name: "",
  baseUrl: "",
  key: "",
  free: false,
};

export function ModelProvidersScreenView({
  view,
  companyId,
  modelsQuery,
  channelsQuery,
  litellmChannelsQuery,
  litellmChannelsData,
  litellmChannelsLoading,
  litellmChannelsError,
  onAdd,
  adding,
  addError,
  onRotate,
  rotating,
  onRemove,
  removing,
  onToggleModel,
  savingModels,
  onRollback,
  rollingBack,
  rollbackError,
  error,
}: {
  view: ModelProvidersView;
  companyId: string;
  /** Query key factory for the per-provider model list (container owns it). */
  modelsQuery: (providerId: string) => readonly unknown[];
  /** Query key factory for the per-provider channels list. */
  channelsQuery?: (providerId: string) => readonly unknown[];
  /** Query key factory for the LiteLLM channels list. */
  litellmChannelsQuery?: (companyId: string) => readonly unknown[];
  /** Direct channels response for testing / override. */
  litellmChannelsData?: LitellmChannelsResponse;
  litellmChannelsLoading?: boolean;
  litellmChannelsError?: string | null;
  onAdd: (input: AddModelProviderInput) => void;
  adding: boolean;
  addError: string | null;
  onRotate: (providerId: string, key: string) => void;
  rotating: boolean;
  onRemove: (providerId: string) => void;
  removing: boolean;
  onToggleModel: (
    providerId: string,
    models: Array<{ modelName: string; litellmModelName: string; enabled: boolean; free: boolean }>,
  ) => void;
  savingModels: boolean;
  onRollback?: (auditId: string) => void;
  rollingBack?: boolean;
  rollbackError?: string | null;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<AddModelProviderInput>(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [rotateKey, setRotateKey] = useState("");
  const [confirmRollbackId, setConfirmRollbackId] = useState<string | null>(null);
  const [expandedDiffId, setExpandedDiffId] = useState<string | null>(null);

  const litellmChannelsQueryResult = useQuery({
    queryKey: litellmChannelsQuery
      ? litellmChannelsQuery(companyId)
      : ["myrmidon", "model-providers", companyId, "litellm-channels"],
    queryFn: () => modelProvidersApi.litellmChannels(companyId),
    enabled:
      companyId.length > 0 &&
      !litellmChannelsData &&
      litellmChannelsLoading === undefined &&
      litellmChannelsError === undefined,
  });

  const channelsData = litellmChannelsData ?? litellmChannelsQueryResult.data;
  const channelsLoading = litellmChannelsLoading ?? litellmChannelsQueryResult.isLoading;
  const rawChannelsError =
    litellmChannelsError ??
    (litellmChannelsQueryResult.error
      ? readable(litellmChannelsQueryResult.error)
      : null) ??
    channelsData?.error ??
    null;
  const channelsError = rawChannelsError ? sanitizeErrorMessage(rawChannelsError) : null;

  // The add form resets when the provider list changes after a save: the raw
  // key never survives a successful mutation in this component's state.
  useEffect(() => {
    setForm(EMPTY_FORM);
  }, [view]);

  const submitAdd = () => {
    if (!form.name.trim() || !form.key.trim()) return;
    onAdd({
      ...form,
      name: form.name.trim(),
      baseUrl: (form.baseUrl ?? "").trim() || null,
      key: form.key.trim(),
    });
    // Optimistic clear: the container invalidates on success; on error the
    // user retypes (the key is deliberately not kept in state on failure).
    setForm(EMPTY_FORM);
  };

  const submitRotate = (providerId: string) => {
    if (!rotateKey.trim()) return;
    onRotate(providerId, rotateKey.trim());
    setRotateKey("");
    setRotateId(null);
  };

  const providerFreeLabel = (provider: ModelProviderView) =>
    isPoolProvider(provider.type)
      ? t("modelProviders.channels.subscription")
      : provider.free
        ? t("modelProviders.free")
        : t("modelProviders.paid");

  const availableTypes: ModelProviderType[] = (
    view.availableTypes
      ? view.availableTypes.filter((t) => (MODEL_PROVIDER_TYPES as readonly string[]).includes(t))
      : (BUILTIN_MODEL_PROVIDER_TYPES as readonly ModelProviderType[])
  ) as ModelProviderType[];

  return (
    <div className="max-w-5xl space-y-6" data-testid="myrmidon-model-providers-screen">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Boxes className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("modelProviders.title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("modelProviders.intro")}</p>
      </div>

      {error ? (
        <p className="text-sm text-destructive" data-testid="myrmidon-model-providers-mutation-error">
          {error}
        </p>
      ) : null}

      {/* 1. Add provider */}
      <section className="space-y-3" data-testid="myrmidon-model-providers-add">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("modelProviders.add.title")}</h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setFormOpen((open) => !open);
              setForm(EMPTY_FORM);
            }}
            data-testid="myrmidon-model-providers-add-toggle"
          >
            {formOpen ? t("modelProviders.add.cancel") : t("modelProviders.add.open")}
          </Button>
        </div>
        {formOpen ? (
          <div className="grid gap-3 md:grid-cols-2" data-testid="myrmidon-model-providers-add-form">
            <div className="space-y-1">
              <Label htmlFor="model-provider-type">{t("modelProviders.add.type")}</Label>
              <select
                id="model-provider-type"
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as ModelProviderType })}
                data-testid="myrmidon-model-providers-add-type"
              >
                {availableTypes.map((type) => (
                  <option key={type} value={type}>
                    {providerTypeLabel(type)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="model-provider-name">{t("modelProviders.add.name")}</Label>
              <Input
                id="model-provider-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                data-testid="myrmidon-model-providers-add-name"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="model-provider-base-url">{t("modelProviders.add.baseUrl")}</Label>
              <Input
                id="model-provider-base-url"
                value={form.baseUrl ?? ""}
                placeholder={form.type === "openai-compatible" ? "https://…" : ""}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                data-testid="myrmidon-model-providers-add-base-url"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="model-provider-key">{t("modelProviders.add.key")}</Label>
              <Input
                id="model-provider-key"
                type="password"
                autoComplete="new-password"
                value={form.key}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                data-testid="myrmidon-model-providers-add-key"
              />
              <p className="text-xs text-muted-foreground">{t("modelProviders.add.keyHint")}</p>
            </div>
            <label className="flex items-center gap-2 text-sm" data-testid="myrmidon-model-providers-add-free">
              <input
                type="checkbox"
                checked={form.free}
                onChange={(e) => setForm({ ...form, free: e.target.checked })}
              />
              {t("modelProviders.add.free")}
            </label>
            <div className="flex items-end gap-2">
              <Button
                size="sm"
                onClick={submitAdd}
                disabled={adding || !form.name.trim() || !form.key.trim()}
                data-testid="myrmidon-model-providers-add-submit"
              >
                {adding ? t("modelProviders.add.saving") : t("modelProviders.add.save")}
              </Button>
            </div>
            {addError ? (
              <p className="text-xs text-destructive md:col-span-2" data-testid="myrmidon-model-providers-add-error">
                {addError}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* 2. Providers */}
      <section className="space-y-3" data-testid="myrmidon-model-providers-list">
        <h2 className="text-sm font-semibold">{t("modelProviders.list.title")}</h2>
        {view.providers.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="myrmidon-model-providers-empty">
            {t("modelProviders.list.empty")}
          </p>
        ) : (
          view.providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              companyId={companyId}
              modelsQuery={modelsQuery}
              channelsQuery={channelsQuery}
              freeLabel={providerFreeLabel(provider)}
              confirmRemove={confirmRemoveId === provider.id}
              onAskRemove={() => setConfirmRemoveId(provider.id)}
              onCancelRemove={() => setConfirmRemoveId(null)}
              onConfirmRemove={() => {
                onRemove(provider.id);
                setConfirmRemoveId(null);
              }}
              removing={removing}
              rotating={rotating}
              rotateOpen={rotateId === provider.id}
              rotateKey={rotateKey}
              onRotateOpen={() => {
                setRotateId(provider.id);
                setRotateKey("");
              }}
              onRotateKeyChange={setRotateKey}
              onRotateSubmit={() => submitRotate(provider.id)}
              onRotateCancel={() => setRotateId(null)}
              onToggleModel={onToggleModel}
              savingModels={savingModels}
              t={t}
            />
          ))
        )}
      </section>

      {/* 2.5 LiteLLM Model Groups & Channels */}
      <section className="space-y-3" data-testid="myrmidon-litellm-channels-section">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold" data-testid="myrmidon-litellm-channels-title">
            {t("modelProviders.litellmChannels.title") || "LiteLLM Model Groups & Channels"}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t("modelProviders.litellmChannels.description") ||
              "Model groups and routed provider channels configured in LiteLLM."}
          </p>
        </div>

        {channelsLoading ? (
          <p className="text-xs text-muted-foreground" data-testid="myrmidon-litellm-channels-loading">
            {t("modelProviders.litellmChannels.loading") || "Loading model groups and channels..."}
          </p>
        ) : channelsError ? (
          <p className="text-xs text-destructive" data-testid="myrmidon-litellm-channels-error">
            {channelsError}
          </p>
        ) : !channelsData?.channels || channelsData.channels.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="myrmidon-litellm-channels-empty">
            {t("modelProviders.litellmChannels.empty") || "No LiteLLM model groups or channels found."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-xs" data-testid="myrmidon-litellm-channels-table">
              <thead className="border-b border-border bg-muted/40 font-medium text-muted-foreground">
                <tr>
                  <th className="p-2">{t("modelProviders.litellmChannels.group") || "Group"}</th>
                  <th className="p-2">{t("modelProviders.litellmChannels.provider") || "Provider"}</th>
                  <th className="p-2">{t("modelProviders.litellmChannels.providerModel") || "Provider Model"}</th>
                  <th className="p-2 text-right">{t("modelProviders.litellmChannels.order") || "Order"}</th>
                  <th className="p-2 text-right">{t("modelProviders.litellmChannels.weight") || "Weight"}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {channelsData.channels.map((channel, idx) => {
                  const keyId = channel.id || `${channel.group}-${channel.providerModel}-${idx}`;
                  const rowId = channel.id || idx;
                  return (
                    <tr key={keyId} data-testid={`myrmidon-litellm-channel-row-${rowId}`}>
                      <td className="p-2 font-mono" data-testid={`myrmidon-litellm-channel-group-${rowId}`}>
                        {channel.group}
                      </td>
                      <td className="p-2 font-mono" data-testid={`myrmidon-litellm-channel-provider-${rowId}`}>
                        {channel.provider}
                      </td>
                      <td className="p-2 font-mono" data-testid={`myrmidon-litellm-channel-provider-model-${rowId}`}>
                        {channel.providerModel}
                      </td>
                      <td className="p-2 text-right font-mono" data-testid={`myrmidon-litellm-channel-order-${rowId}`}>
                        {channel.order !== null && channel.order !== undefined ? channel.order : "—"}
                      </td>
                      <td className="p-2 text-right font-mono" data-testid={`myrmidon-litellm-channel-weight-${rowId}`}>
                        {channel.weight !== null && channel.weight !== undefined ? channel.weight : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 3. Hindsight Memory Models (write, summarize, search) */}
      <HindsightModelGroupsPanel companyId={companyId} />

      {/* 4. Change log */}
      <section className="space-y-2" data-testid="myrmidon-model-providers-changelog">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("modelProviders.changeLog.title")}</h2>
          <span className="text-xs text-muted-foreground">{t("modelProviders.changeLog.secretsRedacted")}</span>
        </div>
        {rollbackError && (
          <p className="text-xs text-destructive" data-testid="myrmidon-model-providers-rollback-error">
            {rollbackError}
          </p>
        )}
        {view.changeLog.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="myrmidon-model-providers-changelog-empty">
            {t("modelProviders.changeLog.empty")}
          </p>
        ) : (
          <ol className="space-y-2">
            {view.changeLog.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-1 border-b border-border pb-2 last:border-b-0 text-sm"
                data-testid="myrmidon-model-providers-changelog-entry"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-medium">{entry.action}</span>
                    {entry.category && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {entry.category.toUpperCase()}
                      </span>
                    )}
                  </div>
                  {entry.canRollback && onRollback && (
                    <div>
                      {confirmRollbackId === entry.id ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">
                            {t("modelProviders.changeLog.rollbackConfirm")}
                          </span>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-7 text-xs"
                            disabled={rollingBack}
                            onClick={() => {
                              onRollback(entry.id);
                              setConfirmRollbackId(null);
                            }}
                            data-testid="myrmidon-model-providers-changelog-rollback-confirm"
                          >
                            {rollingBack ? t("modelProviders.changeLog.rollingBack") : t("modelProviders.changeLog.rollback")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() => setConfirmRollbackId(null)}
                          >
                            {t("common.cancel")}
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => setConfirmRollbackId(entry.id)}
                          data-testid="myrmidon-model-providers-changelog-rollback"
                        >
                          {t("modelProviders.changeLog.rollback")}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{formatTime(entry.at)}</span>
                  <span>·</span>
                  <span>
                    {t("modelProviders.changeLog.actor")}: {entry.actor?.name || actorLabel(entry.actor?.type)}{!entry.actor?.name && entry.actor?.id ? ` · ${entry.actor.id}` : ""}
                  </span>
                  <span>·</span>
                  <span>{entry.summary}</span>
                </div>
                {(entry.before || entry.after) && (
                  <div className="mt-1">
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground underline hover:text-foreground"
                      onClick={() => setExpandedDiffId((curr) => (curr === entry.id ? null : entry.id))}
                    >
                      {expandedDiffId === entry.id
                        ? t("modelProviders.changeLog.hideDiff")
                        : t("modelProviders.changeLog.showDiff")}
                    </button>
                    {expandedDiffId === entry.id && (
                      <div className="mt-1 grid grid-cols-2 gap-2 rounded bg-muted/40 p-2 text-xs font-mono">
                        <div>
                          <div className="text-[10px] font-semibold uppercase text-muted-foreground">
                            {t("modelProviders.changeLog.before")}
                          </div>
                          <pre className="max-h-32 overflow-auto whitespace-pre-wrap">
                            {entry.before ? JSON.stringify(entry.before, null, 2) : "null"}
                          </pre>
                        </div>
                        <div>
                          <div className="text-[10px] font-semibold uppercase text-muted-foreground">
                            {t("modelProviders.changeLog.after")}
                          </div>
                          <pre className="max-h-32 overflow-auto whitespace-pre-wrap">
                            {entry.after ? JSON.stringify(entry.after, null, 2) : "null"}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function ProviderCard({
  provider,
  companyId,
  modelsQuery,
  channelsQuery,
  freeLabel,
  confirmRemove,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
  removing,
  rotating,
  rotateOpen,
  rotateKey,
  onRotateOpen,
  onRotateKeyChange,
  onRotateSubmit,
  onRotateCancel,
  onToggleModel,
  savingModels,
  t,
}: {
  provider: ModelProviderView;
  companyId: string;
  modelsQuery: (providerId: string) => readonly unknown[];
  channelsQuery?: (providerId: string) => readonly unknown[];
  freeLabel: string;
  confirmRemove: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
  removing: boolean;
  rotating: boolean;
  rotateOpen: boolean;
  rotateKey: string;
  onRotateOpen: () => void;
  onRotateKeyChange: (value: string) => void;
  onRotateSubmit: () => void;
  onRotateCancel: () => void;
  onToggleModel: (
    providerId: string,
    models: Array<{ modelName: string; litellmModelName: string; enabled: boolean; free: boolean }>,
  ) => void;
  savingModels: boolean;
  // myrmidon(OPE-12361): the fork catalog resolves interpolation params, so the
  // prop must accept i18next options instead of a key-only translate.
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const modelsQueryResult = useQuery({
    queryKey: modelsQuery(provider.id),
    queryFn: () => modelProvidersApi.models(companyId, provider.id),
    staleTime: 60_000,
  });
  const models = sortModels(modelsQueryResult.data?.models ?? []);

  const channelsQueryResult = useQuery({
    queryKey: channelsQuery ? channelsQuery(provider.id) : ["channels", provider.id],
    queryFn: () => modelProvidersApi.channels(companyId, provider.id),
    enabled:
      provider.type === "chatgpt-pool" ||
      provider.type === "antigravity-pool" ||
      provider.type === "google-ai-pool",
    staleTime: 30_000,
  });

  const [oauthSession, setOauthSession] = useState<PoolAccountOAuthBeginResult | null>(null);
  const [oauthStarting, setOauthStarting] = useState(false);
  const [oauthCompleting, setOauthCompleting] = useState(false);
  const [oauthRefreshingN, setOauthRefreshingN] = useState<number | null>(null);

  const handleOAuthBegin = async () => {
    setOauthStarting(true);
    try {
      const res = await modelProvidersApi.oauthBegin(companyId, provider.id);
      setOauthSession(res);
    } catch {
      // ignore
    } finally {
      setOauthStarting(false);
    }
  };

  const handleOAuthComplete = async () => {
    if (!oauthSession) return;
    setOauthCompleting(true);
    try {
      await modelProvidersApi.oauthComplete(companyId, provider.id, {
        accountNumber: oauthSession.accountNumber,
      });
      setOauthSession(null);
      channelsQueryResult.refetch();
    } catch {
      // ignore
    } finally {
      setOauthCompleting(false);
    }
  };

  const handleOAuthRefresh = async (accountNumber: number) => {
    setOauthRefreshingN(accountNumber);
    try {
      await modelProvidersApi.oauthRefresh(companyId, provider.id, { accountNumber });
      channelsQueryResult.refetch();
    } catch {
      // ignore
    } finally {
      setOauthRefreshingN(null);
    }
  };

  const toggle = (modelName: string) => {
    const next = models.map((model) =>
      model.modelName === modelName ? { ...model, enabled: !model.enabled } : model,
    );
    onToggleModel(provider.id, next);
  };

  const queryClient = useQueryClient();
  const [isAddAccountOpen, setIsAddAccountOpen] = useState(false);
  const [accountPlan, setAccountPlan] = useState<"plus" | "pro" | "k12">("plus");
  const [accountLabel, setAccountLabel] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [oauthState, setOauthState] = useState<{
    authUrl?: string;
    userCode?: string;
    verificationUri?: string;
    state?: string;
  } | null>(null);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [deletingAccountNumber, setDeletingAccountNumber] = useState<number | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const handleStartOAuth = async () => {
    setIsAuthorizing(true);
    setOauthError(null);
    try {
      const res = await modelProvidersApi.startOAuth(companyId, provider.id, {
        plan: accountPlan,
        label: accountLabel || `Codex-${accountPlan.toUpperCase()}`,
      });
      setOauthState(res);
    } catch (err) {
      setOauthError(readable(err));
    } finally {
      setIsAuthorizing(false);
    }
  };

  const handleCompleteOAuth = async () => {
    if (!oauthState?.state) return;
    setIsAuthorizing(true);
    setOauthError(null);
    try {
      await modelProvidersApi.completeOAuth(companyId, provider.id, {
        state: oauthState.state,
        plan: accountPlan,
        label: accountLabel || `Codex-${accountPlan.toUpperCase()}`,
        email: accountEmail || undefined,
      });
      queryClient.invalidateQueries({
        queryKey: channelsQuery ? channelsQuery(provider.id) : ["channels", provider.id],
      });
      setIsAddAccountOpen(false);
      setOauthState(null);
      setAccountLabel("");
      setAccountEmail("");
    } catch (err) {
      setOauthError(readable(err));
    } finally {
      setIsAuthorizing(false);
    }
  };

  const handleDeleteAccount = async (accountNumber: number) => {
    setDeletingAccountNumber(accountNumber);
    try {
      await modelProvidersApi.deleteAccount(companyId, provider.id, accountNumber);
      queryClient.invalidateQueries({
        queryKey: channelsQuery ? channelsQuery(provider.id) : ["channels", provider.id],
      });
    } catch (err) {
      // silent
    } finally {
      setDeletingAccountNumber(null);
    }
  };

  return (
    <div
      className="space-y-3 rounded-lg border border-border p-4"
      data-testid={`myrmidon-model-provider-card-${provider.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium" data-testid="myrmidon-model-provider-name">
            {provider.name}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {provider.type}
            {provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded-md border border-border px-1.5 py-0.5 text-xs"
            data-testid={`myrmidon-model-provider-tier-${provider.id}`}
          >
            {freeLabel}
          </span>
          <span
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
            data-testid={`myrmidon-model-provider-haskey-${provider.id}`}
          >
            <KeyRound className="h-3 w-3" aria-hidden="true" />
            {provider.hasKey ? t("modelProviders.list.keyStored") : t("modelProviders.list.keyMissing")}
          </span>
        </div>
      </div>

      {/* Pool providers: per-account quota windows */}
      {(provider.type === "chatgpt-pool" || provider.type === "antigravity-pool" || provider.type === "google-ai-pool") && (
        <div className="space-y-3" data-testid={`myrmidon-model-provider-channels-${provider.id}`}>
          {/* Active Role Signals Alert Banner */}
          {channelsQueryResult.data?.signals && channelsQueryResult.data.signals.length > 0 && (
            <div
              className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3"
              data-testid={`myrmidon-pool-signals-${provider.id}`}
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-destructive">
                <AlertTriangle className="h-4 w-4" />
                <span>{t("modelProviders.channels.signalsTitle") || "Role Attention Signals"}</span>
              </div>
              <div className="space-y-1">
                {channelsQueryResult.data.signals.map((sig) => {
                  // myrmidon(OPE-12361): server signals carry English copy; render
                  // them through locale keys keyed by signal kind instead.
                  const title = t(`modelProviders.signals.${sig.kind}Title`, {
                    n: sig.accountNumber,
                    label: sig.label,
                  });
                  const why = t(`modelProviders.signals.${sig.kind}Why`, {
                    n: sig.accountNumber,
                    label: sig.label,
                  });
                  return (
                    <div
                      key={sig.dedupKey}
                      className="text-xs text-destructive/90"
                      data-testid={`myrmidon-pool-signal-${sig.accountNumber}`}
                    >
                      <span className="font-semibold">{title}: </span>
                      <span>{why}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Accounts & Limit Windows Table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">
                {t("modelProviders.channels.title") || "Pool Accounts & Limit Windows"}
              </span>
              <div className="flex items-center gap-2">
                {/* myrmidon(OPE-12361): Codex OAuth device login only exists on the
                    ChatGPT pool connector; other pools have no OAuth flow. */}
                {provider.type === "chatgpt-pool" && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid={`myrmidon-pool-oauth-begin-btn-${provider.id}`}
                      onClick={handleOAuthBegin}
                      disabled={oauthStarting}
                      className="text-xs h-7 px-2"
                    >
                      {oauthStarting
                        ? t("modelProviders.channels.oauthStarting")
                        : t("modelProviders.channels.oauthLogin")}
                    </Button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsAddAccountOpen(true);
                        setOauthState(null);
                        setOauthError(null);
                      }}
                      className="rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/20"
                      data-testid={`myrmidon-pool-add-account-btn-${provider.id}`}
                    >
                      + {t("modelProviders.channels.addAccount") || "Подключить аккаунт Codex (OAuth)"}
                    </button>
                  </>
                )}
                {channelsQueryResult.isFetching && (
                  <span className="text-xs text-muted-foreground">
                    {t("modelProviders.channels.refreshing") || "Updating..."}
                  </span>
                )}
              </div>
            </div>

            {oauthSession && (
              <div
                className="space-y-2 rounded-md border border-sky-500/40 bg-sky-500/10 p-3"
                data-testid={`myrmidon-pool-oauth-card-${provider.id}`}
              >
                <div className="flex items-center justify-between text-xs font-semibold text-sky-600 dark:text-sky-400">
                  <span>{t("modelProviders.channels.oauthCardTitle", { accountNumber: oauthSession.accountNumber })}</span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setOauthSession(null)}
                  >
                    ✕
                  </button>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 text-xs">
                  <div>
                    <span className="text-muted-foreground mr-1">{t("modelProviders.channels.oauthCode")}:</span>
                    <span
                      className="font-mono font-bold px-2 py-0.5 rounded bg-muted border border-border text-foreground"
                      data-testid={`myrmidon-pool-oauth-code-${provider.id}`}
                    >
                      {oauthSession.userCode}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground mr-1">{t("modelProviders.channels.oauthUrl")}:</span>
                    <a
                      href={oauthSession.verificationUri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-sky-600 underline"
                      data-testid={`myrmidon-pool-oauth-uri-${provider.id}`}
                    >
                      {oauthSession.verificationUri}
                    </a>
                  </div>
                </div>
                <div className="pt-1">
                  <Button
                    size="sm"
                    data-testid={`myrmidon-pool-oauth-complete-btn-${provider.id}`}
                    onClick={handleOAuthComplete}
                    disabled={oauthCompleting}
                    className="text-xs h-7 px-2"
                  >
                    {oauthCompleting ? t("modelProviders.channels.oauthCompleting") : t("modelProviders.channels.oauthComplete")}
                  </Button>
                </div>
              </div>
            )}

            {isAddAccountOpen && (
              <div
                className="rounded-md border border-primary/30 bg-muted/30 p-3 space-y-3"
                data-testid={`myrmidon-pool-add-account-dialog-${provider.id}`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">
                    {t("modelProviders.channels.connectCodexOAuth") || "Подключение аккаунта Codex по OAuth"}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddAccountOpen(false);
                      setOauthState(null);
                    }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground">
                      {t("modelProviders.channels.plan") || "Тип аккаунта"}
                    </label>
                    <select
                      value={accountPlan}
                      onChange={(e) => setAccountPlan(e.target.value as "plus" | "pro" | "k12")}
                      className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
                      data-testid="myrmidon-pool-plan-select"
                    >
                      <option value="plus">Plus (5h / 7d windows)</option>
                      <option value="pro">Pro (5h / 7d windows)</option>
                      <option value="k12">K-12 (5h / 7d windows)</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground">
                      {t("modelProviders.channels.accountLabel") || "Метка (Label)"}
                    </label>
                    <Input
                      value={accountLabel}
                      onChange={(e) => setAccountLabel(e.target.value)}
                      placeholder="codex-work-1"
                      className="mt-1 h-7 text-xs"
                      data-testid="myrmidon-pool-label-input"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground">
                      {t("modelProviders.channels.accountEmail") || "Email (опционально)"}
                    </label>
                    <Input
                      value={accountEmail}
                      onChange={(e) => setAccountEmail(e.target.value)}
                      placeholder="user@example.com"
                      className="mt-1 h-7 text-xs"
                      data-testid="myrmidon-pool-email-input"
                    />
                  </div>
                </div>

                {oauthError && (
                  <p className="text-xs text-destructive">{oauthError}</p>
                )}

                {!oauthState ? (
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setIsAddAccountOpen(false)}
                      className="h-7 text-xs"
                    >
                      Отмена
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleStartOAuth}
                      disabled={isAuthorizing}
                      className="h-7 text-xs"
                      data-testid="myrmidon-pool-start-oauth-btn"
                    >
                      {isAuthorizing ? "Запуск..." : "Авторизовать через OAuth"}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2 rounded border border-border bg-background p-2 text-xs">
                    <p className="font-medium text-foreground">
                      Авторизация запущена!
                    </p>
                    {oauthState.userCode && (
                      <p className="text-muted-foreground">
                        Код подтверждения: <span className="font-mono font-bold text-foreground">{oauthState.userCode}</span>
                      </p>
                    )}
                    {oauthState.authUrl && (
                      <p className="text-muted-foreground">
                        URL:{" "}
                        <a
                          href={oauthState.authUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline"
                        >
                          Перейти к авторизации OpenAI
                        </a>
                      </p>
                    )}
                    <div className="flex justify-end gap-2 pt-1">
                      <Button
                        type="button"
                        size="sm"
                        onClick={handleCompleteOAuth}
                        disabled={isAuthorizing}
                        className="h-7 text-xs"
                        data-testid="myrmidon-pool-complete-oauth-btn"
                      >
                        {isAuthorizing ? "Сохранение..." : "Подтвердить подключение"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {channelsQueryResult.isLoading ? (
              <p className="text-xs text-muted-foreground">
                {t("modelProviders.channels.loading") || "Loading accounts..."}
              </p>
            ) : channelsQueryResult.isError ? (
              <p className="text-xs text-destructive">
                {t("modelProviders.channels.error") || "Failed to load pool accounts."}
              </p>
            ) : !channelsQueryResult.data?.channels || channelsQueryResult.data.channels.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("modelProviders.channels.empty") || "No accounts found in pool."}
              </p>
            ) : (
              <>
                {channelsQueryResult.data.summary && (
                  <div className="flex flex-wrap gap-2 text-xs" data-testid="myrmidon-pool-summary">
                    <span className="rounded border border-border px-2 py-1">
                      {t("modelProviders.channels.summaryLive", { live: channelsQueryResult.data.summary.live, total: channelsQueryResult.data.summary.total })}
                    </span>
                    <span className="rounded border border-border px-2 py-1">
                      {t("modelProviders.channels.summaryExhausted", { count: channelsQueryResult.data.summary.exhausted })}
                    </span>
                    {channelsQueryResult.data.summary.error > 0 && (
                      <span className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-destructive" data-testid="myrmidon-pool-summary-error">
                        {t("modelProviders.channels.summaryError", { count: channelsQueryResult.data.summary.error })}
                      </span>
                    )}
                    {channelsQueryResult.data.summary.disabled !== undefined && channelsQueryResult.data.summary.disabled > 0 && (
                      <span className="rounded border border-border px-2 py-1 text-muted-foreground" data-testid="myrmidon-pool-summary-disabled">
                        {t("modelProviders.channels.summaryDisabled", { count: channelsQueryResult.data.summary.disabled })}
                      </span>
                    )}
                    {(summaryNextResetEpoch(channelsQueryResult.data.summary) !== null ||
                      channelsQueryResult.data.summary.nextResetText) && (
                      <span className="rounded border border-border px-2 py-1 text-muted-foreground" data-testid="myrmidon-pool-summary-reset">
                        {channelsQueryResult.data.summary.nextResetText
                          ? t("modelProviders.channels.summaryNextReset", { at: channelsQueryResult.data.summary.nextResetText })
                          : t("modelProviders.channels.summaryNextReset", {
                              at: new Date((summaryNextResetEpoch(channelsQueryResult.data.summary) as number) * 1000).toLocaleString(),
                            })}
                      </span>
                    )}
                  </div>
                )}
                <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border bg-muted/40 font-medium text-muted-foreground">
                    <tr>
                      <th className="p-2">#</th>
                      <th className="p-2">{t("modelProviders.channels.account") || "Account"}</th>
                      <th className="p-2">{t("modelProviders.channels.plan") || "Plan"}</th>
                      <th className="p-2">{t("modelProviders.channels.state") || "State"}</th>
                      <th className="p-2">{t("modelProviders.channels.window5h") || "5h Limit Window"}</th>
                      <th className="p-2">{t("modelProviders.channels.window7d") || "7d Limit Window"}</th>
                      <th className="p-2">{t("modelProviders.channels.lastOk") || "Last OK"}</th>
                      <th className="p-2">{t("modelProviders.channels.lastError") || "Last error"}</th>
                      <th className="p-2">{t("modelProviders.channels.actions") || "Actions"}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {channelsQueryResult.data.channels.map((ch) => {
                      const pWin = ch.windows?.primary;
                      const sWin = ch.windows?.secondary;
                      const isBanned = ch.isBanned;
                      const isExhausted = ch.isExhausted;
                      const isDisabled = ch.isDisabled;

                      const stateBadgeClass = isBanned
                        ? "bg-destructive/15 text-destructive border-destructive/30"
                        : isExhausted
                          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
                          : isDisabled
                            ? "bg-muted text-muted-foreground border-border"
                            : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";

                      return (
                        <tr
                          key={ch.n}
                          data-testid={`myrmidon-pool-channel-${ch.n}`}
                          className={isDisabled ? "opacity-60 hover:bg-muted/20" : "hover:bg-muted/20"}
                        >
                          <td className="p-2 font-mono font-medium">{ch.n}</td>
                          <td className="p-2">
                            <div className="font-medium">
                              {/^Account #(\d+)$/.test(ch.label)
                                ? t("modelProviders.channels.accountFallback", { n: ch.label.match(/^Account #(\d+)$/)![1] })
                                : ch.label}
                            </div>
                            {ch.email && (
                              <div className="text-xs text-muted-foreground">{ch.email}</div>
                            )}
                            {ch.models && ch.models.length > 0 && (
                              <div className="text-xs text-muted-foreground/80 mt-0.5" data-testid={`myrmidon-pool-channel-models-${ch.n}`}>
                                {ch.models.join(", ")}
                              </div>
                            )}
                          </td>
                          <td className="p-2">
                            {ch.plan ? (
                              <span
                                data-testid={`myrmidon-pool-channel-plan-${ch.n}`}
                                className={`inline-block rounded border px-1.5 py-0.5 text-xs font-medium ${
                                  ch.plan.toLowerCase().includes("k-12") || ch.plan.toLowerCase().includes("k12")
                                    ? "border-muted-foreground/30 bg-muted text-muted-foreground"
                                    : ch.plan.toLowerCase() === "pro"
                                      ? "border-purple-500/30 bg-purple-500/15 text-purple-600 dark:text-purple-400"
                                      : "border-sky-500/30 bg-sky-500/15 text-sky-600 dark:text-sky-400"
                                }`}
                              >
                                {ch.plan.toUpperCase()}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="p-2">
                            <span
                              className={`inline-block rounded border px-1.5 py-0.5 text-xs font-medium ${stateBadgeClass}`}
                            >
                              {ch.stateRu || ch.state}
                            </span>
                            {ch.limitedUntil && (
                              <div className="mt-1 text-xs text-muted-foreground" data-testid={`myrmidon-pool-channel-reset-${ch.n}`}>
                                {t("modelProviders.channels.resetIn") || "Resets in"}{" "}
                                {new Date(ch.limitedUntil * 1000).toLocaleString()}
                              </div>
                            )}
                          </td>
                          <td className="p-2">
                            {pWin && pWin.usedPct !== null ? (
                              <div className="space-y-1">
                                <div className="flex justify-between text-xs">
                                  <span>{pWin.usedPct}%</span>
                                  {pWin.resetsAt && (
                                    <span className="text-muted-foreground">
                                      {new Date(pWin.resetsAt * 1000).toLocaleTimeString([], {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </span>
                                  )}
                                </div>
                                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                                  <div
                                    className={`h-full ${
                                      pWin.usedPct >= 100
                                        ? "bg-destructive"
                                        : pWin.usedPct >= 80
                                          ? "bg-amber-500"
                                          : "bg-primary"
                                    }`}
                                    style={{ width: `${Math.min(pWin.usedPct, 100)}%` }}
                                  />
                                </div>
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="p-2">
                            {sWin && sWin.usedPct !== null ? (
                              <div className="space-y-1">
                                <div className="flex justify-between text-xs">
                                  <span>{sWin.usedPct}%</span>
                                  {sWin.resetsAt && (
                                    <span className="text-muted-foreground">
                                      {new Date(sWin.resetsAt * 1000).toLocaleTimeString([], {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </span>
                                  )}
                                </div>
                                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                                  <div
                                    className={`h-full ${
                                      sWin.usedPct >= 100
                                        ? "bg-destructive"
                                        : sWin.usedPct >= 80
                                          ? "bg-amber-500"
                                          : "bg-primary"
                                    }`}
                                    style={{ width: `${Math.min(sWin.usedPct, 100)}%` }}
                                  />
                                </div>
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="p-2 text-muted-foreground">
                            {ch.lastOk
                              ? new Date(ch.lastOk * 1000).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })
                              : "—"}
                          </td>
                          <td className="p-2 text-muted-foreground" title={ch.error || undefined} data-testid={`myrmidon-pool-channel-error-${ch.n}`}>
                            {ch.error ? ch.error.slice(0, 120) : "—"}
                          </td>
                          <td className="p-2">
                            <div className="flex items-center gap-1.5">
                              <Button
                                variant="outline"
                                size="sm"
                                data-testid={`myrmidon-pool-oauth-refresh-${ch.n}`}
                                onClick={() => handleOAuthRefresh(ch.n)}
                                disabled={oauthRefreshingN === ch.n || isDisabled}
                                className="text-xs h-6 px-1.5"
                              >
                                {oauthRefreshingN === ch.n ? "..." : t("modelProviders.channels.oauthRefresh")}
                              </Button>
                              <button
                                type="button"
                                onClick={() => handleDeleteAccount(ch.n)}
                                disabled={deletingAccountNumber === ch.n}
                                className="rounded border border-destructive/30 px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
                                data-testid={`myrmidon-pool-channel-delete-${ch.n}`}
                              >
                                {deletingAccountNumber === ch.n ? "..." : (t("modelProviders.channels.delete") || "Удалить")}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Models */}
      <div className="space-y-2" data-testid={`myrmidon-model-provider-models-${provider.id}`}>
        {modelsQueryResult.isLoading ? (
          <p className="text-xs text-muted-foreground">{t("modelProviders.list.modelsLoading")}</p>
        ) : models.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("modelProviders.list.modelsEmpty")}</p>
        ) : (
          <ul className="space-y-1">
            {models.map((model) => (
              <li
                key={model.modelName}
                className="flex items-center justify-between gap-2 text-sm"
                data-testid={`myrmidon-model-row-${provider.id}-${model.modelName}`}
              >
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={model.enabled}
                    disabled={savingModels}
                    onChange={() => toggle(model.modelName)}
                    data-testid={`myrmidon-model-toggle-${provider.id}-${model.modelName}`}
                  />
                  <span className="font-mono text-xs">{model.modelName}</span>
                </label>
                <span
                  className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                  data-testid={`myrmidon-model-tier-${provider.id}-${model.modelName}`}
                >
                  {isPoolProvider(provider.type)
                    ? t("modelProviders.channels.subscription")
                    : model.free
                      ? t("modelProviders.free")
                      : t("modelProviders.paid")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Rotate + remove */}
      <div className="flex flex-wrap items-center gap-2">
        {rotateOpen ? (
          <div className="flex flex-wrap items-center gap-2" data-testid={`myrmidon-model-provider-rotate-${provider.id}`}>
            <Input
              type="password"
              autoComplete="new-password"
              value={rotateKey}
              onChange={(e) => onRotateKeyChange(e.target.value)}
              placeholder={t("modelProviders.rotate.placeholder")}
              className="w-64"
              data-testid={`myrmidon-model-provider-rotate-key-${provider.id}`}
            />
            <Button size="sm" onClick={onRotateSubmit} disabled={rotating || !rotateKey.trim()}>
              {rotating ? t("modelProviders.rotate.saving") : t("modelProviders.rotate.save")}
            </Button>
            <Button size="sm" variant="outline" onClick={onRotateCancel}>
              {t("modelProviders.rotate.cancel")}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={onRotateOpen} data-testid={`myrmidon-model-provider-rotate-open-${provider.id}`}>
            {t("modelProviders.rotate.open")}
          </Button>
        )}
        {confirmRemove ? (
          <div className="flex items-center gap-2" data-testid={`myrmidon-model-provider-confirm-${provider.id}`}>
            <Button size="sm" variant="destructive" onClick={onConfirmRemove} disabled={removing}>
              {removing ? t("modelProviders.remove.removing") : t("modelProviders.remove.confirm")}
            </Button>
            <Button size="sm" variant="outline" onClick={onCancelRemove}>
              {t("modelProviders.remove.cancel")}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={onAskRemove} data-testid={`myrmidon-model-provider-remove-open-${provider.id}`}>
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            {t("modelProviders.remove.open")}
          </Button>
        )}
      </div>
    </div>
  );
}

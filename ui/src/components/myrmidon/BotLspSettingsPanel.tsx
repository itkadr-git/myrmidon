// Bot language servers (myrmidon BOT-LSP-DEFAULTS): which roles write code and
// the language-server mode coding and non-coding bots run with, editable while
// the server runs. Saving writes the instance settings row; the profile
// compiler re-reads it on every reconcile tick and each bot whose mode changes
// gets the new config while it is paused — no server restart.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCode2 } from "lucide-react";
import {
  BOT_LSP_IDLE_TIMEOUT_MAX_SECONDS,
  BOT_LSP_IDLE_TIMEOUT_MIN_SECONDS,
  BOT_LSP_MODES,
  BOT_LSP_TSSERVER_MEMORY_MAX_MB,
  BOT_LSP_TSSERVER_MEMORY_MIN_MB,
  isBotLspMode,
  type BotLspMode,
  type BotLspSettings,
  type BotLspSettingsPatch,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { i18n, useTranslation } from "@/i18n";
import { botLspApi, botLspQueryKey, type BotLspView } from "./botLspApi";
import { BOT_LSP_MODE_HINTS, BOT_LSP_MODE_LABELS } from "./botLspModes";

/** The form as typed. Empty text / "" mode = unset (the default applies). */
export interface BotLspDraft {
  codingRoles: string;
  codingMode: BotLspMode | "";
  nonCodingMode: BotLspMode | "";
  idleTimeoutSeconds: string;
  tsserverMemoryMb: string;
  excludeRoots: string;
}

type DraftKey = keyof BotLspDraft;

export interface BotLspDraftParse {
  patch: BotLspSettingsPatch | null;
  errors: Partial<Record<DraftKey, string>>;
}

const ROLE_KEY = /^[a-zA-Z0-9-]{1,60}$/;

function splitList(text: string, separator: RegExp): string[] {
  const seen = new Set<string>();
  for (const part of text.split(separator)) {
    const trimmed = part.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

function parseBounded(raw: string, min: number, max: number): number | null | "invalid" {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) return "invalid";
  return value;
}

/**
 * Draft -> PATCH body. Every field is sent: an empty one as `null`, which the
 * server reads as "remove the stored value, use the default".
 */
export function parseBotLspDraft(draft: BotLspDraft): BotLspDraftParse {
  const errors: Partial<Record<DraftKey, string>> = {};

  const roles = splitList(draft.codingRoles, /[\s,]+/);
  const badRole = roles.find((role) => !ROLE_KEY.test(role));
  if (badRole) errors.codingRoles = i18n.t("area.settings-bots-host-1.bot-lsp-settings-panel.errBadRole", { role: badRole });

  const idle = parseBounded(draft.idleTimeoutSeconds, BOT_LSP_IDLE_TIMEOUT_MIN_SECONDS, BOT_LSP_IDLE_TIMEOUT_MAX_SECONDS);
  if (idle === "invalid") {
    errors.idleTimeoutSeconds = i18n.t("area.settings-bots-host-1.bot-lsp-settings-panel.errRange", { min: BOT_LSP_IDLE_TIMEOUT_MIN_SECONDS, max: BOT_LSP_IDLE_TIMEOUT_MAX_SECONDS });
  }
  const memory = parseBounded(draft.tsserverMemoryMb, BOT_LSP_TSSERVER_MEMORY_MIN_MB, BOT_LSP_TSSERVER_MEMORY_MAX_MB);
  if (memory === "invalid") {
    errors.tsserverMemoryMb = i18n.t("area.settings-bots-host-1.bot-lsp-settings-panel.errRange", { min: BOT_LSP_TSSERVER_MEMORY_MIN_MB, max: BOT_LSP_TSSERVER_MEMORY_MAX_MB });
  }
  const excludeRoots = splitList(draft.excludeRoots, /\n+/);

  if (Object.keys(errors).length > 0) return { patch: null, errors };
  return {
    patch: {
      codingRoles: draft.codingRoles.trim() ? roles : null,
      codingMode: isBotLspMode(draft.codingMode) ? draft.codingMode : null,
      nonCodingMode: isBotLspMode(draft.nonCodingMode) ? draft.nonCodingMode : null,
      idleTimeoutSeconds: idle === "invalid" ? null : idle,
      tsserverMemoryMb: memory === "invalid" ? null : memory,
      excludeRoots: excludeRoots.length > 0 ? excludeRoots : null,
    },
    errors,
  };
}

export function botLspDraftFrom(settings: BotLspSettings): BotLspDraft {
  return {
    codingRoles: settings.codingRoles ? settings.codingRoles.join(", ") : "",
    codingMode: settings.codingMode ?? "",
    nonCodingMode: settings.nonCodingMode ?? "",
    idleTimeoutSeconds: settings.idleTimeoutSeconds === undefined ? "" : String(settings.idleTimeoutSeconds),
    tsserverMemoryMb: settings.tsserverMemoryMb === undefined ? "" : String(settings.tsserverMemoryMb),
    excludeRoots: settings.excludeRoots ? settings.excludeRoots.join("\n") : "",
  };
}

const selectClass =
  "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";

function ModeSelect({
  id,
  value,
  defaultMode,
  onChange,
}: {
  id: string;
  value: BotLspMode | "";
  defaultMode: BotLspMode;
  onChange: (next: BotLspMode | "") => void;
}) {
  const { t } = useTranslation();
  return (
    <select
      id={id}
      className={selectClass}
      value={value}
      onChange={(event) => onChange(isBotLspMode(event.target.value) ? event.target.value : "")}
    >
      <option value="">{t("area.settings-bots-host-1.bot-lsp-settings-panel.defaultMode", { mode: BOT_LSP_MODE_LABELS[defaultMode] })}</option>
      {BOT_LSP_MODES.map((mode) => (
        <option key={mode} value={mode}>
          {BOT_LSP_MODE_LABELS[mode]}
        </option>
      ))}
    </select>
  );
}

export function BotLspSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: BotLspView | null | undefined;
  onSave: (patch: BotLspSettingsPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<BotLspDraft | null>(null);
  const current = draft ?? (view ? botLspDraftFrom(view.settings) : null);
  const { patch, errors } = current ? parseBotLspDraft(current) : { patch: null, errors: {} as BotLspDraftParse["errors"] };
  const set = (key: DraftKey, value: string) => {
    if (!view) return;
    setDraft({ ...(current ?? botLspDraftFrom(view.settings)), [key]: value });
  };

  return (
    <section className="space-y-4" data-testid="myrmidon-bot-lsp">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <FileCode2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-bots-host-1.bot-lsp-settings-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.settings-bots-host-1.bot-lsp-settings-panel.intro")}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view && current ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="bot-lsp-codingRoles">{t("area.settings-bots-host-1.bot-lsp-settings-panel.codingRolesLabel")}</Label>
            <Input
              id="bot-lsp-codingRoles"
              placeholder={view.effective.codingRoles.join(", ")}
              value={current.codingRoles}
              onChange={(event) => set("codingRoles", event.target.value)}
            />
            {errors.codingRoles ? (
              <div className="text-xs text-destructive" data-testid="bot-lsp-error-codingRoles">
                {errors.codingRoles}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t("area.settings-bots-host-1.bot-lsp-settings-panel.codingRolesHint")}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bot-lsp-codingMode">{t("area.settings-bots-host-1.bot-lsp-settings-panel.codingModeLabel")}</Label>
            <ModeSelect
              id="bot-lsp-codingMode"
              value={current.codingMode}
              defaultMode="limited"
              onChange={(next) => set("codingMode", next)}
            />
            <p className="text-xs text-muted-foreground">{BOT_LSP_MODE_HINTS[view.effective.codingMode]}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bot-lsp-nonCodingMode">{t("area.settings-bots-host-1.bot-lsp-settings-panel.nonCodingModeLabel")}</Label>
            <ModeSelect
              id="bot-lsp-nonCodingMode"
              value={current.nonCodingMode}
              defaultMode="off"
              onChange={(next) => set("nonCodingMode", next)}
            />
            <p className="text-xs text-muted-foreground">{BOT_LSP_MODE_HINTS[view.effective.nonCodingMode]}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bot-lsp-idleTimeoutSeconds">{t("area.settings-bots-host-1.bot-lsp-settings-panel.idleTimeoutLabel")}</Label>
            <Input
              id="bot-lsp-idleTimeoutSeconds"
              inputMode="numeric"
              placeholder={String(view.effective.idleTimeoutSeconds)}
              value={current.idleTimeoutSeconds}
              onChange={(event) => set("idleTimeoutSeconds", event.target.value)}
            />
            {errors.idleTimeoutSeconds ? (
              <div className="text-xs text-destructive" data-testid="bot-lsp-error-idleTimeoutSeconds">
                {errors.idleTimeoutSeconds}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">{t("area.settings-bots-host-1.bot-lsp-settings-panel.idleTimeoutHint")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bot-lsp-tsserverMemoryMb">{t("area.settings-bots-host-1.bot-lsp-settings-panel.memoryLabel")}</Label>
            <Input
              id="bot-lsp-tsserverMemoryMb"
              inputMode="numeric"
              placeholder={String(view.effective.tsserverMemoryMb)}
              value={current.tsserverMemoryMb}
              onChange={(event) => set("tsserverMemoryMb", event.target.value)}
            />
            {errors.tsserverMemoryMb ? (
              <div className="text-xs text-destructive" data-testid="bot-lsp-error-tsserverMemoryMb">
                {errors.tsserverMemoryMb}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">{t("area.settings-bots-host-1.bot-lsp-settings-panel.memoryHint")}</p>
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="bot-lsp-excludeRoots">{t("area.settings-bots-host-1.bot-lsp-settings-panel.excludeLabel")}</Label>
            <textarea
              id="bot-lsp-excludeRoots"
              className={`${selectClass} min-h-16 font-mono`}
              placeholder={t("area.settings-bots-host-1.bot-lsp-settings-panel.excludePlaceholder")}
              value={current.excludeRoots}
              onChange={(event) => set("excludeRoots", event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("area.settings-bots-host-1.bot-lsp-settings-panel.excludeHint")}
            </p>
          </div>
          <div className="space-y-1 md:col-span-2 text-xs text-muted-foreground" data-testid="bot-lsp-counts">
            {t("area.settings-bots-host-1.bot-lsp-settings-panel.counts", { limited: view.counts.limited, off: view.counts.off, full: view.counts.full })}
          </div>
          <div className="md:col-span-2">
            <Button
              type="button"
              size="sm"
              disabled={pending || patch === null}
              onClick={() => {
                if (patch) onSave(patch);
              }}
            >
              {pending ? t("area.settings-bots-host-1.bot-lsp-settings-panel.saving") : t("area.settings-bots-host-1.bot-lsp-settings-panel.save")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("area.settings-bots-host-1.bot-lsp-settings-panel.loading")}</p>
      )}
    </section>
  );
}

export function BotLspSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: botLspQueryKey,
    queryFn: () => botLspApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: botLspApi.update,
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : t("area.settings-bots-host-1.bot-lsp-settings-panel.saveFailed")),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: botLspQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : t("area.settings-bots-host-1.bot-lsp-settings-panel.loadFailed")}
      </div>
    );
  }

  return (
    <BotLspSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}

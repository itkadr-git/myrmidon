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
  if (badRole) errors.codingRoles = `"${badRole}" is not a caste key (latin letters, digits, hyphens)`;

  const idle = parseBounded(draft.idleTimeoutSeconds, BOT_LSP_IDLE_TIMEOUT_MIN_SECONDS, BOT_LSP_IDLE_TIMEOUT_MAX_SECONDS);
  if (idle === "invalid") {
    errors.idleTimeoutSeconds = `A whole number from ${BOT_LSP_IDLE_TIMEOUT_MIN_SECONDS} to ${BOT_LSP_IDLE_TIMEOUT_MAX_SECONDS}, or empty`;
  }
  const memory = parseBounded(draft.tsserverMemoryMb, BOT_LSP_TSSERVER_MEMORY_MIN_MB, BOT_LSP_TSSERVER_MEMORY_MAX_MB);
  if (memory === "invalid") {
    errors.tsserverMemoryMb = `A whole number from ${BOT_LSP_TSSERVER_MEMORY_MIN_MB} to ${BOT_LSP_TSSERVER_MEMORY_MAX_MB}, or empty`;
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
  return (
    <select
      id={id}
      className={selectClass}
      value={value}
      onChange={(event) => onChange(isBotLspMode(event.target.value) ? event.target.value : "")}
    >
      <option value="">Default ({BOT_LSP_MODE_LABELS[defaultMode]})</option>
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
          <h2 className="text-sm font-semibold">Bot language servers</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Language servers give a bot diagnostics after it edits code, at the cost of a TypeScript server (about 1 GB on a
          large repository) per worktree. Bots whose role writes code get the limited mode; every other bot runs none.
          An agent card can pin its own mode. Saving applies on each bot&apos;s next reconcile, while that bot is paused;
          the server is not restarted. Leave a field empty to keep the built-in default.
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
            <Label htmlFor="bot-lsp-codingRoles">Roles that write code</Label>
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
              Caste keys (the agent&apos;s role), separated by commas. Custom castes count too.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bot-lsp-codingMode">Mode for coding roles</Label>
            <ModeSelect
              id="bot-lsp-codingMode"
              value={current.codingMode}
              defaultMode="limited"
              onChange={(next) => set("codingMode", next)}
            />
            <p className="text-xs text-muted-foreground">{BOT_LSP_MODE_HINTS[view.effective.codingMode]}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bot-lsp-nonCodingMode">Mode for other roles</Label>
            <ModeSelect
              id="bot-lsp-nonCodingMode"
              value={current.nonCodingMode}
              defaultMode="off"
              onChange={(next) => set("nonCodingMode", next)}
            />
            <p className="text-xs text-muted-foreground">{BOT_LSP_MODE_HINTS[view.effective.nonCodingMode]}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bot-lsp-idleTimeoutSeconds">Idle timeout, seconds (limited mode)</Label>
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
            <p className="text-xs text-muted-foreground">An idle language server is stopped after this long.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bot-lsp-tsserverMemoryMb">TypeScript server memory cap, MB (limited mode)</Label>
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
            <p className="text-xs text-muted-foreground">Heap limit of each TypeScript server.</p>
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="bot-lsp-excludeRoots">Excluded workspace roots</Label>
            <textarea
              id="bot-lsp-excludeRoots"
              className={`${selectClass} min-h-16 font-mono`}
              placeholder="One glob per line"
              value={current.excludeRoots}
              onChange={(event) => set("excludeRoots", event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Workspaces where no language server runs at all, for bots whose servers do run (limited or full).
            </p>
          </div>
          <div className="space-y-1 md:col-span-2 text-xs text-muted-foreground" data-testid="bot-lsp-counts">
            Bots now: {view.counts.limited} limited, {view.counts.off} off, {view.counts.full} full.
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
              {pending ? "Saving..." : "Save language servers"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading language-server settings...</p>
      )}
    </section>
  );
}

export function BotLspSettingsPanel() {
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
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the language-server settings failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: botLspQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load the language-server settings."}
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

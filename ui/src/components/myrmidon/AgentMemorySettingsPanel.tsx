// Agent memory (myrmidon MEMORY-UI): the memory service behind the agent card
// Memory tab. Saving applies on the next request, without a restart. The API key
// is optional: a service without authentication needs none.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain } from "lucide-react";
import type { PatchAgentMemorySettings } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { i18n, useTranslation } from "@/i18n";
import { agentMemoryApi, agentMemoryQueryKey, type AgentMemorySettingsView } from "./agentMemoryApi";

interface Draft {
  enabled: boolean;
  apiUrl: string;
  keySecretName: string;
}

// Lazy: the language must be read at render time, not frozen at import.
const sourceLabel = (source: "setting" | "env" | "bot-env"): string => {
  switch (source) {
    case "setting":
      return i18n.t("area.settings-agent-card.agent-memory-settings-panel.sourceSetting");
    case "env":
      return i18n.t("area.settings-agent-card.agent-memory-settings-panel.sourceEnv");
    default:
      return i18n.t("area.settings-agent-card.agent-memory-settings-panel.sourceBotEnv");
  }
};

function toDraft(view: AgentMemorySettingsView): Draft {
  return {
    enabled: view.settings.enabled !== false,
    apiUrl: view.settings.apiUrl ?? "",
    keySecretName: view.settings.keySecretName ?? "",
  };
}

/** An empty field clears the value (the environment applies again); an address must be http(s). */
export function buildAgentMemoryPatch(draft: Draft): { patch: PatchAgentMemorySettings | null; urlError: string | null } {
  const apiUrl = draft.apiUrl.trim();
  if (apiUrl) {
    try {
      const parsed = new URL(apiUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
    } catch {
      return { patch: null, urlError: i18n.t("area.settings-agent-card.agent-memory-settings-panel.urlError") };
    }
  }
  return {
    patch: {
      // `true` is the default, so it is stored as "not set".
      enabled: draft.enabled ? null : false,
      apiUrl: apiUrl || null,
      keySecretName: draft.keySecretName.trim() || null,
    },
    urlError: null,
  };
}

export function AgentMemorySettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: AgentMemorySettingsView | null | undefined;
  onSave: (patch: PatchAgentMemorySettings) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const current = draft ?? (view ? toDraft(view) : null);
  const built = current ? buildAgentMemoryPatch(current) : { patch: null, urlError: null };

  return (
    <section className="space-y-4" data-testid="myrmidon-agent-memory">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-agent-card.agent-memory-settings-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.settings-agent-card.agent-memory-settings-panel.description")}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view && current ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="md:col-span-2 flex items-center gap-2">
            <input
              id="agent-memory-enabled"
              type="checkbox"
              checked={current.enabled}
              onChange={(event) => setDraft({ ...current, enabled: event.target.checked })}
            />
            <Label htmlFor="agent-memory-enabled">{t("area.settings-agent-card.agent-memory-settings-panel.enabledLabel")}</Label>
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-memory-url">{t("area.settings-agent-card.agent-memory-settings-panel.urlLabel")}</Label>
            <Input
              id="agent-memory-url"
              placeholder={t("area.settings-agent-card.agent-memory-settings-panel.urlPlaceholder")}
              value={current.apiUrl}
              onChange={(event) => setDraft({ ...current, apiUrl: event.target.value })}
            />
            {built.urlError ? (
              <div className="text-xs text-destructive" data-testid="agent-memory-error-url">
                {built.urlError}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t("area.settings-agent-card.agent-memory-settings-panel.urlHint")}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-memory-key">{t("area.settings-agent-card.agent-memory-settings-panel.keyLabel")}</Label>
            <Input
              id="agent-memory-key"
              placeholder={t("area.settings-agent-card.agent-memory-settings-panel.keyPlaceholder")}
              value={current.keySecretName}
              onChange={(event) => setDraft({ ...current, keySecretName: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              {t("area.settings-agent-card.agent-memory-settings-panel.keyHint")}
            </p>
          </div>
          <div className="md:col-span-2 text-xs text-muted-foreground" data-testid="agent-memory-effective">
            {view.effective.enabled && view.effective.apiUrl
              ? t(
                  view.effective.keySecretName
                    ? "area.settings-agent-card.agent-memory-settings-panel.inForceWithKey"
                    : "area.settings-agent-card.agent-memory-settings-panel.inForceNoKey",
                  {
                    source: view.effective.urlSource
                      ? sourceLabel(view.effective.urlSource)
                      : t("area.settings-agent-card.agent-memory-settings-panel.unknownSource"),
                  },
                )
              : t("area.settings-agent-card.agent-memory-settings-panel.inForceOff")}
          </div>
          <div className="md:col-span-2">
            <Button
              type="button"
              size="sm"
              disabled={pending || built.patch === null}
              onClick={() => {
                if (built.patch) onSave(built.patch);
              }}
            >
              {pending ? t("area.settings-agent-card.agent-memory-settings-panel.saving") : t("area.settings-agent-card.agent-memory-settings-panel.save")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("area.settings-agent-card.agent-memory-settings-panel.loading")}</p>
      )}
    </section>
  );
}

export function AgentMemorySettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: agentMemoryQueryKey,
    queryFn: () => agentMemoryApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: agentMemoryApi.update,
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : i18n.t("area.settings-agent-card.agent-memory-settings-panel.saveFailed")),
    onSuccess: async () => {
      setError(null);
      // Prefix key: also refreshes every agent card's Memory tab status.
      await queryClient.invalidateQueries({ queryKey: agentMemoryQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : i18n.t("area.settings-agent-card.agent-memory-settings-panel.loadFailed")}
      </div>
    );
  }

  return (
    <AgentMemorySettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}

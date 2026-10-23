// The owner-facing feed of agent discussion rooms (myrmidon 1.7
// AGENT-EXCHANGE-B): the two switches of the feed. Saving takes effect at the
// next read of the feed — no restart, no room in flight is touched. Every
// value shows its source (saved here / forced by the server environment /
// default).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListVideo } from "lucide-react";
import { useTranslation } from "@/i18n";
import type {
  AgentExchangeFeedSettings,
  AgentExchangeFeedSettingsPatch,
  ResolvedAgentExchangeFeedSettings,
} from "@myrmidon/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  agentExchangeFeedApi,
  agentExchangeFeedSettingsQueryKey,
  describeAgentExchangeFeedSource,
} from "./agentExchangeFeedApi";

const MIN_FEED_LIMIT = 5;
const MAX_FEED_LIMIT = 200;

export function AgentExchangeFeedSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: ResolvedAgentExchangeFeedSettings | null | undefined;
  onSave: (patch: AgentExchangeFeedSettingsPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AgentExchangeFeedSettings | null>(null);
  const current = draft ?? view?.settings ?? null;
  const dirty = draft !== null && view != null;

  const patch = (part: AgentExchangeFeedSettingsPatch) => {
    if (!current) return;
    setDraft({ ...current, ...part });
  };

  return (
    <section className="space-y-4" data-testid="myrmidon-agent-exchange-feed">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ListVideo className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-integrations.agent-exchange-feed-settings-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.settings-integrations.agent-exchange-feed-settings-panel.description")}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view && current ? (
        <div className="space-y-4">
          <label className="block space-y-1" data-testid="agent-exchange-feed-limit">
            <span className="text-sm font-medium">{t("area.settings-integrations.agent-exchange-feed-settings-panel.roomsPerPage")}</span>
            <Input
              type="number"
              className="max-w-[10rem]"
              value={current.feedLimit}
              min={MIN_FEED_LIMIT}
              max={MAX_FEED_LIMIT}
              onChange={(event) => {
                const next = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(next)) patch({ feedLimit: next });
              }}
            />
            <span className="block text-xs text-muted-foreground">
              {t("area.settings-integrations.agent-exchange-feed-settings-panel.limitHint", {
                min: MIN_FEED_LIMIT,
                max: MAX_FEED_LIMIT,
                source: describeAgentExchangeFeedSource(view.sources.feedLimit),
              })}
            </span>
          </label>

          <label className="flex items-center gap-3" data-testid="agent-exchange-feed-skill-candidate">
            <ToggleSwitch
              checked={current.skillCandidateEnabled}
              onCheckedChange={(checked) => patch({ skillCandidateEnabled: checked })}
              aria-label={t("area.settings-integrations.agent-exchange-feed-settings-panel.toSkillAria")}
            />
            <span className="text-sm">
              {t("area.settings-integrations.agent-exchange-feed-settings-panel.toSkillLabel")}
              <span className="block text-xs text-muted-foreground">
                {t("area.settings-integrations.agent-exchange-feed-settings-panel.toSkillHint", {
                  source: describeAgentExchangeFeedSource(view.sources.skillCandidateEnabled),
                })}
              </span>
            </span>
          </label>

          <div className="flex items-center gap-3">
            <Button
              size="sm"
              disabled={!dirty || pending}
              onClick={() => {
                if (!draft) return;
                onSave(draft);
                setDraft(null);
              }}
            >
              {pending ? t("area.settings-integrations.agent-exchange-feed-settings-panel.saving") : t("common.save")}
            </Button>
            {dirty ? <span className="text-xs text-muted-foreground">{t("area.settings-integrations.agent-exchange-feed-settings-panel.unsaved")}</span> : null}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("area.settings-integrations.agent-exchange-feed-settings-panel.loading")}</p>
      )}
    </section>
  );
}

export function AgentExchangeFeedSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: agentExchangeFeedSettingsQueryKey,
    queryFn: () => agentExchangeFeedApi.settings(),
  });
  const mutation = useMutation({
    mutationFn: (patch: AgentExchangeFeedSettingsPatch) => agentExchangeFeedApi.updateSettings(patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentExchangeFeedSettingsQueryKey });
    },
  });

  return (
    <AgentExchangeFeedSettingsPanelView
      view={query.data}
      pending={mutation.isPending}
      error={
        query.isError
          ? query.error instanceof Error
            ? query.error.message
            : t("area.settings-integrations.agent-exchange-feed-settings-panel.loadError")
          : mutation.isError
            ? mutation.error instanceof Error
              ? mutation.error.message
              : t("area.settings-integrations.agent-exchange-feed-settings-panel.saveError")
            : null
      }
      onSave={(patch) => mutation.mutate(patch)}
    />
  );
}
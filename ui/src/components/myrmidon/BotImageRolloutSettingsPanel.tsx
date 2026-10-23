// Release bot-image rollout settings (BOT-ROLLOUT): how the release's bot
// images roll onto the fleet — the busy-wait timeout of one deferred bot, the
// batch size and the soft pause after a busy bot. The values live in
// `instance_settings.general.myrmidonBotImageRollout`; each env variable stays
// the default AND the upper bound, so a value past the cap is clamped to it
// (the panel shows the effective value and where it came from). Saving applies
// without a restart: the rollout script reads the settings at deploy time.
// Changing the settings is for instance admins; the server refuses anyone else.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/i18n";
import { botImageRolloutApi, botImageRolloutQueryKey } from "./botImageRolloutApi";

/** Parse a seconds/count field; "" means "no override" (env/default applies). */
function parseField(raw: string, notWhole: (value: string) => string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) throw new Error(notWhole(trimmed));
  return value;
}

export function BotImageRolloutSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: view } = useQuery({ queryKey: botImageRolloutQueryKey, queryFn: botImageRolloutApi.get });
  const [timeoutDraft, setTimeoutDraft] = useState<string | null>(null);
  const [batchDraft, setBatchDraft] = useState<string | null>(null);
  const [pauseDraft, setPauseDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed the drafts once the stored values arrive (react-query v5 has no onSuccess).
  useEffect(() => {
    if (view && timeoutDraft === null) setTimeoutDraft(view.settings.botTimeoutSec === undefined ? "" : String(view.settings.botTimeoutSec));
  }, [view, timeoutDraft]);
  useEffect(() => {
    if (view && batchDraft === null) setBatchDraft(view.settings.batchSize === undefined ? "" : String(view.settings.batchSize));
  }, [view, batchDraft]);
  useEffect(() => {
    if (view && pauseDraft === null) setPauseDraft(view.settings.busySoftPauseSec === undefined ? "" : String(view.settings.busySoftPauseSec));
  }, [view, pauseDraft]);

  const save = useMutation({
    mutationFn: () => {
      return botImageRolloutApi.patch({
        botTimeoutSec: parseField(timeoutDraft ?? "", (value) => t("area.settings-bots-host-1.bot-image-rollout-settings-panel.notWholeSeconds", { value })),
        batchSize: parseField(batchDraft ?? "", (value) => t("area.settings-bots-host-1.bot-image-rollout-settings-panel.notWholeBots", { value })),
        busySoftPauseSec: parseField(pauseDraft ?? "", (value) => t("area.settings-bots-host-1.bot-image-rollout-settings-panel.notWholeSeconds", { value })),
      });
    },
    onSuccess: (saved) => {
      setError(null);
      setTimeoutDraft(saved.settings.botTimeoutSec === undefined ? "" : String(saved.settings.botTimeoutSec));
      setBatchDraft(saved.settings.batchSize === undefined ? "" : String(saved.settings.batchSize));
      setPauseDraft(saved.settings.busySoftPauseSec === undefined ? "" : String(saved.settings.busySoftPauseSec));
      queryClient.invalidateQueries({ queryKey: botImageRolloutQueryKey });
    },
    onError: (err) => setError(err instanceof Error ? err.message : t("area.settings-bots-host-1.bot-image-rollout-settings-panel.saveFailed")),
  });

  const unchanged =
    view !== undefined &&
    (timeoutDraft ?? "") === (view.settings.botTimeoutSec === undefined ? "" : String(view.settings.botTimeoutSec)) &&
    (batchDraft ?? "") === (view.settings.batchSize === undefined ? "" : String(view.settings.batchSize)) &&
    (pauseDraft ?? "") === (view.settings.busySoftPauseSec === undefined ? "" : String(view.settings.busySoftPauseSec));

  const resolved = view?.resolved;
  const sourceLabel = (source: "env" | "settings" | "default") =>
    source === "env" ? t("area.settings-bots-host-1.bot-image-rollout-settings-panel.sourceEnv") : source === "settings" ? t("area.settings-bots-host-1.bot-image-rollout-settings-panel.sourceSettings") : t("area.settings-bots-host-1.bot-image-rollout-settings-panel.sourceDefault");

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="bot-image-rollout-panel">
      <div className="flex items-center gap-2">
        <RefreshCw className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t("area.settings-bots-host-1.bot-image-rollout-settings-panel.title")}</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("area.settings-bots-host-1.bot-image-rollout-settings-panel.intro")}
      </p>
      <div className="space-y-2">
        <Label htmlFor="bot-rollout-timeout">{t("area.settings-bots-host-1.bot-image-rollout-settings-panel.timeoutLabel")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="bot-rollout-timeout"
            placeholder={resolved ? t("area.settings-bots-host-1.bot-image-rollout-settings-panel.effectivePlaceholder", { value: resolved.botTimeoutSec.value, source: sourceLabel(resolved.botTimeoutSec.source) }) : ""}
            value={timeoutDraft ?? ""}
            onChange={(event) => {
              setTimeoutDraft(event.target.value);
              setError(null);
            }}
            data-testid="bot-rollout-timeout-input"
          />
        </div>
        {resolved && (
          <p className="text-xs text-muted-foreground" data-testid="bot-rollout-timeout-effective">
            {t("area.settings-bots-host-1.bot-image-rollout-settings-panel.effectiveSeconds", { value: resolved.botTimeoutSec.value, source: sourceLabel(resolved.botTimeoutSec.source), cap: resolved.botTimeoutSec.envCap })}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-rollout-batch">{t("area.settings-bots-host-1.bot-image-rollout-settings-panel.batchLabel")}</Label>
        <Input
          id="bot-rollout-batch"
          placeholder={resolved ? t("area.settings-bots-host-1.bot-image-rollout-settings-panel.effectivePlaceholder", { value: resolved.batchSize.value, source: sourceLabel(resolved.batchSize.source) }) : ""}
          value={batchDraft ?? ""}
          onChange={(event) => {
            setBatchDraft(event.target.value);
            setError(null);
          }}
          data-testid="bot-rollout-batch-input"
        />
        {resolved && (
          <p className="text-xs text-muted-foreground" data-testid="bot-rollout-batch-effective">
            {t("area.settings-bots-host-1.bot-image-rollout-settings-panel.effectiveCount", { value: resolved.batchSize.value, source: sourceLabel(resolved.batchSize.source), cap: resolved.batchSize.envCap })}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-rollout-pause">{t("area.settings-bots-host-1.bot-image-rollout-settings-panel.pauseLabel")}</Label>
        <Input
          id="bot-rollout-pause"
          placeholder={resolved ? t("area.settings-bots-host-1.bot-image-rollout-settings-panel.effectivePlaceholder", { value: resolved.busySoftPauseSec.value, source: sourceLabel(resolved.busySoftPauseSec.source) }) : ""}
          value={pauseDraft ?? ""}
          onChange={(event) => {
            setPauseDraft(event.target.value);
            setError(null);
          }}
          data-testid="bot-rollout-pause-input"
        />
        {resolved && (
          <p className="text-xs text-muted-foreground" data-testid="bot-rollout-pause-effective">
            {t("area.settings-bots-host-1.bot-image-rollout-settings-panel.effectiveSeconds", { value: resolved.busySoftPauseSec.value, source: sourceLabel(resolved.busySoftPauseSec.source), cap: resolved.busySoftPauseSec.envCap })}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || timeoutDraft === null || unchanged}>
          {save.isPending ? t("area.settings-bots-host-1.bot-image-rollout-settings-panel.saving") : t("common.save")}
        </Button>
        {error && <p className="text-xs text-red-600">{error}</p>}
        {save.isSuccess && !error && <p className="text-xs text-green-600">{t("area.settings-bots-host-1.bot-image-rollout-settings-panel.saved")}</p>}
      </div>
    </section>
  );
}

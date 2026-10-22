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
import { botImageRolloutApi, botImageRolloutQueryKey } from "./botImageRolloutApi";

/** Parse a seconds/count field; "" means "no override" (env/default applies). */
function parseField(raw: string, label: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) throw new Error(`"${trimmed}" is not a whole number of ${label}`);
  return value;
}

export function BotImageRolloutSettingsPanel() {
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
        botTimeoutSec: parseField(timeoutDraft ?? "", "seconds"),
        batchSize: parseField(batchDraft ?? "", "bots"),
        busySoftPauseSec: parseField(pauseDraft ?? "", "seconds"),
      });
    },
    onSuccess: (saved) => {
      setError(null);
      setTimeoutDraft(saved.settings.botTimeoutSec === undefined ? "" : String(saved.settings.botTimeoutSec));
      setBatchDraft(saved.settings.batchSize === undefined ? "" : String(saved.settings.batchSize));
      setPauseDraft(saved.settings.busySoftPauseSec === undefined ? "" : String(saved.settings.busySoftPauseSec));
      queryClient.invalidateQueries({ queryKey: botImageRolloutQueryKey });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not save the rollout settings. Try again."),
  });

  const unchanged =
    view !== undefined &&
    (timeoutDraft ?? "") === (view.settings.botTimeoutSec === undefined ? "" : String(view.settings.botTimeoutSec)) &&
    (batchDraft ?? "") === (view.settings.batchSize === undefined ? "" : String(view.settings.batchSize)) &&
    (pauseDraft ?? "") === (view.settings.busySoftPauseSec === undefined ? "" : String(view.settings.busySoftPauseSec));

  const resolved = view?.resolved;
  const sourceLabel = (source: "env" | "settings" | "default") =>
    source === "env" ? "env" : source === "settings" ? "settings" : "default";

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="bot-image-rollout-panel">
      <div className="flex items-center gap-2">
        <RefreshCw className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Release bot-image rollout</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        How the release&apos;s bot images roll onto the fleet: a busy bot keeps its old image and is retried until the
        timeout, then the periodic sweep applies the release image when the bot frees up. An empty field means the
        environment variable&apos;s value (or the module default) applies; the env value is also the upper bound of each
        field.
      </p>
      <div className="space-y-2">
        <Label htmlFor="bot-rollout-timeout">Busy-bot wait timeout, s</Label>
        <div className="flex items-center gap-2">
          <Input
            id="bot-rollout-timeout"
            placeholder={resolved ? `Effective: ${resolved.botTimeoutSec.value} (${sourceLabel(resolved.botTimeoutSec.source)})` : ""}
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
            Effective: {resolved.botTimeoutSec.value}s ({sourceLabel(resolved.botTimeoutSec.source)}; cap{" "}
            {resolved.botTimeoutSec.envCap}s)
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-rollout-batch">Batch size (at most 5)</Label>
        <Input
          id="bot-rollout-batch"
          placeholder={resolved ? `Effective: ${resolved.batchSize.value} (${sourceLabel(resolved.batchSize.source)})` : ""}
          value={batchDraft ?? ""}
          onChange={(event) => {
            setBatchDraft(event.target.value);
            setError(null);
          }}
          data-testid="bot-rollout-batch-input"
        />
        {resolved && (
          <p className="text-xs text-muted-foreground" data-testid="bot-rollout-batch-effective">
            Effective: {resolved.batchSize.value} ({sourceLabel(resolved.batchSize.source)}; cap {resolved.batchSize.envCap})
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="bot-rollout-pause">Soft pause after a busy bot, s (0 = off)</Label>
        <Input
          id="bot-rollout-pause"
          placeholder={resolved ? `Effective: ${resolved.busySoftPauseSec.value} (${sourceLabel(resolved.busySoftPauseSec.source)})` : ""}
          value={pauseDraft ?? ""}
          onChange={(event) => {
            setPauseDraft(event.target.value);
            setError(null);
          }}
          data-testid="bot-rollout-pause-input"
        />
        {resolved && (
          <p className="text-xs text-muted-foreground" data-testid="bot-rollout-pause-effective">
            Effective: {resolved.busySoftPauseSec.value}s ({sourceLabel(resolved.busySoftPauseSec.source)}; cap{" "}
            {resolved.busySoftPauseSec.envCap}s)
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || timeoutDraft === null || unchanged}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {error && <p className="text-xs text-red-600">{error}</p>}
        {save.isSuccess && !error && <p className="text-xs text-green-600">Saved</p>}
      </div>
    </section>
  );
}

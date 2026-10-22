// Attention feed windows (SETTINGS-UI C-4): how far back the feed looks for an
// unresolved failed or timed-out run and how long it reuses the feed it built
// per company. Both are editable while the server runs — saving writes the
// instance settings row and the feed re-reads it on the next build, no restart.
//
// Visible strings run through the fork i18n catalog (myrmidon-locales/*.json),
// section `attentionFeed` — the RU-no-latin gate counts this panel as a core
// settings screen.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radar } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  attentionFeedApi,
  attentionFeedQueryKey,
  type AttentionFeedLimitSource,
  type AttentionFeedPatch,
} from "./attentionFeedApi";

type Translate = (key: string, options?: Record<string, unknown>) => string;

function sourceLabel(source: AttentionFeedLimitSource, t: Translate): string {
  return source === "settings"
    ? t("attentionFeed.sourceSettings")
    : t("attentionFeed.sourceDefault");
}

function integerError(raw: string, min: number, max: number, t: Translate): string | null {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return t("attentionFeed.integerError", { min, max });
  }
  return null;
}

export function AttentionFeedSettingsPanel() {
  const { t } = useTranslation() as { t: Translate };
  const queryClient = useQueryClient();
  const { data: view } = useQuery({
    queryKey: attentionFeedQueryKey,
    queryFn: attentionFeedApi.get,
  });

  const [horizonDraft, setHorizonDraft] = useState("");
  const [cacheTtlDraft, setCacheTtlDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!view) return;
    setHorizonDraft((current) => (current === "" ? String(view.settings.failedRunHorizonDays) : current));
    setCacheTtlDraft((current) => (current === "" ? String(view.settings.feedCacheTtlSeconds) : current));
  }, [view]);

  const save = useMutation({
    mutationFn: (patch: AttentionFeedPatch) => attentionFeedApi.update(patch),
    onSuccess: () => {
      setError(null);
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: attentionFeedQueryKey });
    },
    onError: () => {
      setSaved(false);
      setError(t("attentionFeed.saveError"));
    },
  });

  const bounds = view?.bounds;
  const horizonChanged = view ? horizonDraft !== String(view.settings.failedRunHorizonDays) : false;
  const cacheTtlChanged = view ? cacheTtlDraft !== String(view.settings.feedCacheTtlSeconds) : false;

  const submit = () => {
    if (!bounds || !view) return;
    const horizonIssue = integerError(
      horizonDraft,
      bounds.failedRunHorizonDays.min,
      bounds.failedRunHorizonDays.max,
      t,
    );
    if (horizonIssue) {
      setError(horizonIssue);
      return;
    }
    const cacheTtlIssue = integerError(
      cacheTtlDraft,
      bounds.feedCacheTtlSeconds.min,
      bounds.feedCacheTtlSeconds.max,
      t,
    );
    if (cacheTtlIssue) {
      setError(cacheTtlIssue);
      return;
    }
    const patch: AttentionFeedPatch = {};
    if (horizonChanged) patch.failedRunHorizonDays = Number(horizonDraft);
    if (cacheTtlChanged) patch.feedCacheTtlSeconds = Number(cacheTtlDraft);
    setSaved(false);
    save.mutate(patch);
  };

  const resetToDefaults = () => {
    if (!bounds) return;
    setError(null);
    setSaved(false);
    setHorizonDraft(String(bounds.failedRunHorizonDays.default));
    setCacheTtlDraft(String(bounds.feedCacheTtlSeconds.default));
    save.mutate({
      failedRunHorizonDays: bounds.failedRunHorizonDays.default,
      feedCacheTtlSeconds: bounds.feedCacheTtlSeconds.default,
    });
  };

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="attention-feed-panel">
      <div className="flex items-center gap-2">
        <Radar className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t("attentionFeed.title")}</h3>
      </div>
      <p className="text-sm text-muted-foreground" data-testid="attention-feed-hint">
        {t("attentionFeed.hint")}
      </p>

      <div className="space-y-2">
        <Label htmlFor="attention-feed-horizon">{t("attentionFeed.horizonLabel")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="attention-feed-horizon"
            data-testid="attention-feed-horizon-input"
            inputMode="numeric"
            className="w-24"
            value={horizonDraft}
            onChange={(event) => setHorizonDraft(event.target.value)}
          />
          {bounds && (
            <span className="text-xs text-muted-foreground" data-testid="attention-feed-horizon-bounds">
              {t("attentionFeed.bounds", {
                min: bounds.failedRunHorizonDays.min,
                max: bounds.failedRunHorizonDays.max,
                default: bounds.failedRunHorizonDays.default,
              })}
            </span>
          )}
          {view && (
            <span
              className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              data-testid="attention-feed-horizon-source"
            >
              {sourceLabel(view.sources.failedRunHorizonDays, t)}
            </span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="attention-feed-cache-ttl">{t("attentionFeed.cacheTtlLabel")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="attention-feed-cache-ttl"
            data-testid="attention-feed-cache-ttl-input"
            inputMode="numeric"
            className="w-24"
            value={cacheTtlDraft}
            onChange={(event) => setCacheTtlDraft(event.target.value)}
          />
          {bounds && (
            <span className="text-xs text-muted-foreground" data-testid="attention-feed-cache-ttl-bounds">
              {t("attentionFeed.boundsCacheTtl", {
                min: bounds.feedCacheTtlSeconds.min,
                max: bounds.feedCacheTtlSeconds.max,
                default: bounds.feedCacheTtlSeconds.default,
              })}
            </span>
          )}
          {view && (
            <span
              className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              data-testid="attention-feed-cache-ttl-source"
            >
              {sourceLabel(view.sources.feedCacheTtlSeconds, t)}
            </span>
          )}
        </div>
      </div>

      {error && (
        <p className="text-sm text-muted-foreground" data-testid="attention-feed-error">
          {error}
        </p>
      )}
      {saved && !error && (
        <p className="text-sm text-emerald-600" data-testid="attention-feed-saved">
          {t("attentionFeed.saved")}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          data-testid="attention-feed-save"
          disabled={!horizonChanged && !cacheTtlChanged}
          onClick={submit}
        >
          {t("attentionFeed.save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="attention-feed-reset"
          onClick={resetToDefaults}
        >
          {t("attentionFeed.reset")}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="attention-feed-settings-note">
        {t("attentionFeed.note")}
      </p>
    </section>
  );
}

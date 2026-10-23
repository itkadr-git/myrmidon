// Tool gateway policy cache (myrmidon DB-PERF-C-P4): the TTL field of the
// instance setting behind `GET/PATCH /api/myrmidon/tool-policy-cache`.
//
// The operator thinks in seconds; the setting is stored in milliseconds. The
// field accepts 0 (cache off: every gateway decision reads the policy tables
// fresh) up to the server maximum. A saved value applies to the next gateway
// call, no restart; a policy change made through the board is visible to the
// next decision whatever the TTL says.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database } from "lucide-react";
import type { PatchToolPolicyCacheSettings } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { i18n, useTranslation } from "@/i18n";
import { toolPolicyCacheApi, toolPolicyCacheQueryKey, type ToolPolicyCacheView } from "./toolPolicyCacheApi";

export interface ToolPolicyCacheDraftParse {
  patch: PatchToolPolicyCacheSettings | null;
  error: string | null;
}

/** Seconds typed by the operator -> the PATCH body (milliseconds), or the reason it is not valid. */
export function parseToolPolicyCacheDraft(raw: string, maxTtlMs: number): ToolPolicyCacheDraftParse {
  const trimmed = raw.trim();
  const seconds = trimmed === "" ? Number.NaN : Number(trimmed);
  const maxSeconds = Math.floor(maxTtlMs / 1000);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > maxSeconds) {
    return { patch: null, error: i18n.t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.wholeSecondsError", { max: maxSeconds }) };
  }
  return { patch: { ttlMs: seconds * 1000 }, error: null };
}

export function ToolPolicyCacheSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: ToolPolicyCacheView | null | undefined;
  onSave: (patch: PatchToolPolicyCacheSettings) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const effective = view?.effective;
  const shown = draft ?? (effective ? String(effective.ttlMs / 1000) : "");
  const parsed = effective ? parseToolPolicyCacheDraft(shown, effective.maxTtlMs) : null;
  const dirty = draft !== null;

  return (
    <section className="space-y-4" data-testid="myrmidon-tool-policy-cache">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.description")}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {effective ? (
        <div className="space-y-3">
          <div className="max-w-xs space-y-1">
            <Label htmlFor="tool-policy-cache-ttl">{t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.ttlLabel")}</Label>
            <Input
              id="tool-policy-cache-ttl"
              inputMode="numeric"
              value={shown}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="text-xs text-muted-foreground">
              <span data-testid="tool-policy-cache-current">
                {t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.now", {
                  value: effective.cacheEnabled ? t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.seconds", { value: effective.ttlMs / 1000 }) : t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.off"),
                })}
              </span>
              <span className="ml-2">{t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.default", { value: t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.seconds", { value: effective.defaultTtlMs / 1000 }) })}</span>
              {dirty && parsed?.error ? (
                <span data-testid="tool-policy-cache-error" className="ml-2 text-destructive">
                  {parsed.error}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground" data-testid="tool-policy-cache-counters">
              {t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.counters", {
                count: effective.cachedCompanies,
                hits: effective.hits,
                misses: effective.misses,
              })}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="tool-policy-cache-save"
              disabled={pending || !dirty || !parsed?.patch}
              onClick={() => {
                if (parsed?.patch) onSave(parsed.patch);
              }}
            >
              {pending ? t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.saving") : t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.save")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="tool-policy-cache-default"
              disabled={pending || view?.settings.ttlMs === undefined}
              onClick={() => onSave({ ttlMs: null })}
            >
              {t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.useDefault")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.loading")}</p>
      )}
    </section>
  );
}

export function ToolPolicyCacheSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: toolPolicyCacheQueryKey,
    queryFn: () => toolPolicyCacheApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: toolPolicyCacheApi.update,
    onMutate: () => setError(null),
    onError: (err) =>
      setError(err instanceof Error ? err.message : i18n.t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.saveFailed")),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: toolPolicyCacheQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error
          ? query.error.message
          : t("area.settings-models-runtime-2.tool-policy-cache-settings-panel.loadFailed")}
      </div>
    );
  }

  return (
    <ToolPolicyCacheSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}

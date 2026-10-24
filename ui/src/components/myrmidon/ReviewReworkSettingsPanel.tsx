// Review-rework loop settings (myrmidon 1.6.4, REVIEW-REWORK): the
// "Review-return loop (REVIEW-REWORK)" section of Instance → General. The
// master switch and the executor a rework task falls to when neither the
// review stage's return assignee nor the delivering task names one. The
// server re-reads the stored row on every sweep pass, so a change applies
// without a restart; the journal shows who changed what and when.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitPullRequestClosed } from "lucide-react";
import type { ReviewReworkSettingsPatch } from "@myrmidon/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { i18n, useTranslation } from "@/i18n";
import {
  reviewReworkSettingsApi,
  reviewReworkSettingsQueryKey,
  type ReviewReworkSettingsView,
} from "./reviewReworkSettingsApi";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse the draft fields. The fallback field is optional: empty or the word
 * "none" means "no fallback assignee" (null = the role queue claims the task).
 * Anything else must be an agent UUID.
 */
export function parseReviewReworkDraft(draft: {
  enabled: boolean;
  fallback: string;
}): { patch: ReviewReworkSettingsPatch; errors: Partial<Record<string, string>> } {
  const trimmed = draft.fallback.trim();
  if (trimmed && trimmed.toLowerCase() !== "none" && !UUID_PATTERN.test(trimmed)) {
    return {
      patch: { enabled: draft.enabled },
      errors: { fallback: i18n.t("area.settings-models-runtime-2.review-rework-settings-panel.fallbackError") },
    };
  }
  const fallbackAssigneeAgentId = trimmed && trimmed.toLowerCase() !== "none" ? trimmed : null;
  return {
    patch: { enabled: draft.enabled, fallbackAssigneeAgentId },
    errors: {},
  };
}

export function ReviewReworkSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: ReviewReworkSettingsView | null | undefined;
  onSave: (patch: ReviewReworkSettingsPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draftEnabled, setDraftEnabled] = useState<boolean | null>(null);
  const [draftFallback, setDraftFallback] = useState<string | null>(null);

  const enabled = draftEnabled ?? (view ? view.settings.enabled : true);
  const fallback =
    draftFallback ??
    (view?.settings.fallbackAssigneeAgentId ? view.settings.fallbackAssigneeAgentId : "");

  const { patch, errors } = parseReviewReworkDraft({ enabled, fallback });
  const canSave = view !== null && view !== undefined && Object.keys(errors).length === 0;

  return (
    <section className="space-y-4" data-testid="myrmidon-review-rework-settings">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <GitPullRequestClosed className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-models-runtime-2.review-rework-settings-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.settings-models-runtime-2.review-rework-settings-panel.description")}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="review-rework-enabled">{t("area.settings-models-runtime-2.review-rework-settings-panel.enabledLabel")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("area.settings-models-runtime-2.review-rework-settings-panel.enabledHint")}
                </p>
              </div>
              <ToggleSwitch
                id="review-rework-enabled"
                checked={enabled}
                onCheckedChange={setDraftEnabled}
                data-testid="review-rework-enabled-toggle"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="review-rework-fallback">{t("area.settings-models-runtime-2.review-rework-settings-panel.fallbackLabel")}</Label>
            <Input
              id="review-rework-fallback"
              placeholder={t("area.settings-models-runtime-2.review-rework-settings-panel.fallbackPlaceholder")}
              value={fallback}
              onChange={(event) => setDraftFallback(event.target.value)}
            />
            {errors.fallback ? (
              <div className="text-xs text-destructive" data-testid="review-rework-error-fallback">
                {errors.fallback}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t("area.settings-models-runtime-2.review-rework-settings-panel.fallbackHint")}
            </p>
          </div>

          <div className="md:col-span-2 flex justify-end">
            <Button
              disabled={!canSave || pending}
              onClick={() => onSave(patch)}
              data-testid="review-rework-save"
            >
              {pending ? t("area.settings-models-runtime-2.review-rework-settings-panel.saving") : t("common.save")}
            </Button>
          </div>

          {view.journal.length > 0 ? (
            <div className="md:col-span-2 space-y-1">
              <h3 className="text-xs font-semibold text-muted-foreground">{t("area.settings-models-runtime-2.review-rework-settings-panel.changes")}</h3>
              <ul className="space-y-1 text-xs text-muted-foreground" data-testid="review-rework-journal">
                {view.journal.slice(0, 10).map((entry) => (
                  <li key={`${entry.at}-${entry.actorId}`}>
                    {entry.at} — {entry.actorType} {entry.actorId}:{" "}
                    {Object.entries(entry.patch)
                      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
                      .join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function ReviewReworkSettingsPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: reviewReworkSettingsQueryKey,
    queryFn: () => reviewReworkSettingsApi.get(),
  });
  const mutation = useMutation({
    mutationFn: (patch: ReviewReworkSettingsPatch) => reviewReworkSettingsApi.update(patch),
    onSuccess: (view) => {
      queryClient.setQueryData(reviewReworkSettingsQueryKey, view);
    },
  });
  return (
    <ReviewReworkSettingsPanelView
      view={query.data ?? null}
      onSave={(patch) => mutation.mutate(patch)}
      pending={mutation.isPending}
      error={mutation.error ? String(mutation.error) : query.error ? String(query.error) : null}
    />
  );
}

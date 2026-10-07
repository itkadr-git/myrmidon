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
import type { ReviewReworkSettingsPatch } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
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
      errors: { fallback: "Enter an agent UUID, or leave it empty for the role queue" },
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
          <h2 className="text-sm font-semibold">Review-return loop (REVIEW-REWORK)</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          A review verdict that returns a pull request (RETURN) opens a rework task for the
          PR&apos;s author and blocks the review on it; a new head in the PR releases the review
          back to its reviewer, and a merged or closed PR settles the review. The switch and the
          fallback executor apply without a restart — the sweep re-reads them on every pass.
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
                <Label htmlFor="review-rework-enabled">Enable the loop</Label>
                <p className="text-xs text-muted-foreground">
                  Off leaves the board as it was: a RETURN verdict creates no task and the review
                  keeps waking on an unchanged PR.
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
            <Label htmlFor="review-rework-fallback">Fallback executor (agent UUID)</Label>
            <Input
              id="review-rework-fallback"
              placeholder="Empty = the role queue claims it"
              value={fallback}
              onChange={(event) => setDraftFallback(event.target.value)}
            />
            {errors.fallback ? (
              <div className="text-xs text-destructive" data-testid="review-rework-error-fallback">
                {errors.fallback}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              The rework first goes to the PR&apos;s author (the review&apos;s return assignee),
              then to the assignee of the task the PR delivers. This is the last rung; empty means
              nobody — an unassigned todo task, which the role queue of SWARM-CLAIM claims.
            </p>
          </div>

          <div className="md:col-span-2 flex justify-end">
            <Button
              disabled={!canSave || pending}
              onClick={() => onSave(patch)}
              data-testid="review-rework-save"
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>

          {view.journal.length > 0 ? (
            <div className="md:col-span-2 space-y-1">
              <h3 className="text-xs font-semibold text-muted-foreground">Changes</h3>
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

// myrmidon(REVIEW-ROUTING): the "Review routing" settings screen — view tier.
// Layout and local draft state only; the react-query wiring lives in
// ReviewRoutingScreenContainer.tsx so tests can drive both tiers separately.
import { useState } from "react";
import { GitPullRequest, UserCheck } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  PR_STEWARD_MAX_MERGES_MAX,
  PR_STEWARD_MAX_MERGES_MIN,
  PR_WATCH_MAX_NEW_ASSIGNMENTS_MAX,
  PR_WATCH_MAX_NEW_ASSIGNMENTS_MIN,
  PR_WATCH_MAX_OPEN_REVIEWS_MAX,
  PR_WATCH_MAX_OPEN_REVIEWS_MIN,
  PR_WATCH_POLL_INTERVAL_MAX,
  PR_WATCH_POLL_INTERVAL_MIN,
  REVIEW_ROUTING_MAX_LOAD_MAX,
  REVIEW_ROUTING_MAX_LOAD_MIN,
  REVIEW_ROUTING_REASSIGN_HOURS_MAX,
  draftFromSettings,
  parseBoundedInt,
  repositoriesValid,
  settingsFromDraft,
  supportsPrWatch,
  type ReviewRoutingDraft,
} from "./reviewRoutingConfig";
import type { ReviewRoutingSettings } from "./reviewRoutingApi";

export function ReviewRoutingScreenView({
  settings,
  onSave,
  pending,
  error,
}: {
  settings: ReviewRoutingSettings | null | undefined;
  onSave: (settings: ReviewRoutingSettings) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ReviewRoutingDraft | null>(null);

  const current: ReviewRoutingDraft | null = draft ?? (settings ? draftFromSettings(settings) : null);
  // The PR lane section is only editable against a server whose settings
  // already carry `prWatch` (part A of PR 705). Against an older server the block
  // is hidden and the PUT omits the key — `.strict()` would 400 it.
  const prWatchSupported = supportsPrWatch(settings);
  const maxLoadOk =
    current !== null &&
    parseBoundedInt(current.maxLoad, REVIEW_ROUTING_MAX_LOAD_MIN, REVIEW_ROUTING_MAX_LOAD_MAX).ok;
  const hoursOk =
    current !== null && parseBoundedInt(current.reassignHours, 0, REVIEW_ROUTING_REASSIGN_HOURS_MAX).ok;
  const repositoriesOk = !prWatchSupported || (current !== null && repositoriesValid(current.prRepositories));
  const maxOpenReviewsOk =
    !prWatchSupported ||
    (current !== null &&
      parseBoundedInt(current.prMaxOpenReviews, PR_WATCH_MAX_OPEN_REVIEWS_MIN, PR_WATCH_MAX_OPEN_REVIEWS_MAX).ok);
  const maxNewAssignmentsOk =
    !prWatchSupported ||
    (current !== null &&
      parseBoundedInt(
        current.prMaxNewAssignments,
        PR_WATCH_MAX_NEW_ASSIGNMENTS_MIN,
        PR_WATCH_MAX_NEW_ASSIGNMENTS_MAX,
      ).ok);
  const pollIntervalOk =
    !prWatchSupported ||
    (current !== null &&
      parseBoundedInt(current.prPollIntervalSec, PR_WATCH_POLL_INTERVAL_MIN, PR_WATCH_POLL_INTERVAL_MAX).ok);
  const stewardMaxMergesOk =
    !prWatchSupported ||
    (current !== null &&
      parseBoundedInt(current.stewardMaxMerges, PR_STEWARD_MAX_MERGES_MIN, PR_STEWARD_MAX_MERGES_MAX).ok);
  const allOk =
    maxLoadOk &&
    hoursOk &&
    repositoriesOk &&
    maxOpenReviewsOk &&
    maxNewAssignmentsOk &&
    pollIntervalOk &&
    stewardMaxMergesOk;

  const save = () => {
    if (!current) return;
    const next = settingsFromDraft(current, settings ?? null);
    if (next) onSave(next);
  };

  return (
    <section className="space-y-4" data-testid="myrmidon-review-routing">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <UserCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("reviewRouting.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("reviewRouting.intro")}</p>
      </div>

      {error ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          data-testid="myrmidon-review-routing-error"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      {current ? (
        <>
          <div className="flex items-center gap-2">
            <input
              id="review-routing-enabled"
              type="checkbox"
              checked={current.enabled}
              onChange={(event) => setDraft({ ...current, enabled: event.target.checked })}
            />
            <Label htmlFor="review-routing-enabled">{t("reviewRouting.enabledLabel")}</Label>
          </div>

          <div className="space-y-1">
            <Label htmlFor="review-routing-roles">{t("reviewRouting.rolesLabel")}</Label>
            <Input
              id="review-routing-roles"
              className="max-w-md"
              value={current.roles}
              onChange={(event) => setDraft({ ...current, roles: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t("reviewRouting.rolesHint")}</p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="review-routing-max-load">{t("reviewRouting.maxLoadLabel")}</Label>
            <Input
              id="review-routing-max-load"
              inputMode="numeric"
              className="max-w-xs"
              aria-invalid={maxLoadOk ? undefined : true}
              value={current.maxLoad}
              onChange={(event) => setDraft({ ...current, maxLoad: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t("reviewRouting.maxLoadHint")}</p>
            {!maxLoadOk ? (
              <p className="text-xs text-destructive" data-testid="review-routing-max-load-error">
                {t("reviewRouting.maxLoadInvalid")}
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="review-routing-hours">{t("reviewRouting.hoursLabel")}</Label>
            <Input
              id="review-routing-hours"
              inputMode="numeric"
              className="max-w-xs"
              aria-invalid={hoursOk ? undefined : true}
              value={current.reassignHours}
              onChange={(event) => setDraft({ ...current, reassignHours: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t("reviewRouting.hoursHint")}</p>
            {!hoursOk ? (
              <p className="text-xs text-destructive" data-testid="review-routing-hours-error">
                {t("reviewRouting.hoursInvalid")}
              </p>
            ) : null}
          </div>

          {prWatchSupported ? (
          <div className="space-y-4 rounded-md border border-border/60 p-3" data-testid="review-routing-pr-watch">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <GitPullRequest className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">{t("reviewRouting.prWatchTitle")}</h3>
              </div>
              <p className="max-w-2xl text-xs text-muted-foreground">{t("reviewRouting.prWatchIntro")}</p>
            </div>

            <div className="flex items-center gap-2">
              <input
                id="review-routing-pr-watch-enabled"
                type="checkbox"
                checked={current.prWatchEnabled}
                onChange={(event) => setDraft({ ...current, prWatchEnabled: event.target.checked })}
              />
              <Label htmlFor="review-routing-pr-watch-enabled">{t("reviewRouting.prWatchEnabledLabel")}</Label>
            </div>

            <div className="space-y-1">
              <Label htmlFor="review-routing-pr-repositories">{t("reviewRouting.prRepositoriesLabel")}</Label>
              <Textarea
                id="review-routing-pr-repositories"
                className="max-w-md"
                rows={3}
                aria-invalid={repositoriesOk ? undefined : true}
                value={current.prRepositories}
                onChange={(event) => setDraft({ ...current, prRepositories: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t("reviewRouting.prRepositoriesHint")}</p>
              {!repositoriesOk ? (
                <p className="text-xs text-destructive" data-testid="review-routing-pr-repositories-error">
                  {t("reviewRouting.prRepositoriesInvalid")}
                </p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label htmlFor="review-routing-pr-max-open">{t("reviewRouting.prMaxOpenLabel")}</Label>
              <Input
                id="review-routing-pr-max-open"
                inputMode="numeric"
                className="max-w-xs"
                aria-invalid={maxOpenReviewsOk ? undefined : true}
                value={current.prMaxOpenReviews}
                onChange={(event) => setDraft({ ...current, prMaxOpenReviews: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t("reviewRouting.prMaxOpenHint")}</p>
              {!maxOpenReviewsOk ? (
                <p className="text-xs text-destructive" data-testid="review-routing-pr-max-open-error">
                  {t("reviewRouting.prMaxOpenInvalid")}
                </p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label htmlFor="review-routing-pr-max-new">{t("reviewRouting.prMaxNewLabel")}</Label>
              <Input
                id="review-routing-pr-max-new"
                inputMode="numeric"
                className="max-w-xs"
                aria-invalid={maxNewAssignmentsOk ? undefined : true}
                value={current.prMaxNewAssignments}
                onChange={(event) => setDraft({ ...current, prMaxNewAssignments: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t("reviewRouting.prMaxNewHint")}</p>
              {!maxNewAssignmentsOk ? (
                <p className="text-xs text-destructive" data-testid="review-routing-pr-max-new-error">
                  {t("reviewRouting.prMaxNewInvalid")}
                </p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label htmlFor="review-routing-pr-poll-interval">{t("reviewRouting.prPollIntervalLabel")}</Label>
              <Input
                id="review-routing-pr-poll-interval"
                inputMode="numeric"
                className="max-w-xs"
                aria-invalid={pollIntervalOk ? undefined : true}
                value={current.prPollIntervalSec}
                onChange={(event) => setDraft({ ...current, prPollIntervalSec: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t("reviewRouting.prPollIntervalHint")}</p>
              {!pollIntervalOk ? (
                <p className="text-xs text-destructive" data-testid="review-routing-pr-poll-interval-error">
                  {t("reviewRouting.prPollIntervalInvalid")}
                </p>
              ) : null}
            </div>

            <div
              className="space-y-3 rounded-md border border-border/60 p-3"
              data-testid="review-routing-pr-steward"
            >
              <div className="space-y-1">
                <h4 className="text-sm font-semibold">{t("reviewRouting.stewardTitle")}</h4>
                <p className="max-w-2xl text-xs text-muted-foreground">{t("reviewRouting.stewardIntro")}</p>
              </div>

              <div className="flex items-center gap-2">
                <input
                  id="review-routing-steward-enabled"
                  type="checkbox"
                  checked={current.stewardEnabled}
                  onChange={(event) => setDraft({ ...current, stewardEnabled: event.target.checked })}
                />
                <Label htmlFor="review-routing-steward-enabled">{t("reviewRouting.stewardEnabledLabel")}</Label>
              </div>

              <fieldset
                className="space-y-3"
                disabled={!current.stewardEnabled}
                data-testid="review-routing-steward-fields"
              >
                <div className="space-y-1">
                  <Label htmlFor="review-routing-steward-roles">{t("reviewRouting.stewardRolesLabel")}</Label>
                  <Input
                    id="review-routing-steward-roles"
                    className="max-w-md"
                    value={current.stewardRoles}
                    onChange={(event) => setDraft({ ...current, stewardRoles: event.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">{t("reviewRouting.stewardRolesHint")}</p>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="review-routing-steward-max-merges">{t("reviewRouting.stewardMaxMergesLabel")}</Label>
                  <Input
                    id="review-routing-steward-max-merges"
                    inputMode="numeric"
                    className="max-w-xs"
                    aria-invalid={stewardMaxMergesOk ? undefined : true}
                    value={current.stewardMaxMerges}
                    onChange={(event) => setDraft({ ...current, stewardMaxMerges: event.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">{t("reviewRouting.stewardMaxMergesHint")}</p>
                  {!stewardMaxMergesOk ? (
                    <p className="text-xs text-destructive" data-testid="review-routing-steward-max-merges-error">
                      {t("reviewRouting.stewardMaxMergesInvalid")}
                    </p>
                  ) : null}
                </div>
              </fieldset>
            </div>
          </div>
          ) : null}

          <div>
            <Button type="button" size="sm" disabled={pending || !allOk} onClick={save}>
              {pending ? t("reviewRouting.saving") : t("reviewRouting.save")}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="myrmidon-review-routing-loading">
          {t("reviewRouting.loading")}
        </p>
      )}
    </section>
  );
}

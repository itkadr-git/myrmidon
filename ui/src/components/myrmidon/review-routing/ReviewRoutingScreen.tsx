// myrmidon(REVIEW-ROUTING): the "Review routing" settings screen — view tier.
// Layout and local draft state only; the react-query wiring lives in
// ReviewRoutingScreenContainer.tsx so tests can drive both tiers separately.
import { useState } from "react";
import { UserCheck } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  REVIEW_ROUTING_MAX_LOAD_MAX,
  REVIEW_ROUTING_MAX_LOAD_MIN,
  REVIEW_ROUTING_REASSIGN_HOURS_MAX,
  draftFromSettings,
  parseBoundedInt,
  settingsFromDraft,
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
  const maxLoadOk =
    current !== null &&
    parseBoundedInt(current.maxLoad, REVIEW_ROUTING_MAX_LOAD_MIN, REVIEW_ROUTING_MAX_LOAD_MAX).ok;
  const hoursOk =
    current !== null && parseBoundedInt(current.reassignHours, 0, REVIEW_ROUTING_REASSIGN_HOURS_MAX).ok;

  const save = () => {
    if (!current) return;
    const next = settingsFromDraft(current);
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

          <div>
            <Button type="button" size="sm" disabled={pending || !maxLoadOk || !hoursOk} onClick={save}>
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

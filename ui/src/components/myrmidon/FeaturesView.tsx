// Instance -> Features (myrmidon FEATURES): the fork's features with their
// effective config and live health. The view takes the report as a prop, so it
// renders without a network; the page (pages/InstanceFeatures.tsx) feeds it.
//
// Every status is worded for an operator who has not read the code: what is
// wrong, since when, and where to fix it. A feature with no health signal says
// so ("unknown") and is never drawn as working.
import { AlertTriangle, CircleCheck, CircleQuestionMark, CircleOff, CircleX, RefreshCw } from "lucide-react";
import {
  FEATURE_ATTENTION_AFTER_MS,
  FEATURE_HEALTH_STATUSES,
  type FeatureHealthStatus,
  type FeaturesReport,
  type FeatureView,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Link } from "@/lib/router";
import { timeAgo } from "@/lib/timeAgo";
import { useTranslation } from "@/i18n";

const DOCS_BASE_URL = "https://github.com/itkadr-git/myrmidon/blob/main/";

const STATUS_STYLE: Record<FeatureHealthStatus, { className: string; Icon: typeof CircleCheck }> = {
  failing: { className: "bg-red-500/15 text-red-600", Icon: CircleX },
  misconfigured: { className: "bg-orange-500/15 text-orange-600", Icon: AlertTriangle },
  unknown: { className: "bg-yellow-500/15 text-yellow-700", Icon: CircleQuestionMark },
  working: { className: "bg-green-500/15 text-green-600", Icon: CircleCheck },
  off: { className: "bg-muted text-muted-foreground", Icon: CircleOff },
};

/** Sort: broken and unknown first, working next, off last; registry order within a status. */
export function sortFeatures(features: readonly FeatureView[]): FeatureView[] {
  const rank = new Map(FEATURE_HEALTH_STATUSES.map((status, index) => [status, index]));
  return features
    .map((feature, index) => ({ feature, index }))
    .sort(
      (a, b) =>
        (rank.get(a.feature.health.status) ?? 0) - (rank.get(b.feature.health.status) ?? 0) || a.index - b.index,
    )
    .map((entry) => entry.feature);
}

function StatusBadge({ status }: { status: FeatureHealthStatus }) {
  const t = useTranslate();
  const { className, Icon } = STATUS_STYLE[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
      data-testid={`feature-status-${status}`}
    >
      <Icon className="size-3" aria-hidden="true" />
      {t(`features.status.${status}`)}
    </span>
  );
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function formatAgo(iso: string | null, translate: Translate): string {
  if (!iso) return translate("features.never");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return timeAgo(date, translate);
}

/** `t` of the i18n hook as the plain string function the helpers take. */
function useTranslate(): Translate {
  const { t } = useTranslation();
  return (key, options) => String(t(key, options));
}

function FeatureCard({
  feature,
  onToggle,
  toggling,
}: {
  feature: FeatureView;
  onToggle: (key: string, enabled: boolean) => void;
  toggling: boolean;
}) {
  const t = useTranslate();
  const { health } = feature;
  const name = t(`features.items.${feature.key}.name`, { defaultValue: feature.name });
  const description = t(`features.items.${feature.key}.description`, { defaultValue: feature.description });
  const locked = feature.toggle?.lockedBy === "env";
  return (
    <Card className="block bg-transparent p-5" data-testid={`feature-${feature.key}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{name}</h3>
            <StatusBadge status={health.status} />
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
        </div>
        {feature.toggle ? (
          <div className="flex flex-col items-end gap-1">
            <ToggleSwitch
              checked={feature.toggle.enabled}
              onCheckedChange={(next) => onToggle(feature.key, next)}
              disabled={toggling || locked}
              aria-label={t("features.toggleLabel", { name })}
              data-testid={`feature-toggle-${feature.key}`}
            />
            {locked ? (
              <span className="text-xs text-muted-foreground" data-testid={`feature-locked-${feature.key}`}>
                {t("features.lockedByEnv")}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <p className="mt-3 text-sm" data-testid={`feature-reason-${feature.key}`}>
        {health.reason}
      </p>

      {feature.needsAttentionSince ? (
        <p className="mt-1 text-xs text-orange-600" data-testid={`feature-attention-${feature.key}`}>
          {t("features.attentionSince", {
            time: formatAgo(feature.needsAttentionSince, t),
            minutes: Math.round(FEATURE_ATTENTION_AFTER_MS / 60_000),
          })}
        </p>
      ) : null}

      {health.status !== "off" ? (
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{t("features.lastSuccess")}</dt>
            <dd data-testid={`feature-last-success-${feature.key}`}>{formatAgo(health.lastSuccessAt, t)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("features.errors24h")}</dt>
            <dd data-testid={`feature-errors-${feature.key}`}>
              {health.errors24h === null ? t("features.notCounted") : health.errors24h}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{health.effect ? health.effect.label : t("features.effect")}</dt>
            <dd data-testid={`feature-effect-${feature.key}`}>
              {health.effect && health.effect.value !== null
                ? `${health.effect.value}${health.effect.unit ?? ""}`
                : t("features.notCounted")}
            </dd>
          </div>
        </dl>
      ) : null}

      {health.lastError ? (
        <p className="mt-2 break-words rounded-md bg-muted px-2 py-1 text-xs" data-testid={`feature-last-error-${feature.key}`}>
          <span className="text-muted-foreground">
            {t("features.lastError")}
            {health.lastError.at ? ` (${formatAgo(health.lastError.at, t)})` : ""}:
          </span>{" "}
          {health.lastError.message}
        </p>
      ) : null}

      <details className="mt-3" data-testid={`feature-config-${feature.key}`}>
        <summary className="cursor-pointer text-xs text-muted-foreground">{t("features.config")}</summary>
        <table className="mt-2 w-full text-xs">
          <tbody>
            {feature.config.map((entry) => (
              <tr key={entry.label} className="border-t">
                <td className="py-1 pr-3 text-muted-foreground">{entry.label}</td>
                <td className="py-1 pr-3 break-all">{entry.value}</td>
                <td className="py-1 pr-3 text-muted-foreground">{t(`features.source.${entry.source}`)}</td>
                <td className="py-1 font-mono text-muted-foreground">{entry.envVar ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
        {feature.settings ? (
          <Link to={feature.settings.path} className="underline" data-testid={`feature-settings-${feature.key}`}>
            {t("features.openSettings", { panel: feature.settings.panel })}
          </Link>
        ) : feature.toggle ? (
          <span className="text-muted-foreground">{t("features.switchHere")}</span>
        ) : (
          <span className="text-muted-foreground">{t("features.noPanel")}</span>
        )}
        <a
          href={`${DOCS_BASE_URL}${feature.docs}`}
          target="_blank"
          rel="noreferrer"
          className="underline"
          data-testid={`feature-docs-${feature.key}`}
        >
          {t("features.docs")}
        </a>
      </div>
    </Card>
  );
}

export function FeaturesView({
  report,
  loading,
  error,
  toggleError,
  togglingKey,
  refreshing,
  onToggle,
  onRefresh,
}: {
  report: FeaturesReport | null | undefined;
  loading: boolean;
  error: string | null;
  toggleError: string | null;
  togglingKey: string | null;
  refreshing: boolean;
  onToggle: (key: string, enabled: boolean) => void;
  onRefresh: () => void;
}) {
  const t = useTranslate();
  return (
    <div className="max-w-4xl space-y-6" data-testid="instance-features">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{t("features.title")}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t("features.subtitle")}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {t("features.refresh")}
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="features-error">
          {error}
        </div>
      ) : null}
      {toggleError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="features-toggle-error">
          {toggleError}
        </div>
      ) : null}

      {loading && !report ? <p className="text-sm text-muted-foreground">{t("features.loading")}</p> : null}

      {report ? (
        <>
          <div className="flex flex-wrap items-center gap-2" data-testid="features-summary">
            {FEATURE_HEALTH_STATUSES.map((status) => (
              <span key={status} className="inline-flex items-center gap-1.5 text-xs">
                <StatusBadge status={status} />
                <span data-testid={`features-count-${status}`}>{report.summary[status]}</span>
              </span>
            ))}
            <span className="text-xs text-muted-foreground">
              {t("features.checked", { time: formatAgo(report.checkedAt, t) })}
            </span>
          </div>
          <div className="space-y-4">
            {sortFeatures(report.features).map((feature) => (
              <FeatureCard
                key={feature.key}
                feature={feature}
                onToggle={onToggle}
                toggling={togglingKey === feature.key}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

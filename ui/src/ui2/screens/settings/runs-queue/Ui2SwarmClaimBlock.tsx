import { useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SwarmClaimSettingKey,
  SwarmClaimSettingSource,
  SwarmClaimSettingsPatch,
} from "@myrmidon/shared";
import {
  swarmClaimSettingsApi,
  swarmClaimSettingsQueryKey,
  swarmClaimStatusLine,
} from "../../../../components/myrmidon/swarmClaimSettingsApi";
import { Ui2Section, Ui2SkeletonRows } from "../../../components/ui2Primitives";
import { Ui2ErrorState } from "../../../components/ui2StateViews";
import { useUi2I18n } from "../../../i18n/Ui2I18n";

function sourceLabel(
  source: SwarmClaimSettingSource | undefined,
  t: ReturnType<typeof useUi2I18n>["t"],
): string {
  switch (source) {
    case "env":
      return t("ui2.settings.runs.swarmClaim.source.env");
    case "settings":
      return t("ui2.settings.runs.swarmClaim.source.settings");
    default:
      return t("ui2.settings.runs.swarmClaim.source.default");
  }
}

/**
 * myrmidon(1.7 UI2-SWARM-CLAIM, OPE-10133):
 * Swarm-claim settings section in Settings → Runs & queue.
 * Displays and edits:
 * - master enable switch
 * - task lease TTL (seconds)
 * - per-agent task limit
 * Each with its source: saved, environment override, or default.
 * Live queue counters via swarmClaimStatusLine.
 * Pinned environment overrides are disabled and labeled "задано окружением".
 */
export function Ui2SwarmClaimBlock() {
  const { t } = useUi2I18n();
  const queryClient = useQueryClient();

  const [draftTtl, setDraftTtl] = useState<string | null>(null);
  const [draftLimit, setDraftLimit] = useState<string | null>(null);

  const query = useQuery({
    queryKey: swarmClaimSettingsQueryKey,
    queryFn: () => swarmClaimSettingsApi.get(),
  });

  const updateMutation = useMutation({
    mutationFn: (patch: SwarmClaimSettingsPatch) => swarmClaimSettingsApi.update(patch),
    onSuccess: (updated) => {
      setDraftTtl(null);
      setDraftLimit(null);
      queryClient.setQueryData(swarmClaimSettingsQueryKey, updated);
    },
  });

  if (query.isError) {
    return (
      <Ui2Section title={t("ui2.settings.runs.swarmClaim.title")}>
        <Ui2ErrorState
          message={t("ui2.settings.runs.swarmClaim.loadError")}
          detail={query.error instanceof Error ? query.error.message : null}
          retryLabel={t("ui2.common.retry")}
          onRetry={() => void query.refetch()}
        />
      </Ui2Section>
    );
  }

  const view = query.data;
  if (query.isLoading || !view) {
    return (
      <Ui2Section title={t("ui2.settings.runs.swarmClaim.title")}>
        <Ui2SkeletonRows rows={3} />
      </Ui2Section>
    );
  }

  const isEnv = (key: SwarmClaimSettingKey) => view.sources[key] === "env";

  const enabled = view.settings.enabled;
  const ttlValue =
    draftTtl !== null
      ? draftTtl
      : view.settings.leaseTtlSec != null
        ? String(view.settings.leaseTtlSec)
        : "";
  const limitValue =
    draftLimit !== null
      ? draftLimit
      : view.settings.maxActiveTasks != null
        ? String(view.settings.maxActiveTasks)
        : "";

  const handleEnabledChange = (e: ChangeEvent<HTMLInputElement>) => {
    updateMutation.mutate({ enabled: e.target.checked });
  };

  const handleTtlChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setDraftTtl(raw);
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      updateMutation.mutate({ leaseTtlSec: parsed });
    }
  };

  const handleTtlBlur = () => {
    if (draftTtl !== null) {
      const parsed = parseInt(draftTtl, 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed !== view.settings.leaseTtlSec) {
        updateMutation.mutate({ leaseTtlSec: parsed });
      }
    }
  };

  const handleLimitChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setDraftLimit(raw);
    if (raw === "") {
      updateMutation.mutate({ maxActiveTasks: null });
    } else {
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        updateMutation.mutate({ maxActiveTasks: parsed });
      }
    }
  };

  const handleLimitBlur = () => {
    if (draftLimit !== null) {
      if (draftLimit === "") {
        if (view.settings.maxActiveTasks !== null) {
          updateMutation.mutate({ maxActiveTasks: null });
        }
      } else {
        const parsed = parseInt(draftLimit, 10);
        if (!Number.isNaN(parsed) && parsed > 0 && parsed !== view.settings.maxActiveTasks) {
          updateMutation.mutate({ maxActiveTasks: parsed });
        }
      }
    }
  };

  const statusLine = swarmClaimStatusLine(view.counters, (key, opts) => {
    if (key === "swarmClaim.statusLine") {
      return t("ui2.settings.runs.swarmClaim.statusLine", opts as Record<string, string | number>);
    }
    return key;
  });

  return (
    <Ui2Section
      title={t("ui2.settings.runs.swarmClaim.title")}
      subtitle={t("ui2.settings.runs.swarmClaim.subtitle")}
    >
      <div className="ui2-swarm-claim flex flex-col gap-4">
        {/* Enable switch */}
        <div className="ui2-swarm-claim-field flex flex-wrap items-center justify-between gap-3">
          <div className="ui2-swarm-claim-label flex flex-col">
            <label
              htmlFor="ui2-swarm-claim-enabled"
              className="ui2-swarm-claim-name text-sm font-medium"
            >
              {t("ui2.settings.runs.swarmClaim.enable")}
            </label>
            <span
              className="ui2-swarm-claim-source text-xs text-muted-foreground"
              data-testid="ui2-swarm-claim-enabled-source"
            >
              {sourceLabel(view.sources.enabled, t)}
            </span>
          </div>
          <input
            id="ui2-swarm-claim-enabled"
            type="checkbox"
            role="switch"
            aria-label={t("ui2.settings.runs.swarmClaim.enable")}
            className="ui2-swarm-claim-switch h-4 w-4 rounded border-border"
            checked={enabled}
            disabled={isEnv("enabled") || updateMutation.isPending}
            onChange={handleEnabledChange}
          />
        </div>

        {/* Task lease TTL */}
        <div className="ui2-swarm-claim-field flex flex-wrap items-center justify-between gap-3">
          <div className="ui2-swarm-claim-label flex flex-col">
            <label
              htmlFor="ui2-swarm-claim-lease-ttl"
              className="ui2-swarm-claim-name text-sm font-medium"
            >
              {t("ui2.settings.runs.swarmClaim.leaseTtlSec")}
            </label>
            <span
              className="ui2-swarm-claim-source text-xs text-muted-foreground"
              data-testid="ui2-swarm-claim-lease-ttl-source"
            >
              {sourceLabel(view.sources.leaseTtlSec, t)}
            </span>
          </div>
          <input
            id="ui2-swarm-claim-lease-ttl"
            type="number"
            aria-label={t("ui2.settings.runs.swarmClaim.leaseTtlSec")}
            className="ui2-swarm-claim-input w-28 rounded-md border border-border bg-background px-2.5 py-1 text-right text-sm disabled:opacity-50"
            value={ttlValue}
            disabled={isEnv("leaseTtlSec") || updateMutation.isPending}
            onChange={handleTtlChange}
            onBlur={handleTtlBlur}
          />
        </div>

        {/* Per-agent task limit */}
        <div className="ui2-swarm-claim-field flex flex-wrap items-center justify-between gap-3">
          <div className="ui2-swarm-claim-label flex flex-col">
            <label
              htmlFor="ui2-swarm-claim-max-tasks"
              className="ui2-swarm-claim-name text-sm font-medium"
            >
              {t("ui2.settings.runs.swarmClaim.maxActiveTasks")}
            </label>
            <span
              className="ui2-swarm-claim-source text-xs text-muted-foreground"
              data-testid="ui2-swarm-claim-max-tasks-source"
            >
              {sourceLabel(view.sources.maxActiveTasks, t)}
            </span>
          </div>
          <input
            id="ui2-swarm-claim-max-tasks"
            type="number"
            aria-label={t("ui2.settings.runs.swarmClaim.maxActiveTasks")}
            className="ui2-swarm-claim-input w-28 rounded-md border border-border bg-background px-2.5 py-1 text-right text-sm disabled:opacity-50"
            value={limitValue}
            disabled={isEnv("maxActiveTasks") || updateMutation.isPending}
            onChange={handleLimitChange}
            onBlur={handleLimitBlur}
          />
        </div>

        {/* Live status line */}
        {statusLine ? (
          <div
            className="ui2-swarm-claim-status text-xs text-muted-foreground"
            data-testid="ui2-swarm-claim-status"
          >
            {statusLine}
          </div>
        ) : null}

        {updateMutation.isError ? (
          <Ui2ErrorState
            message={t("ui2.settings.runs.swarmClaim.saveError")}
            detail={updateMutation.error instanceof Error ? updateMutation.error.message : null}
          />
        ) : null}
      </div>
    </Ui2Section>
  );
}

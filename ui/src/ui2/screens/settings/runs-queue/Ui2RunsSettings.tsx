// ui/src/ui2/screens/settings/runs-queue/Ui2RunsSettings.tsx
//
// myrmidon(UI2): Settings → "Runs & queue" in the new shell. This is the
// closest-to-port screen of the set: the vendor already ships
// RuntimeLimitsSettingsPanel (the admission ceilings, GET/PATCH
// /api/myrmidon/runtime-limits, applied without restart). The ui2 variant
// restyles the same contract; per the map "the ceilings panel moves over
// almost ready". P0–P3 priority-class slots, TTL/timeouts/retries per
// class, pool-growth threshold and hibernation rules are NOT in the API —
// hidden until the backend grows them (map §2.13).

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunLimitKey, RunLimits, RunLimitsPatch, RunLimitsSource } from "@paperclipai/shared";
import {
  runtimeLimitsApi,
  runtimeLimitsQueryKey,
  type RuntimeLimitsView,
} from "@/components/myrmidon/runtimeLimitsApi";
import { heartbeatsApi, type LiveRunForIssue } from "@/api/heartbeats";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useUi2I18n } from "../../../i18n/Ui2I18n";
import { Ui2ErrorState, Ui2SkeletonRows } from "../../../components/ui2StateViews";
import { Ui2Page, Ui2Section } from "../../../components/ui2Primitives";

/**
 * myrmidon(1.6.5 RUN-FAIRNESS part 3): the single-agent start share arrives
 * with part 2's shared key (`maxPerAgentStartSharePercent`, 1-100 or off,
 * default 15). This screen is merged before part 2 lands, so the field is
 * carried as a string literal, not a `RunLimitKey` — part 2 promotes it into
 * `RUN_LIMIT_KEYS` and both parts then type-check against the shared name.
 */
const FAIR_SHARE_KEY = "maxPerAgentStartSharePercent";
const FAIR_SHARE_DEFAULT = 15;

type ScreenLimitKey = RunLimitKey | typeof FAIR_SHARE_KEY;

const LIMIT_FIELDS: Array<{ key: ScreenLimitKey; labelKey: "ui2.settings.runs.maxConcurrentRuns" | "ui2.settings.runs.maxStartsPerMinute" | "ui2.settings.runs.minFreeMemoryMb" | "ui2.settings.runs.runMemoryEstimateMb" | "ui2.settings.runs.minFreeHostMemoryMb" | "ui2.settings.runs.maxHostLoadPercentPerCore" | "ui2.settings.runs.maxPerAgentStartSharePercent"; canOff: boolean }> = [
  { key: "maxConcurrentRuns", labelKey: "ui2.settings.runs.maxConcurrentRuns", canOff: true },
  { key: "maxStartsPerMinute", labelKey: "ui2.settings.runs.maxStartsPerMinute", canOff: true },
  { key: "minFreeMemoryMb", labelKey: "ui2.settings.runs.minFreeMemoryMb", canOff: true },
  { key: "runMemoryEstimateMb", labelKey: "ui2.settings.runs.runMemoryEstimateMb", canOff: false },
  // myrmidon(1.6.2 RUN-ADMISSION): the host free-memory floor (bot containers live on the host).
  { key: "minFreeHostMemoryMb", labelKey: "ui2.settings.runs.minFreeHostMemoryMb", canOff: true },
  // myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling (load average per core).
  { key: "maxHostLoadPercentPerCore", labelKey: "ui2.settings.runs.maxHostLoadPercentPerCore", canOff: true },
  // myrmidon(1.6.5 RUN-FAIRNESS): one agent's share of the starts in a 10-minute window.
  { key: FAIR_SHARE_KEY, labelKey: "ui2.settings.runs.maxPerAgentStartSharePercent", canOff: true },
];

/** Read a limit from the view: a shared key from `limits`, the fair-share key with its default. */
function readLimit(limits: RunLimits, key: ScreenLimitKey): number | null {
  if (key === FAIR_SHARE_KEY) {
    const value = (limits as Record<string, unknown>)[FAIR_SHARE_KEY];
    if (typeof value !== "number" || !Number.isInteger(value)) return FAIR_SHARE_DEFAULT;
    // A share is a percentage; outside 1-100 the served value is ignored.
    if (value < 1 || value > 100) return FAIR_SHARE_DEFAULT;
    return value;
  }
  return limits[key];
}

function sourceLabel(source: RunLimitsSource, t: (key: never) => string): string {
  switch (source) {
    case "settings":
      return t("ui2.settings.runs.source.settings" as never);
    case "env":
      return t("ui2.settings.runs.source.env" as never);
    default:
      return t("ui2.settings.runs.source.default" as never);
  }
}

export function Ui2RunsSettings() {
  const { t } = useUi2I18n();
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const [draft, setDraft] = useState<Partial<Record<ScreenLimitKey, number | null>> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const limitsQuery = useQuery({
    queryKey: runtimeLimitsQueryKey,
    queryFn: () => runtimeLimitsApi.get(),
  });

  // myrmidon(1.6.5 RUN-FAIRNESS): the live-runs list already serves the
  // queued runs of the company; the oldest of them is the head of the queue,
  // and its `contextSnapshot.waitReason` (written by the admission sweep)
  // says why it still waits. Read-only reuse — no new endpoint. A response
  // without the snapshot (a server before part 1) shows the queue numbers
  // without the reason.
  const liveRunsQuery = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "runs-settings-queue"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const view = limitsQuery.data;
  // The draft overlays the served limits; the fair share falls back to its
  // default while the server does not serve the key yet.
  const effective: Partial<Record<ScreenLimitKey, number | null>> | null = view
    ? { ...view.limits, [FAIR_SHARE_KEY]: readLimit(view.limits, FAIR_SHARE_KEY), ...draft }
    : null;

  useEffect(() => {
    setDraft(null);
    setSaveError(null);
  }, [view]);

  const saveMutation = useMutation({
    mutationFn: (patch: RunLimitsPatch) => runtimeLimitsApi.update(patch),
    onSuccess: (next) => {
      setSaveError(null);
      setDraft(null);
      queryClient.setQueryData(runtimeLimitsQueryKey, next);
    },
    onError: (error) => {
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });

  if (limitsQuery.isLoading) {
    return (
      <Ui2Page title={t("ui2.settings.runs.title")} subtitle={t("ui2.settings.runs.subtitle")}>
        <Ui2SkeletonRows rows={4} />
      </Ui2Page>
    );
  }

  if (limitsQuery.isError || !view || !effective) {
    return (
      <Ui2Page title={t("ui2.settings.runs.title")} subtitle={t("ui2.settings.runs.subtitle")}>
        <Ui2ErrorState
          message={t("ui2.common.error")}
          detail={limitsQuery.error instanceof Error ? limitsQuery.error.message : null}
          retryLabel={t("ui2.common.retry")}
          onRetry={() => void limitsQuery.refetch()}
        />
      </Ui2Page>
    );
  }

  const dirty =
    draft != null &&
    LIMIT_FIELDS.some(
      (field) =>
        (draft[field.key] ?? null) !== null && draft[field.key] !== readLimit(view.limits, field.key),
    );

  // myrmidon(1.6.5 RUN-FAIRNESS): a share over 100 % limits nothing; rather
  // than silently saving it, the screen names it and keeps Apply disabled.
  const shareOverRange =
    draft != null &&
    draft[FAIR_SHARE_KEY] !== undefined &&
    draft[FAIR_SHARE_KEY] !== null &&
    draft[FAIR_SHARE_KEY]! > 100;

  // myrmidon(1.6.5 RUN-ADMISSION rc.2): the ceiling is counted above the load
  // the host carries on its own, so the field gets a line with what the host is
  // doing right now: the reading, how much of it is the host's own background,
  // and whether the ceiling is open for a new run. `null` when the server sent
  // no reading — the panel then shows no number instead of a made-up one.
  const hostLoadLine = ((): string | null => {
    const load = view.hostLoad;
    if (!load) return null;
    if (load.state === "off") return t("ui2.settings.runs.hostLoad.off");
    if (load.state === "unknown" || load.loadPercentPerCore === null) {
      return t("ui2.settings.runs.hostLoad.unknown");
    }
    const now = t("ui2.settings.runs.hostLoad.now", {
      load: load.loadPercentPerCore,
      load1: load.load1 ?? "?",
      cores: load.cores ?? "?",
    });
    const above =
      load.loadAboveBackgroundPercent === null || load.backgroundPercentPerCore === null
        ? ""
        : ` ${t("ui2.settings.runs.hostLoad.above", {
            above: load.loadAboveBackgroundPercent,
            background: load.backgroundPercentPerCore,
          })}.`;
    const verdict =
      load.state === "open"
        ? t("ui2.settings.runs.hostLoad.open", { threshold: load.thresholdPercent ?? "?" })
        : t("ui2.settings.runs.hostLoad.closed", { threshold: load.thresholdPercent ?? "?" });
    return `${now}${above} ${verdict}.`;
  })();

  // myrmidon(1.6.5 C0-ui): the memory snapshot — the host's memory and the
  // server container's cgroup usage, read by the same admission that gates on
  // them. `null` when the server sent no snapshot (an older server, an early
  // request, or no cgroup limit to read), so the screen shows nothing rather
  // than a number it made up.
  const memoryLine = ((): string | null => {
    const memory = view.memory;
    if (!memory || (!memory.host && !memory.container)) return null;
    const parts: string[] = [];
    if (memory.host) {
      parts.push(
        t("ui2.settings.runs.memory.host", {
          available: memory.host.availableMb,
          total: memory.host.totalMb,
        }),
      );
    }
    if (memory.container) {
      parts.push(
        t("ui2.settings.runs.memory.container", {
          used: memory.container.usedMb,
          limit: memory.container.limitMb,
          free: memory.container.freeMb,
        }),
      );
    }
    return parts.join(" ");
  })();

  // myrmidon(1.6.5 RUN-FAIRNESS): the queue snapshot — admitted runs against
  // the ceiling, the queue length, and the head of the queue. `null` when the
  // server sent no snapshot (an older server, an early request), so the
  // screen shows nothing rather than a number it made up.
  const queueLine = ((): string | null => {
    const queue = view.queue;
    if (!queue) return null;
    const active =
      queue.limit === null
        ? t("ui2.settings.runs.queue.active.noLimit", { active: queue.active })
        : t("ui2.settings.runs.queue.active", { active: queue.active, limit: queue.limit });
    if (queue.queued === 0) return `${active} ${t("ui2.settings.runs.queue.empty")}`;
    const oldest = queue.oldestQueuedAt ? formatQueueSince(queue.oldestQueuedAt) : null;
    const queued = oldest
      ? t("ui2.settings.runs.queue.queued.since", { queued: queue.queued, since: oldest })
      : t("ui2.settings.runs.queue.queued", { queued: queue.queued });
    const agent = queue.oldestQueuedAgentId
      ? ` ${t("ui2.settings.runs.queue.agent", { agent: queue.oldestQueuedAgentId })}`
      : "";
    return `${active} ${queued}${agent}`;
  })();

  /** "14:32:05 UTC (7 min ago)" / "14:32:05 UTC (7 мин назад)" for the head of the queue. */
  function formatQueueSince(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso;
    const clock = at.toISOString().slice(11, 19);
    const waitedMin = Math.max(0, Math.floor((Date.now() - at.getTime()) / 60_000));
    return waitedMin >= 1
      ? t("ui2.settings.runs.queue.sinceAgo", { time: `${clock} UTC`, minutes: waitedMin })
      : `${clock} UTC`;
  }

  // myrmidon(1.6.5 RUN-FAIRNESS): why the head of the queue still waits —
  // `contextSnapshot.waitReason` of the oldest queued run (the live-runs list
  // comes newest first, so the oldest queued is the last one).
  const oldestWaitReasonKey = ((): string | null => {
    const runs = liveRunsQuery.data;
    if (!runs || !view.queue || view.queue.queued === 0) return null;
    const oldestQueued = [...runs].reverse().find((run) => run.status === "queued");
    const snapshot = (oldestQueued as LiveRunForIssue & { contextSnapshot?: Record<string, unknown> | null })
      ?.contextSnapshot;
    const reason = snapshot?.["waitReason"];
    if (typeof reason !== "string" || reason === "") return null;
    // An unknown reason (a server ahead of this UI) renders as the raw value,
    // not as an untranslated key.
    return isKnownWaitReason(reason) ? `ui2.settings.runs.waitReason.${reason}` : reason;
  })();

  function isKnownWaitReason(reason: string): boolean {
    return (
      reason === "global_cap" ||
      reason === "start_ramp" ||
      reason === "memory" ||
      reason === "host_memory" ||
      reason === "host_cpu" ||
      reason === "agent_fair_share" ||
      reason === "agent_concurrency"
    );
  }

  const waitReasonLabel = oldestWaitReasonKey
    ? oldestWaitReasonKey.startsWith("ui2.")
      ? t(oldestWaitReasonKey as never)
      : oldestWaitReasonKey
    : null;

  return (
    <Ui2Page title={t("ui2.settings.runs.title")} subtitle={t("ui2.settings.runs.subtitle")}>
      <Ui2Section title={t("ui2.settings.runs.title")}>
        <div className="ui2-run-limits flex flex-col gap-4">
          {LIMIT_FIELDS.map((field) => {
            const value = effective[field.key] ?? null;
            const source = view.sources[field.key as RunLimitKey] ?? "default";
            const off = value == null;
            return (
              <div key={field.key} className="ui2-run-limit flex flex-wrap items-center justify-between gap-3">
                <div className="ui2-run-limit-label flex flex-col">
                  <label htmlFor={`ui2-run-limit-${field.key}`} className="ui2-run-limit-name text-sm font-medium">
                    {t(field.labelKey)}
                  </label>
                  <span className="ui2-run-limit-source text-xs text-muted-foreground">
                    {sourceLabel(source, t)}
                  </span>
                  {field.key === "maxHostLoadPercentPerCore" && hostLoadLine ? (
                    <span
                      data-testid="ui2-run-limit-host-load"
                      className="ui2-run-limit-host-load text-xs text-muted-foreground"
                    >
                      {hostLoadLine}
                    </span>
                  ) : null}
                  {field.key === "maxHostLoadPercentPerCore" ? (
                    <span className="ui2-run-limit-hint max-w-md text-xs text-muted-foreground">
                      {t("ui2.settings.runs.maxHostLoadPercentPerCore.hint")}
                    </span>
                  ) : null}
                  {field.key === "minFreeMemoryMb" || field.key === "minFreeHostMemoryMb" ? (
                    <span
                      data-testid={`ui2-run-limit-hint-${field.key}`}
                      className="ui2-run-limit-hint max-w-md text-xs text-muted-foreground"
                    >
                      {t(`ui2.settings.runs.${field.key}.hint` as never)}
                    </span>
                  ) : null}
                  {field.key === FAIR_SHARE_KEY ? (
                    <span className="ui2-run-limit-hint max-w-md text-xs text-muted-foreground">
                      {t("ui2.settings.runs.maxPerAgentStartSharePercent.hint")}
                    </span>
                  ) : null}
                  {field.key === FAIR_SHARE_KEY && draft?.[FAIR_SHARE_KEY] != null && draft[FAIR_SHARE_KEY]! > 100 ? (
                    <span
                      data-testid="ui2-run-limit-fair-share-error"
                      className="ui2-run-limit-error text-xs text-destructive"
                    >
                      {t("ui2.settings.runs.maxPerAgentStartSharePercent.range")}
                    </span>
                  ) : null}
                </div>
                <div className="ui2-run-limit-control flex items-center gap-2">
                  <input
                    id={`ui2-run-limit-${field.key}`}
                    type="number"
                    min={1}
                    max={field.key === FAIR_SHARE_KEY ? 100 : undefined}
                    className="ui2-run-limit-input w-32 rounded-md border border-input bg-background px-2 py-1 text-right font-mono text-sm tabular-nums"
                    value={off ? "" : String(value ?? "")}
                    placeholder={t("ui2.settings.runs.off")}
                    disabled={off}
                    onChange={(event) => {
                      const parsed = event.target.value === "" ? null : Number(event.target.value);
                      setDraft((prev) => ({
                        ...(prev ?? {}),
                        [field.key]: parsed != null && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null,
                      }));
                    }}
                  />
                  {field.canOff ? (
                    <label className="ui2-run-limit-off flex items-center gap-1 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={off}
                        onChange={(event) => {
                          setDraft((prev) => ({
                            ...(prev ?? {}),
                            // myrmidon(1.6.5 RUN-FAIRNESS): un-"off"-ing the
                            // fair share starts from the served value, falling
                            // back to the 15 % default while part 2 is unmerged.
                            [field.key]: event.target.checked ? null : (readLimit(view.limits, field.key) ?? 1),
                          }));
                        }}
                      />
                      {t("ui2.settings.runs.off")}
                    </label>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </Ui2Section>

      {/* myrmidon(1.6.5 RUN-FAIRNESS): the queue snapshot — how full the ceiling
          is, how many runs wait, and the head of the queue. */}
      {queueLine ? (
        <div className="ui2-run-queue">
          <p data-testid="ui2-run-queue" className="text-xs text-muted-foreground">
            {queueLine}
          </p>
          {waitReasonLabel ? (
            <p data-testid="ui2-run-queue-wait-reason" className="text-xs text-muted-foreground">
              {t("ui2.settings.runs.queue.waitReason", { reason: waitReasonLabel })}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* myrmidon(1.6.5 C0-ui): the memory snapshot — the host's memory and the
          server container's cgroup usage, next to the queue line. */}
      {memoryLine ? (
        <p data-testid="ui2-run-memory" className="text-xs text-muted-foreground">
          {memoryLine}
        </p>
      ) : null}

      {saveError ? <Ui2ErrorState message={t("ui2.settings.runs.saveError", { reason: saveError })} withCache /> : null}

      <div className="ui2-run-limits-actions flex items-center gap-3">
        <button
          type="button"
          className="ui2-run-limits-save rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          disabled={!dirty || shareOverRange || saveMutation.isPending}
          onClick={() => {
            if (draft == null) return;
            const patch: RunLimitsPatch & Record<string, unknown> = {};
            for (const field of LIMIT_FIELDS) {
              if (draft[field.key] !== undefined && draft[field.key] !== readLimit(view.limits, field.key)) {
                (patch as Record<string, unknown>)[field.key] = draft[field.key];
              }
            }
            saveMutation.mutate(patch);
          }}
        >
          {t("ui2.settings.runs.save")}
        </button>
        <button
          type="button"
          className="ui2-run-limits-reset rounded-md border border-border px-4 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => setDraft(null)}
        >
          {t("ui2.settings.runs.reset")}
        </button>
        {saveMutation.isPending ? <Ui2SkeletonRows rows={1} dense /> : null}
      </div>
    </Ui2Page>
  );
}

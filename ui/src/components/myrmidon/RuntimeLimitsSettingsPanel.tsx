// Run limits (C0, RUNTIME-LIMITS): the ceilings on runs this server starts,
// editable while it runs. Saving applies them at once — queued runs start
// within a minute, no restart and no run in flight is dropped.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import type { RunLimits, RunLimitsPatch, RunLimitKey } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  describeHostLoad,
  describeQueueSnapshot,
  describeRunLimitSource,
  runtimeLimitsApi,
  runtimeLimitsQueryKey,
  type RuntimeLimitsView,
} from "./runtimeLimitsApi";

/**
 * myrmidon(1.6.5 RUN-ADMISSION rc.3, part B): the two CPU-utilisation
 * ceilings joined `RunLimits` with part A but were left out of
 * `RUN_LIMIT_KEYS`, so they are not `RunLimitKey`s yet — same situation the
 * fair-share field had before part 2. The panel carries them as string
 * literals and reads their values from the typed `limits` object; their
 * source label falls back to "default" (a source map for them arrives with
 * the shared key promotion).
 */
const CPU_BUSY_KEY = "maxHostCpuBusyPercent";
const CPU_PSI_KEY = "maxHostCpuPsiSomeAvg10";

type PanelLimitKey = RunLimitKey | typeof CPU_BUSY_KEY | typeof CPU_PSI_KEY;

/** The field ids/draft keys of the panel (the shared keys plus the rc.3 CPU ceiling literals). */
export type { PanelLimitKey };

const FIELDS: Array<{ key: PanelLimitKey; label: string; hint: string; optional: boolean }> = [
  {
    key: "maxConcurrentRuns",
    label: "Concurrent runs",
    hint: "Runs this server starts at once. Runs over the ceiling stay queued and start when a slot frees.",
    optional: true,
  },
  {
    key: "maxStartsPerMinute",
    label: "Starts per minute (start ramp)",
    hint: "How many runs may start in a sliding minute, so a restart, a bulk resolve or a mass wake does not start everything in one burst. Default 5.",
    optional: true,
  },
  {
    key: "minFreeMemoryMb",
    label: "Free memory to keep, MB",
    hint: "A run starts only if the server container keeps this much memory free after it.",
    optional: true,
  },
  {
    key: "runMemoryEstimateMb",
    label: "Memory per run, MB",
    hint: "What one run is budgeted when free memory is counted.",
    optional: false,
  },
  {
    // myrmidon(1.6.2 RUN-ADMISSION)
    key: "minFreeHostMemoryMb",
    label: "Free host memory to keep, MB",
    hint: "A new run starts only while the host (where the bot containers run) has at least this much available memory; otherwise it waits in the queue. Default 15360 (15 GB).",
    optional: true,
  },
  {
    // myrmidon(1.6.5 RUN-ADMISSION)
    key: "maxHostLoadPercentPerCore",
    label: "Max host load per core, % of a core (deprecated)",
    hint: "Deprecated: since 1.6.5 rc.3 the gate decides on the measured CPU busy percent below; this legacy ceiling only decides for a settings row saved before rc.3 that has neither CPU ceiling set. A new run starts only while the host's 1-minute load average is this many percent of one CPU core ABOVE the load the host carries on its own (100 = one core fully busy). The host's own background — the services that keep it busy without any run — does not close the ceiling: only the load the runs add counts. Default 90. Empty switches the ceiling off.",
    optional: true,
  },
  {
    // myrmidon(1.6.5 RUN-ADMISSION rc.3): the ceiling the gate decides on now.
    key: CPU_BUSY_KEY,
    label: "Max host CPU busy, % of all cores",
    hint: "A new run starts only while the host CPU's non-idle share (from /proc/stat over a short window) stays under this ABSOLUTE percent of all cores. Unlike the load average, utilisation measures real work, so no background is subtracted. Default 90. Empty switches the ceiling off.",
    optional: true,
  },
  {
    // myrmidon(1.6.5 RUN-ADMISSION rc.3): the optional PSI cpu pressure ceiling.
    key: CPU_PSI_KEY,
    label: "Max host CPU pressure (PSI some avg10), %",
    hint: "A new run starts only while the PSI cpu 'some avg10' (the percent of the last ten minutes with at least one task stalled on the CPU, from /proc/pressure/cpu) stays under this value. Off unless set: pressure rises on an oversubscribed CPU, not on a slow disk, so it guards a different failure than the busy ceiling. Empty switches the ceiling off.",
    optional: true,
  },
  {
    // myrmidon(1.6.5 RUN-FAIRNESS): one agent may take at most this share of
    // the run starts in a 10-minute window; past it its new runs wait until
    // the others have had their turn. The shared key lands with part 2 of the
    // feature; until the server serves it the field stays at its default 15.
    key: "maxPerAgentStartSharePercent",
    label: "Single-agent start share, % per 10 min",
    hint: "The most starts one agent may take in a 10-minute window, in percent. Past its share its new runs wait until the other agents have had their turn, so a hot agent cannot occupy the queue. Default 15. Empty switches the limit off (100 = no limit).",
    optional: true,
  },
];

interface DraftParse {
  patch: (RunLimitsPatch & Record<string, number | null>) | null;
  errors: Partial<Record<PanelLimitKey, string>>;
}

/** An empty field means "no limit"; anything else must be a positive integer. */
export function parseRunLimitsDraft(draft: Record<PanelLimitKey, string>): DraftParse {
  const errors: Partial<Record<PanelLimitKey, string>> = {};
  const parsed = {} as Record<PanelLimitKey, number | null>;
  for (const { key, optional } of FIELDS) {
    const raw = draft[key].trim();
    const value = raw ? Number(raw) : null;
    if (raw && (value === null || !Number.isInteger(value) || value <= 0)) {
      errors[key] = "Enter a whole number greater than zero, or leave it empty";
      continue;
    }
    // myrmidon(1.6.5 RUN-FAIRNESS): a share is a percentage — over 100 it
    // limits nothing and only looks like it does.
    if (key === "maxPerAgentStartSharePercent" && value !== null && value > 100) {
      errors[key] = "Enter a whole number from 1 to 100, or leave it empty";
      continue;
    }
    if (value === null && !optional) {
      errors[key] = "Required";
      continue;
    }
    parsed[key] = value;
  }
  if (Object.keys(errors).length > 0) return { patch: null, errors };
  // The per-run budget is required, so it is a number by now; the check keeps
  // the type honest without a cast.
  const estimate = parsed.runMemoryEstimateMb;
  if (estimate === null) return { patch: null, errors: { runMemoryEstimateMb: "Required" } };
  return {
    patch: {
      maxConcurrentRuns: parsed.maxConcurrentRuns,
      maxStartsPerMinute: parsed.maxStartsPerMinute,
      minFreeMemoryMb: parsed.minFreeMemoryMb,
      runMemoryEstimateMb: estimate,
      minFreeHostMemoryMb: parsed.minFreeHostMemoryMb,
      maxHostLoadPercentPerCore: parsed.maxHostLoadPercentPerCore,
      maxPerAgentStartSharePercent: parsed.maxPerAgentStartSharePercent,
      // myrmidon(1.6.5 RUN-ADMISSION rc.3): the two CPU-utilisation ceilings —
      // `patchRunLimitsSchema` accepts both.
      maxHostCpuBusyPercent: parsed.maxHostCpuBusyPercent,
      maxHostCpuPsiSomeAvg10: parsed.maxHostCpuPsiSomeAvg10,
    },
    errors,
  };
}

/** Read a limit from the view: every key now comes from the typed `limits` object. */
function readLimit(limits: RunLimits, key: PanelLimitKey): number | null {
  const value = limits[key] as number | null | undefined;
  if (value === undefined) {
    // An older server that does not serve the key yet (a pre-part-2 server
    // has no fair share, a pre-rc.3 server has no CPU ceilings): the fair
    // share shows its built-in default, every other absent key shows as off.
    return key === "maxPerAgentStartSharePercent" ? 15 : null;
  }
  return value;
}

function toDraft(limits: RunLimits): Record<PanelLimitKey, string> {
  const draft = {} as Record<PanelLimitKey, string>;
  for (const { key, optional } of FIELDS) {
    const value = readLimit(limits, key);
    draft[key] = value === null && optional ? "" : String(value);
  }
  return draft;
}

export function RuntimeLimitsSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: RuntimeLimitsView | null | undefined;
  onSave: (patch: RunLimitsPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const [draft, setDraft] = useState<Record<PanelLimitKey, string> | null>(null);
  const current = draft ?? (view ? toDraft(view.limits) : null);
  const { patch, errors } = current
    ? parseRunLimitsDraft(current)
    : { patch: null, errors: {} as Partial<Record<PanelLimitKey, string>> };
  // myrmidon(1.6.5 RUN-ADMISSION rc.2): the live host reading next to the
  // ceiling field, so the operator sees what the number is measured against.
  const hostLoadLine = describeHostLoad(view?.hostLoad);
  // myrmidon(1.6.5 RUN-FAIRNESS): the queue snapshot — admitted runs against
  // the ceiling, the queue length, and the head of the queue.
  const queueLine = describeQueueSnapshot(view?.queue);

  return (
    <section className="space-y-4" data-testid="myrmidon-runtime-limits">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Run limits</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          How many agent runs this server starts at once, how fast, and how much memory it and the host keep free. A run over a
          ceiling waits in the queue and starts when a slot frees. Saving takes effect immediately: queued runs start
          within a minute and no running run is interrupted. Leave a field empty to switch that limit off.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="grid gap-3 md:grid-cols-2">
          {FIELDS.map(({ key, label, hint, optional }) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`runtime-limit-${key}`}>{label}</Label>
              <Input
                id={`runtime-limit-${key}`}
                inputMode="numeric"
                placeholder={optional ? "No limit" : "Required"}
                value={current ? current[key] : ""}
                onChange={(event) =>
                  setDraft({ ...(current ?? toDraft(view.limits)), [key]: event.target.value })
                }
              />
              <div className="text-xs text-muted-foreground">
                <span data-testid={`runtime-limit-source-${key}`}>
                  {/* myrmidon(1.6.5 RUN-FAIRNESS): an unknown key (the fair share before part 2
                      lands) reports its source as the built-in default. */}
                  {describeRunLimitSource(view.sources[key as RunLimitKey] ?? "default")}
                </span>
                {errors[key] ? (
                  <span data-testid={`runtime-limit-error-${key}`} className="ml-2 text-destructive">
                    {errors[key]}
                  </span>
                ) : null}
              </div>
              {key === "maxHostCpuBusyPercent" && hostLoadLine ? (
                <p data-testid="runtime-limit-host-load" className="text-xs text-muted-foreground">
                  {hostLoadLine}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
          ))}
          {/* myrmidon(1.6.5 RUN-FAIRNESS): the queue snapshot under the fields —
              how full the ceiling is, how many wait, and the head of the queue. */}
          {queueLine ? (
            <p
              data-testid="runtime-limit-queue"
              className="text-xs text-muted-foreground md:col-span-2"
            >
              {queueLine}
            </p>
          ) : null}
          <div className="md:col-span-2">
            <Button
              type="button"
              size="sm"
              disabled={pending || patch === null}
              onClick={() => {
                if (patch) onSave(patch);
              }}
            >
              {pending ? "Saving..." : "Save run limits"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading run limits...</p>
      )}
    </section>
  );
}

export function RuntimeLimitsSettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: runtimeLimitsQueryKey,
    queryFn: () => runtimeLimitsApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: runtimeLimitsApi.update,
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the run limits failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: runtimeLimitsQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load run limits."}
      </div>
    );
  }

  return (
    <RuntimeLimitsSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}
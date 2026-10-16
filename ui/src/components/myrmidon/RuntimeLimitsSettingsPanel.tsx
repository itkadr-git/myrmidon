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
  describeAdmissionDenials,
  describeHostLoad,
  describeMemorySnapshot,
  describeQueueSnapshot,
  describeRunLimitSource,
  runtimeLimitsApi,
  runtimeLimitsQueryKey,
  type RuntimeLimitsView,
} from "./runtimeLimitsApi";

/**
 * myrmidon(1.6.5 RUN-FAIRNESS part 3): the single-agent start share arrives
 * with part 2's shared key (`maxPerAgentStartSharePercent`, 1..100 or off,
 * default 15). This panel is merged before part 2 lands, so the field is
 * carried as a string literal, not a `RunLimitKey` — part 2 promotes it into
 * `RUN_LIMIT_KEYS` and both parts then type-check against the shared name.
 */
const FAIR_SHARE_KEY = "maxPerAgentStartSharePercent";

type PanelLimitKey = RunLimitKey | typeof FAIR_SHARE_KEY;

/** The field ids/draft keys of the panel (the shared keys plus the fair-share literal). */
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
    hint: "A run starts only if the server container keeps this much memory free after it. This is the hard floor: below it everything waits, including the answer to a message the owner wrote in a chat. That answer is held by this floor alone — measured on the container and on the host's available memory — and not by the host floor below. Default 1500.",
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
    hint: "A new run starts only while the host (where the bot containers run) has at least this much available memory; otherwise it waits in the queue. The automatic runs wait here — a turn started by a message the owner wrote in a chat does not: it is admitted by the floor above (applied to the container and to the host's available memory) and goes to the front of the queue. Default 15360 (15 GB).",
    optional: true,
  },
  {
    // myrmidon(1.6.5 RUN-ADMISSION)
    key: "maxHostLoadPercentPerCore",
    label: "Max host load per core, % of a core",
    hint: "A new run starts only while the host's 1-minute load average is this many percent of one CPU core ABOVE the load the host carries on its own (100 = one core fully busy). The host's own background — the services that keep it busy without any run — does not close the ceiling: only the load the runs add counts. A turn started by a message the owner wrote in a chat does not wait for this ceiling either. Default 90. Empty switches the ceiling off.",
    optional: true,
  },
  {
    // myrmidon(1.6.5 RUN-FAIRNESS): one agent may take at most this share of
    // the run starts in a 10-minute window; past it its new runs wait until
    // the others have had their turn. The shared key lands with part 2 of the
    // feature; until the server serves it the field stays at its default 15.
    key: FAIR_SHARE_KEY,
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
    if (key === FAIR_SHARE_KEY && value !== null && value > 100) {
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
      // myrmidon(1.6.5 RUN-FAIRNESS): not yet a key of RunLimitsPatch — part 2
      // adds it to the shared schema; the PATCH body already carries it.
      [FAIR_SHARE_KEY]: parsed[FAIR_SHARE_KEY],
    },
    errors,
  };
}

/** Read a limit from the view: a shared key from `limits`, the fair-share key with its default. */
function readLimit(limits: RunLimits, key: PanelLimitKey): number | null {
  if (key === FAIR_SHARE_KEY) {
    const value = (limits as Record<string, unknown>)[FAIR_SHARE_KEY];
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100 ? value : 15;
  }
  return limits[key];
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
  // myrmidon(1.6.5 C0-ui): the memory snapshot — the host's available memory
  // and the server container's cgroup usage, next to the queue line.
  const memoryLine = describeMemorySnapshot(view?.memory);
  // myrmidon(1.6.5 F-09 B): the admission's refusal counter — how often the
  // sweep left a queued run waiting on a global/host ceiling, by reason and
  // with the time of the last one. `null` when the server sends no counter, so
  // the block is simply absent on an older server.
  const denialsLine = describeAdmissionDenials(view?.admissionDenials);

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
              {key === "maxHostLoadPercentPerCore" && hostLoadLine ? (
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
          {/* myrmidon(1.6.5 C0-ui): the memory snapshot — the host's memory and
              the server container's cgroup usage, next to the queue line. */}
          {memoryLine ? (
            <p
              data-testid="runtime-limit-memory"
              className="text-xs text-muted-foreground md:col-span-2"
            >
              {memoryLine}
            </p>
          ) : null}
          {/* myrmidon(1.6.5 F-09 B): the admission's refusal counter — why the
              sweep left queued runs waiting, by reason, and when it last did.
              Absent when the server sends no counter (an older server). */}
          {denialsLine ? (
            <p
              data-testid="runtime-limit-admission-denials"
              className="text-xs text-muted-foreground md:col-span-2"
            >
              {denialsLine}
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
// myrmidon(1.6.5 SWARM-T4, design §5.1): the "Self-organization (swarm)"
// section of Instance → General. One master switch plus the pheromone
// mapping, the lease/limit/sweep extras and the change journal. Saving writes
// the instance settings row; the server re-reads it on every claim, checkout
// and sweep tick, so a change applies within a minute without a restart.
// Switching the swarm off frees the live leases at once (the PATCH response
// reports how many); assignees are NOT touched.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import type { SwarmClaimSettingsPatch, SwarmClaimSettingSource } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  describeSwarmClaimSource,
  swarmClaimSettingsApi,
  swarmClaimSettingsQueryKey,
  swarmClaimStatusLine,
  type SwarmClaimSettingsView,
} from "./swarmClaimSettingsApi";

interface DraftParse {
  patch: SwarmClaimSettingsPatch | null;
  errors: Partial<Record<string, string>>;
}

const NUMBER_FIELD_HINTS = {
  leaseTtlSec: "How long one lease lives without a heartbeat, in seconds (60–86400).",
  maxActiveTasks: "Ceiling of live claims per agent; empty = no ceiling.",
  sweepIntervalSec: "How often the expired-lease sweep runs, in seconds (minimum 5).",
} as const;

/** myrmidon(1.6.5 SWARM-T4, design §5.1 / §2.3): pheromone field ids. */
export type PheromoneNumberKey =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "agingStepHours"
  | "agingStep"
  | "agingCap"
  | "failPenalty"
  | "cooldownBaseMin"
  | "cooldownCapMin";

/** Pheromone fields: priority → strength mapping (4) and dynamics (6). */
export const PHEROMONE_NUMBER_KEYS: readonly PheromoneNumberKey[] = [
  "critical",
  "high",
  "medium",
  "low",
  "agingStepHours",
  "agingStep",
  "agingCap",
  "failPenalty",
  "cooldownBaseMin",
  "cooldownCapMin",
] as const;

const PHEROMONE_FIELD_LABELS: Record<PheromoneNumberKey, string> = {
  critical: "Critical (P0) strength",
  high: "High strength",
  medium: "Medium strength",
  low: "Low strength",
  agingStepHours: "Aging step, hours",
  agingStep: "Aging increment",
  agingCap: "Aging cap",
  failPenalty: "Evaporation penalty per failed run",
  cooldownBaseMin: "Cooldown base, minutes",
  cooldownCapMin: "Cooldown cap, minutes",
};

const PHEROMONE_FIELD_HELP: Record<PheromoneNumberKey, string> = {
  critical: "Strength a new critical (P0) task starts with.",
  high: "Strength a new high task starts with.",
  medium: "Strength a new medium task starts with.",
  low: "Strength a new low task starts with.",
  agingStepHours: "How many hours of waiting make one aging step.",
  agingStep: "Strength added per aging step.",
  agingCap: "Total strength aging can add to one task.",
  failPenalty: "Strength subtracted per failed run since the last task change.",
  cooldownBaseMin: "How long a task with no matching agent cools down before another attempt.",
  cooldownCapMin: "Upper bound of the cooldown after repeated failures.",
};

/** Defaults per design §5.1 / §2.3 — what an unset field falls back to. */
export const PHEROMONE_FIELD_DEFAULTS: Record<PheromoneNumberKey, number> = {
  critical: 100,
  high: 30,
  medium: 10,
  low: 1,
  agingStepHours: 24,
  agingStep: 1,
  agingCap: 5,
  failPenalty: 10,
  cooldownBaseMin: 30,
  cooldownCapMin: 720,
};

/**
 * Parse the numeric draft fields. An empty field means "no ceiling" for the
 * limit; everything else must be a whole number in the documented range.
 */
export function parseSwarmClaimDraft(draft: {
  leaseTtlSec: string;
  maxActiveTasks: string;
  sweepIntervalSec: string;
}): Pick<DraftParse, "patch" | "errors"> {
  const errors: Partial<Record<string, string>> = {};

  const ttlRaw = draft.leaseTtlSec.trim();
  const ttl = ttlRaw ? Number(ttlRaw) : Number.NaN;
  if (!ttlRaw || !Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
    errors.leaseTtlSec = "Enter a whole number from 60 to 86400";
  }

  const maxRaw = draft.maxActiveTasks.trim();
  let maxActiveTasks: number | null = null;
  if (maxRaw) {
    const value = Number(maxRaw);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      errors.maxActiveTasks = "Enter a whole number from 1 to 100, or leave it empty for no ceiling";
    } else {
      maxActiveTasks = value;
    }
  }

  const sweepRaw = draft.sweepIntervalSec.trim();
  const sweep = sweepRaw ? Number(sweepRaw) : Number.NaN;
  if (!sweepRaw || !Number.isInteger(sweep) || sweep < 5) {
    errors.sweepIntervalSec = "Enter a whole number of at least 5";
  }

  if (Object.keys(errors).length > 0) return { patch: null, errors };

  return {
    patch: {
      leaseTtlSec: ttl,
      maxActiveTasks,
      sweepIntervalSec: sweep,
    },
    errors,
  };
}

/**
 * Parse one pheromone draft field: whole number ≥ 0; empty means the
 * design default (the server treats it the same way).
 */
export function parsePheromoneField(
  key: PheromoneNumberKey,
  raw: string,
): { value: number | null; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, error: null };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0 || value > 100000) {
    return {
      value: null,
      error: "Enter a whole number from 0 to 100000, or leave it empty for the default",
    };
  }
  return { value, error: null };
}

function toDraftNumbers(settings: {
  leaseTtlSec: number;
  maxActiveTasks: number | null;
  sweepIntervalSec: number;
}) {
  return {
    leaseTtlSec: String(settings.leaseTtlSec),
    maxActiveTasks: settings.maxActiveTasks === null ? "" : String(settings.maxActiveTasks),
    sweepIntervalSec: String(settings.sweepIntervalSec),
  };
}

/** myrmidon(1.6.5 SWARM-T4, design §5.1): the pheromone settings as draft
 *  strings — empty means "use the design default". */
export interface PheromoneDraft {
  critical: string;
  high: string;
  medium: string;
  low: string;
  agingStepHours: string;
  agingStep: string;
  agingCap: string;
  failPenalty: string;
  cooldownBaseMin: string;
  cooldownCapMin: string;
}

export function toPheromoneDraft(view: SwarmClaimSettingsView | null | undefined): PheromoneDraft {
  const raw = (view?.settings as unknown as Record<string, unknown>)?.pheromone;
  const p = (typeof raw === "object" && raw !== null ? (raw as Record<string, number | undefined>) : {}) as Partial<
    Record<PheromoneNumberKey, number>
  >;
  const entry = (key: PheromoneNumberKey) => (p[key] === undefined ? "" : String(p[key]));
  return {
    critical: entry("critical"),
    high: entry("high"),
    medium: entry("medium"),
    low: entry("low"),
    agingStepHours: entry("agingStepHours"),
    agingStep: entry("agingStep"),
    agingCap: entry("agingCap"),
    failPenalty: entry("failPenalty"),
    cooldownBaseMin: entry("cooldownBaseMin"),
    cooldownCapMin: entry("cooldownCapMin"),
  };
}

export function SwarmClaimSettingsPanelView({
  view,
  status,
  onSave,
  pending,
  error,
}: {
  view: SwarmClaimSettingsView | null | undefined;
  /** myrmidon(1.6.5 SWARM-T4, design §5.1): the one-line live status. */
  status: string | null;
  onSave: (patch: SwarmClaimSettingsPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const [draftNumbers, setDraftNumbers] = useState<ReturnType<typeof toDraftNumbers> | null>(null);
  const [draftEnabled, setDraftEnabled] = useState<boolean | null>(null);
  const [draftP0, setDraftP0] = useState<boolean | null>(null);
  const [draftPheromone, setDraftPheromone] = useState<PheromoneDraft | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const numbers = draftNumbers ?? (view ? toDraftNumbers(view.settings) : null);
  const enabled = draftEnabled ?? (view ? view.settings.enabled : false);
  const p0Preemption = draftP0 ?? (view ? view.settings.p0Preemption : true);
  const pheromone = draftPheromone ?? toPheromoneDraft(view);

  const { patch: numberPatch, errors } = numbers
    ? parseSwarmClaimDraft(numbers)
    : { patch: null, errors: {} as Partial<Record<string, string>> };

  const pheromoneParsed = useMemo(() => {
    const values: Partial<Record<PheromoneNumberKey, number>> = {};
    const pheromoneErrors: Partial<Record<PheromoneNumberKey, string>> = {};
    for (const key of PHEROMONE_NUMBER_KEYS) {
      const { value, error: fieldError } = parsePheromoneField(key, pheromone[key]);
      if (fieldError) pheromoneErrors[key] = fieldError;
      if (value !== null) values[key] = value;
    }
    return { values, hasErrors: Object.keys(pheromoneErrors).length > 0, pheromoneErrors };
  }, [pheromone]);

  const canSave = Boolean(numberPatch) && !pheromoneParsed.hasErrors && view !== null && view !== undefined;
  const patch: SwarmClaimSettingsPatch | null = numberPatch
    ? {
        ...numberPatch,
        enabled,
        p0Preemption,
        ...(Object.keys(pheromoneParsed.values).length > 0 ? { pheromone: pheromoneParsed.values } : {}),
      }
    : null;

  const source = (key: string) =>
    view
      ? describeSwarmClaimSource(
          (view.sources as Record<string, string | undefined>)[key] as
            | SwarmClaimSettingSource
            | undefined,
        )
      : "";

  return (
    <section className="space-y-4" data-testid="myrmidon-swarm-claim-settings">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Self-organization (swarm)</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          The board itself matches a free agent to each unassigned task by caste and scent,
          and wakes that agent on its own task. Every value applies without a restart — the
          server re-reads these settings on each claim and sweep tick. Turning the swarm off
          releases the live leases immediately; assignees are not touched. Environment
          variables stay forced overrides; each field shows whether the saved value or the
          override is in force.
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
                <Label htmlFor="swarm-claim-enabled">Enable the swarm</Label>
                <p className="text-xs text-muted-foreground">
                  One switch for the whole matching pipeline. When it is on, an unassigned
                  task with a caste waits in that caste&apos;s queue until a free agent
                  appears.
                </p>
                <p className="text-xs text-muted-foreground">
                  <span data-testid="swarm-claim-source-enabled">{source("enabled")}</span>
                </p>
              </div>
              <ToggleSwitch
                id="swarm-claim-enabled"
                checked={enabled}
                onCheckedChange={setDraftEnabled}
                data-testid="swarm-claim-enabled-toggle"
              />
            </div>
            {enabled && status ? (
              <p
                className="rounded-md border border-border bg-accent/20 px-3 py-2 text-xs text-foreground"
                data-testid="swarm-claim-status-line"
              >
                {status}
              </p>
            ) : null}
          </div>

          <fieldset className="space-y-3 md:col-span-2" data-testid="swarm-claim-pheromones">
            <legend className="text-sm font-medium">Pheromones</legend>
            <p className="text-xs text-muted-foreground">
              The priority → strength mapping seeds a task&apos;s pheromone; waiting adds
              strength (aging) and failed runs subtract it (evaporation) until the task
              changes. The queue orders by the effective strength.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(["critical", "high", "medium", "low"] as const).map((key) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`swarm-claim-pheromone-${key}`}>{PHEROMONE_FIELD_LABELS[key]}</Label>
                  <Input
                    id={`swarm-claim-pheromone-${key}`}
                    inputMode="numeric"
                    placeholder={String(PHEROMONE_FIELD_DEFAULTS[key])}
                    value={pheromone[key]}
                    onChange={(event) => setDraftPheromone({ ...pheromone, [key]: event.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">{PHEROMONE_FIELD_HELP[key]}</p>
                  {pheromoneParsed.pheromoneErrors[key] ? (
                    <p className="text-xs text-destructive" data-testid={`swarm-claim-error-pheromone-${key}`}>
                      {pheromoneParsed.pheromoneErrors[key]}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(["agingStepHours", "agingStep", "agingCap", "failPenalty", "cooldownBaseMin", "cooldownCapMin"] as const).map(
                (key) => (
                  <div key={key} className="space-y-1">
                    <Label htmlFor={`swarm-claim-pheromone-${key}`}>{PHEROMONE_FIELD_LABELS[key]}</Label>
                    <Input
                      id={`swarm-claim-pheromone-${key}`}
                      inputMode="numeric"
                      placeholder={String(PHEROMONE_FIELD_DEFAULTS[key])}
                      value={pheromone[key]}
                      onChange={(event) => setDraftPheromone({ ...pheromone, [key]: event.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">{PHEROMONE_FIELD_HELP[key]}</p>
                    {pheromoneParsed.pheromoneErrors[key] ? (
                      <p className="text-xs text-destructive" data-testid={`swarm-claim-error-pheromone-${key}`}>
                        {pheromoneParsed.pheromoneErrors[key]}
                      </p>
                    ) : null}
                  </div>
                ),
              )}
            </div>
          </fieldset>

          <div className="space-y-2 md:col-span-2">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="swarm-claim-p0">P0 preempts the queue</Label>
                <p className="text-xs text-muted-foreground">
                  <span data-testid="swarm-claim-source-p0Preemption">{source("p0Preemption")}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  On — a critical task is the top of the queue. Off — the queue is strictly
                  by effective strength.
                </p>
              </div>
              <ToggleSwitch
                id="swarm-claim-p0"
                checked={p0Preemption}
                onCheckedChange={setDraftP0}
                data-testid="swarm-claim-p0-toggle"
              />
            </div>
          </div>

          <details
            className="md:col-span-2"
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}
            data-testid="swarm-claim-advanced"
          >
            <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {(["leaseTtlSec", "maxActiveTasks", "sweepIntervalSec"] as const).map((key) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`swarm-claim-${key}`}>
                    {key === "leaseTtlSec"
                      ? "Lease TTL, seconds"
                      : key === "maxActiveTasks"
                        ? "Max active tasks per agent"
                        : "Sweep interval, seconds"}
                  </Label>
                  <Input
                    id={`swarm-claim-${key}`}
                    inputMode="numeric"
                    placeholder={key === "maxActiveTasks" ? "No ceiling" : "Required"}
                    value={numbers ? numbers[key] : ""}
                    onChange={(event) =>
                      setDraftNumbers({ ...(numbers ?? toDraftNumbers(view.settings)), [key]: event.target.value })
                    }
                  />
                  <div className="text-xs text-muted-foreground">
                    <span data-testid={`swarm-claim-source-${key}`}>{source(key)}</span>
                    {errors[key] ? (
                      <span data-testid={`swarm-claim-error-${key}`} className="ml-2 text-destructive">
                        {errors[key]}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">{NUMBER_FIELD_HINTS[key]}</p>
                </div>
              ))}
            </div>
          </details>

          <div className="md:col-span-2">
            <Button
              type="button"
              size="sm"
              disabled={pending || !canSave || patch === null}
              onClick={() => {
                if (patch) onSave(patch);
              }}
            >
              {pending ? "Saving..." : "Save self-organization settings"}
            </Button>
          </div>

          <div className="space-y-1 md:col-span-2" data-testid="swarm-claim-journal">
            <h3 className="text-sm font-medium">Change journal</h3>
            <p className="text-xs text-muted-foreground">
              Who changed the swarm settings, and when (newest first).
            </p>
            {view.journal.length === 0 ? (
              <p className="text-xs text-muted-foreground">No changes recorded yet.</p>
            ) : (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {view.journal.slice(0, 10).map((entry) => (
                  <li key={entry.at + entry.actorId} data-testid="swarm-claim-journal-entry">
                    <span className="font-mono">{new Date(entry.at).toLocaleString()}</span>
                    {" — "}
                    <span className="font-mono">
                      {entry.actorType}:{entry.actorId}
                    </span>
                    {" — "}
                    {Object.keys(entry.patch).join(", ") || "(no keys)"}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading self-organization settings...</p>
      )}
    </section>
  );
}

export function SwarmClaimSettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [releasedNote, setReleasedNote] = useState<string | null>(null);
  const query = useQuery({
    queryKey: swarmClaimSettingsQueryKey,
    queryFn: () => swarmClaimSettingsApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: swarmClaimSettingsApi.update,
    onMutate: () => {
      setError(null);
      setReleasedNote(null);
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Saving the self-organization settings failed."),
    onSuccess: async (data) => {
      setError(null);
      setReleasedNote(
        typeof data.releasedClaims === "number" && data.releasedClaims > 0
          ? `Swarm switched off: ${data.releasedClaims} live lease(s) released.`
          : null,
      );
      await queryClient.invalidateQueries({ queryKey: swarmClaimSettingsQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load the self-organization settings."}
      </div>
    );
  }

  const banner = error ?? releasedNote;

  return (
    <SwarmClaimSettingsPanelView
      view={query.data}
      status={swarmClaimStatusLine(query.data?.counters)}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={banner}
    />
  );
}

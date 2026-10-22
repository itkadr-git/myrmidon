// myrmidon(1.6.5 SWARM-T4, design §5.1): the "Self-organization (swarm)"
// section of Instance → General. One master switch plus the pheromone
// mapping, the lease/limit/sweep extras and the change journal. Saving writes
// the instance settings row; the server re-reads it on every claim, checkout
// and sweep tick, so a change applies within a minute without a restart.
// Switching the swarm off frees the live leases at once (the PATCH response
// reports how many); assignees are NOT touched.
//
// myrmidon(1.6.5 SWARM-PANEL-COOLING, OPE-6894):
//   - the dead `pheromone.cooldownBaseMin` / `pheromone.cooldownCapMin`
//     fields are gone — no server code ever read them;
//   - the real task cooling (F-26 wake guard: `server/src/myrmidon/
//     wake-task-guard.ts` reads `general.swarm`) is configured in the
//     "Task cooling" block below: `cooldownBaseMin`, `cooldownCeilingHours`
//     and the run-without-task gate, saved through the instance-general
//     settings API without a restart. `updateGeneral` merges over the stored
//     document, so `general.swarmClaim` survives the write;
//   - every user-visible string runs through the fork i18n catalog
//     (`swarmClaim` namespace, en/ru) — no hardcoded English in the JSX.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, AlarmClock } from "lucide-react";
import type {
  SwarmClaimSettingsPatch,
  SwarmClaimSettingSource,
  SwarmSettings,
} from "@paperclipai/shared";
import {
  SWARM_COOLDOWN_BASE_MIN_DEFAULT,
  SWARM_COOLDOWN_BASE_MIN_MAX,
  SWARM_COOLDOWN_BASE_MIN_MIN,
  SWARM_COOLDOWN_CEILING_HOURS_DEFAULT,
  SWARM_COOLDOWN_CEILING_HOURS_MAX,
  SWARM_COOLDOWN_CEILING_HOURS_MIN,
  SWARM_RUN_WITHOUT_TASK_GATE_DEFAULT,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { useTranslation } from "@/i18n";
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

/**
 * myrmidon(OPE-6894): these maps carry i18n KEYS (fork catalog `swarmClaim`),
 * rendered through `t(…)`. Values are English from en.json; ru.json ships the
 * Russian wording. The dead `cooldownBaseMin` / `cooldownCapMin` pheromone
 * fields were removed with the shared schema.
 */
const NUMBER_FIELD_HINTS = {
  leaseTtlSec: "swarmClaim.help.leaseTtlSec",
  maxActiveTasks: "swarmClaim.help.maxActiveTasks",
  sweepIntervalSec: "swarmClaim.help.sweepIntervalSec",
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
  | "failPenalty";

/** Pheromone fields: priority → strength mapping (4) and dynamics (4). */
export const PHEROMONE_NUMBER_KEYS: readonly PheromoneNumberKey[] = [
  "critical",
  "high",
  "medium",
  "low",
  "agingStepHours",
  "agingStep",
  "agingCap",
  "failPenalty",
] as const;

const PHEROMONE_FIELD_LABELS: Record<PheromoneNumberKey, string> = {
  critical: "swarmClaim.pheromone.critical.label",
  high: "swarmClaim.pheromone.high.label",
  medium: "swarmClaim.pheromone.medium.label",
  low: "swarmClaim.pheromone.low.label",
  agingStepHours: "swarmClaim.pheromone.agingStepHours.label",
  agingStep: "swarmClaim.pheromone.agingStep.label",
  agingCap: "swarmClaim.pheromone.agingCap.label",
  failPenalty: "swarmClaim.pheromone.failPenalty.label",
};

const PHEROMONE_FIELD_HELP: Record<PheromoneNumberKey, string> = {
  critical: "swarmClaim.pheromone.critical.help",
  high: "swarmClaim.pheromone.high.help",
  medium: "swarmClaim.pheromone.medium.help",
  low: "swarmClaim.pheromone.low.help",
  agingStepHours: "swarmClaim.pheromone.agingStepHours.help",
  agingStep: "swarmClaim.pheromone.agingStep.help",
  agingCap: "swarmClaim.pheromone.agingCap.help",
  failPenalty: "swarmClaim.pheromone.failPenalty.help",
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
};

/**
 * Parse the numeric draft fields. An empty field means "no ceiling" for the
 * limit; everything else must be a whole number in the documented range.
 * myrmidon(OPE-6894): errors are i18n keys rendered through `t(…)`.
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
    errors.leaseTtlSec = "swarmClaim.err.leaseTtlSec";
  }

  const maxRaw = draft.maxActiveTasks.trim();
  let maxActiveTasks: number | null = null;
  if (maxRaw) {
    const value = Number(maxRaw);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      errors.maxActiveTasks = "swarmClaim.err.maxActiveTasks";
    } else {
      maxActiveTasks = value;
    }
  }

  const sweepRaw = draft.sweepIntervalSec.trim();
  const sweep = sweepRaw ? Number(sweepRaw) : Number.NaN;
  if (!sweepRaw || !Number.isInteger(sweep) || sweep < 5) {
    errors.sweepIntervalSec = "swarmClaim.err.sweepIntervalSec";
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
      error: "swarmClaim.err.pheromone",
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
  const { t } = useTranslation();
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
      ? t(
          describeSwarmClaimSource(
            (view.sources as Record<string, string | undefined>)[key] as
              | SwarmClaimSettingSource
              | undefined,
          ),
        )
      : "";

  return (
    <section className="space-y-4" data-testid="myrmidon-swarm-claim-settings">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("swarmClaim.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("swarmClaim.intro")}</p>
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
                <Label htmlFor="swarm-claim-enabled">{t("swarmClaim.enableLabel")}</Label>
                <p className="text-xs text-muted-foreground">{t("swarmClaim.enableHelp")}</p>
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
            <legend className="text-sm font-medium">{t("swarmClaim.pheromonesTitle")}</legend>
            <p className="text-xs text-muted-foreground">{t("swarmClaim.pheromonesHelp")}</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(["critical", "high", "medium", "low"] as const).map((key) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`swarm-claim-pheromone-${key}`}>{t(PHEROMONE_FIELD_LABELS[key])}</Label>
                  <Input
                    id={`swarm-claim-pheromone-${key}`}
                    inputMode="numeric"
                    placeholder={String(PHEROMONE_FIELD_DEFAULTS[key])}
                    value={pheromone[key]}
                    onChange={(event) => setDraftPheromone({ ...pheromone, [key]: event.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">{t(PHEROMONE_FIELD_HELP[key])}</p>
                  {pheromoneParsed.pheromoneErrors[key] ? (
                    <p className="text-xs text-destructive" data-testid={`swarm-claim-error-pheromone-${key}`}>
                      {t(pheromoneParsed.pheromoneErrors[key]!)}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(["agingStepHours", "agingStep", "agingCap", "failPenalty"] as const).map(
                (key) => (
                  <div key={key} className="space-y-1">
                    <Label htmlFor={`swarm-claim-pheromone-${key}`}>{t(PHEROMONE_FIELD_LABELS[key])}</Label>
                    <Input
                      id={`swarm-claim-pheromone-${key}`}
                      inputMode="numeric"
                      placeholder={String(PHEROMONE_FIELD_DEFAULTS[key])}
                      value={pheromone[key]}
                      onChange={(event) => setDraftPheromone({ ...pheromone, [key]: event.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">{t(PHEROMONE_FIELD_HELP[key])}</p>
                    {pheromoneParsed.pheromoneErrors[key] ? (
                      <p className="text-xs text-destructive" data-testid={`swarm-claim-error-pheromone-${key}`}>
                        {t(pheromoneParsed.pheromoneErrors[key]!)}
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
                <Label htmlFor="swarm-claim-p0">{t("swarmClaim.p0Label")}</Label>
                <p className="text-xs text-muted-foreground">
                  <span data-testid="swarm-claim-source-p0Preemption">{source("p0Preemption")}</span>
                </p>
                <p className="text-xs text-muted-foreground">{t("swarmClaim.p0Help")}</p>
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
            <summary className="cursor-pointer text-sm font-medium">{t("swarmClaim.advanced")}</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {(["leaseTtlSec", "maxActiveTasks", "sweepIntervalSec"] as const).map((key) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`swarm-claim-${key}`}>
                    {t(`swarmClaim.advancedLabel.${key}`)}
                  </Label>
                  <Input
                    id={`swarm-claim-${key}`}
                    inputMode="numeric"
                    placeholder={key === "maxActiveTasks" ? t("swarmClaim.noCeilingPlaceholder") : t("swarmClaim.requiredPlaceholder")}
                    value={numbers ? numbers[key] : ""}
                    onChange={(event) =>
                      setDraftNumbers({ ...(numbers ?? toDraftNumbers(view.settings)), [key]: event.target.value })
                    }
                  />
                  <div className="text-xs text-muted-foreground">
                    <span data-testid={`swarm-claim-source-${key}`}>{source(key)}</span>
                    {errors[key] ? (
                      <span data-testid={`swarm-claim-error-${key}`} className="ml-2 text-destructive">
                        {t(errors[key]!)}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">{t(NUMBER_FIELD_HINTS[key])}</p>
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
              {pending ? t("swarmClaim.saving") : t("swarmClaim.save")}
            </Button>
          </div>

          <div className="space-y-1 md:col-span-2" data-testid="swarm-claim-journal">
            <h3 className="text-sm font-medium">{t("swarmClaim.journalTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("swarmClaim.journalHelp")}</p>
            {view.journal.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("swarmClaim.journalEmpty")}</p>
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
                    {Object.keys(entry.patch).join(", ") || t("swarmClaim.journalNoKeys")}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("swarmClaim.loading")}</p>
      )}
    </section>
  );
}

/**
 * myrmidon(1.6.5 SWARM-PANEL-COOLING, OPE-6894): the "Task cooling" block —
 * the ONE cooling rule the board applies (F-26 wake guard, general.swarm):
 * after a stale automatic run of a task, its next automatic wake waits
 * `cooldownBaseMin` × 2^(n-1), clamped to `cooldownCeilingHours`; the gate
 * flag drops automatic wakes that name no existing task. Empty numbers mean
 * "use the server default" (the same defaults the guard resolves). Saving
 * PATCHes `general.swarm` through the instance-general settings API — no
 * restart; the stored `general.swarmClaim` is preserved by the server's
 * read-modify-write merge of `updateGeneral`.
 */
export interface CoolingDraft {
  cooldownBaseMin: string;
  cooldownCeilingHours: string;
}

export function toCoolingDraft(swarm: SwarmSettings | null | undefined): CoolingDraft {
  return {
    cooldownBaseMin: swarm?.cooldownBaseMin === undefined ? "" : String(swarm.cooldownBaseMin),
    cooldownCeilingHours:
      swarm?.cooldownCeilingHours === undefined ? "" : String(swarm.cooldownCeilingHours),
  };
}

/** Parse one cooling draft field against the shared schema bounds. */
export function parseCoolingField(
  key: "cooldownBaseMin" | "cooldownCeilingHours",
  raw: string,
): { value: number | null; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, error: null };
  const value = Number(trimmed);
  const [min, max] =
    key === "cooldownBaseMin"
      ? ([SWARM_COOLDOWN_BASE_MIN_MIN, SWARM_COOLDOWN_BASE_MIN_MAX] as const)
      : ([SWARM_COOLDOWN_CEILING_HOURS_MIN, SWARM_COOLDOWN_CEILING_HOURS_MAX] as const);
  if (!Number.isInteger(value) || value < min || value > max) {
    return { value: null, error: `swarmClaim.cooling.err.${key}` };
  }
  return { value, error: null };
}

export function SwarmCoolingSettingsPanelView({
  swarm,
  loading,
  saving,
  error,
  onSave,
}: {
  swarm: SwarmSettings | null | undefined;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onSave: (swarm: SwarmSettings) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<CoolingDraft | null>(null);
  const [draftGate, setDraftGate] = useState<boolean | null>(null);

  const numbers = draft ?? toCoolingDraft(swarm);
  const gate = draftGate ?? (swarm?.runWithoutTaskGate ?? SWARM_RUN_WITHOUT_TASK_GATE_DEFAULT);

  const parsed = useMemo(() => {
    const base = parseCoolingField("cooldownBaseMin", numbers.cooldownBaseMin);
    const ceiling = parseCoolingField("cooldownCeilingHours", numbers.cooldownCeilingHours);
    const errors: Partial<Record<keyof CoolingDraft, string>> = {};
    if (base.error) errors.cooldownBaseMin = base.error;
    if (ceiling.error) errors.cooldownCeilingHours = ceiling.error;
    const patch: SwarmSettings = {
      runWithoutTaskGate: gate,
      ...(base.value !== null ? { cooldownBaseMin: base.value } : {}),
      ...(ceiling.value !== null ? { cooldownCeilingHours: ceiling.value } : {}),
    };
    return { errors, hasErrors: Object.keys(errors).length > 0, patch };
  }, [numbers, gate]);

  return (
    <section className="space-y-4" data-testid="myrmidon-swarm-cooling">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <AlarmClock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("swarmClaim.cooling.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("swarmClaim.cooling.intro")}</p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">{t("swarmClaim.cooling.loading")}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="swarm-cooling-gate">{t("swarmClaim.cooling.gateLabel")}</Label>
                <p className="text-xs text-muted-foreground">{t("swarmClaim.cooling.gateHelp")}</p>
              </div>
              <ToggleSwitch
                id="swarm-cooling-gate"
                checked={gate}
                onCheckedChange={setDraftGate}
                data-testid="swarm-cooling-gate-toggle"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="swarm-cooling-baseMin">{t("swarmClaim.cooling.baseLabel")}</Label>
            <Input
              id="swarm-cooling-baseMin"
              inputMode="numeric"
              placeholder={String(SWARM_COOLDOWN_BASE_MIN_DEFAULT)}
              value={numbers.cooldownBaseMin}
              onChange={(event) => setDraft({ ...numbers, cooldownBaseMin: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t("swarmClaim.cooling.baseHelp")}</p>
            {parsed.errors.cooldownBaseMin ? (
              <p className="text-xs text-destructive" data-testid="swarm-cooling-error-baseMin">
                {t(parsed.errors.cooldownBaseMin)}
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="swarm-cooling-ceilingHours">{t("swarmClaim.cooling.ceilingLabel")}</Label>
            <Input
              id="swarm-cooling-ceilingHours"
              inputMode="numeric"
              placeholder={String(SWARM_COOLDOWN_CEILING_HOURS_DEFAULT)}
              value={numbers.cooldownCeilingHours}
              onChange={(event) => setDraft({ ...numbers, cooldownCeilingHours: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t("swarmClaim.cooling.ceilingHelp")}</p>
            {parsed.errors.cooldownCeilingHours ? (
              <p className="text-xs text-destructive" data-testid="swarm-cooling-error-ceilingHours">
                {t(parsed.errors.cooldownCeilingHours)}
              </p>
            ) : null}
          </div>

          <div className="md:col-span-2">
            <Button
              type="button"
              size="sm"
              disabled={saving || parsed.hasErrors}
              onClick={() => onSave(parsed.patch)}
              data-testid="swarm-cooling-save"
            >
              {saving ? t("swarmClaim.saving") : t("swarmClaim.cooling.save")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

export function SwarmClaimSettingsPanel() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
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
      setError(err instanceof Error ? err.message : t("swarmClaim.saveFailed")),
    onSuccess: async (data) => {
      setError(null);
      setReleasedNote(
        typeof data.releasedClaims === "number" && data.releasedClaims > 0
          ? t("swarmClaim.releasedNote", { released: data.releasedClaims })
          : null,
      );
      await queryClient.invalidateQueries({ queryKey: swarmClaimSettingsQueryKey });
    },
  });

  // myrmidon(OPE-6894): the cooling block reads and writes `general.swarm`
  // through the instance-general settings API. `updateGeneral` merges over
  // the stored document under a row lock, so `general.swarmClaim` survives.
  const [coolingError, setCoolingError] = useState<string | null>(null);
  const [coolingSavedNote, setCoolingSavedNote] = useState<string | null>(null);
  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    retry: false,
  });
  const coolingSave = useMutation({
    mutationFn: (swarm: SwarmSettings) => instanceSettingsApi.updateGeneral({ swarm }),
    onMutate: () => {
      setCoolingError(null);
      setCoolingSavedNote(null);
    },
    onError: (err) =>
      setCoolingError(err instanceof Error ? err.message : t("swarmClaim.cooling.saveFailed")),
    onSuccess: async () => {
      setCoolingError(null);
      setCoolingSavedNote(t("swarmClaim.cooling.savedNote"));
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : t("swarmClaim.loadFailed")}
      </div>
    );
  }

  const banner = error ?? releasedNote;
  const coolingBanner = coolingError ?? coolingSavedNote;

  return (
    <>
      <SwarmClaimSettingsPanelView
        view={query.data}
        status={swarmClaimStatusLine(query.data?.counters, (key, options) => t(key, options))}
        onSave={(patch) => save.mutate(patch)}
        pending={save.isPending}
        error={banner}
      />
      <SwarmCoolingSettingsPanelView
        swarm={generalQuery.data?.swarm}
        loading={generalQuery.isLoading}
        saving={coolingSave.isPending}
        error={coolingBanner}
        onSave={(swarm) => coolingSave.mutate(swarm)}
      />
    </>
  );
}

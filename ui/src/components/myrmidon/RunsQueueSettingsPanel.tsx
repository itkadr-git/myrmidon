// myrmidon(1.7, OPE-4096, SETTINGS-TO-UI B): the Runs & Queue settings tab of
// the instance settings. It shows the behavior keys of the section
// "runs-queue" from the part A registry and writes through the behavior-settings
// API; a set env var is a forced override and the field is shown read-only
// with a hint.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import { behaviorSettingsApi, behaviorSettingsQueryKey, sourceLabel, type BehaviorSettingValue } from "./behaviorSettingsApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

const BOOLEAN_KEYS = [
  "runsQueue.idlePickup.enabled",
  "runsQueue.runStall.enabled",
  "runsQueue.autoResume.enabled",
  "runsQueue.pauseDrains.enabled",
  "runsQueue.skipIdleHeartbeats.enabled",
  "runsQueue.strandedAutopolicy.enabled",
  "runsQueue.settledHolds.blockExplicitWakes",
  "runsQueue.writeLock.requiresLiveRun",
  "runsQueue.taskPrSync.enabled",
] as const;

const NUMBER_KEYS = [
  "runsQueue.idlePickup.wakeBudgetPerMin",
  "runsQueue.idlePickup.wakeBatch",
  "runsQueue.idlePickup.intervalSec",
  "runsQueue.idlePickup.recentSuccessWindowMs",
  "runsQueue.runStall.thresholdSec",
  "runsQueue.autoResume.maxAttempts",
  "runsQueue.autoResume.intervalSec",
  "runsQueue.autoResume.windowMs",
  "runsQueue.pauseResumeWake.batch",
  "runsQueue.pauseResumeWake.batchPauseMs",
  "runsQueue.pendingInteractionWake.graceMs",
  "runsQueue.pendingInteractionWake.reAdmissions",
  "runsQueue.outboxSweep.ageMs",
  "runsQueue.strandedAutopolicy.autoRetriesPerDay",
  "runsQueue.crossIssueInfluence.limit",
  "runsQueue.continuationHistory.limit",
  "runsQueue.staleLease.graceMs",
  "runsQueue.swarm.supervisorTaskMax",
  "runsQueue.dbBackup.catchupWindow",
  "runsQueue.workspaceHygiene.mergedCooldownMs",
  "runsQueue.workspaceHygiene.stuckSignalAfterMs",
] as const;

const STRING_KEYS = [
  "runsQueue.autoResume.backoffMs",
  "runsQueue.infraInterrupt.codes",
  "runsQueue.swarm.pilotBaselineDoc",
] as const;

const RUNS_QUEUE_KEYS = [...BOOLEAN_KEYS, ...NUMBER_KEYS, ...STRING_KEYS] as const;

const LABELS: Record<(typeof RUNS_QUEUE_KEYS)[number], string> = {
  "runsQueue.idlePickup.wakeBudgetPerMin": "Idle pickup wake budget per minute",
  "runsQueue.idlePickup.wakeBatch": "Idle pickup wake batch size",
  "runsQueue.idlePickup.enabled": "Idle pickup enabled",
  "runsQueue.idlePickup.intervalSec": "Idle pickup interval, sec",
  "runsQueue.idlePickup.recentSuccessWindowMs": "Recent success window, ms",
  "runsQueue.runStall.enabled": "Run stall detection enabled",
  "runsQueue.runStall.thresholdSec": "Run stall threshold, sec",
  "runsQueue.autoResume.enabled": "Auto resume enabled",
  "runsQueue.autoResume.maxAttempts": "Auto resume max attempts",
  "runsQueue.autoResume.intervalSec": "Auto resume interval, sec",
  "runsQueue.autoResume.windowMs": "Auto resume window, ms",
  "runsQueue.autoResume.backoffMs": "Auto resume backoff, ms (comma-separated)",
  "runsQueue.pauseDrains.enabled": "Pause drains enabled",
  "runsQueue.pauseResumeWake.batch": "Resume wake batch size",
  "runsQueue.pauseResumeWake.batchPauseMs": "Resume wake batch pause, ms",
  "runsQueue.skipIdleHeartbeats.enabled": "Skip idle heartbeats",
  "runsQueue.pendingInteractionWake.graceMs": "Pending interaction grace, ms",
  "runsQueue.pendingInteractionWake.reAdmissions": "Pending interaction re-admissions",
  "runsQueue.outboxSweep.ageMs": "Outbox sweep age, ms",
  "runsQueue.strandedAutopolicy.enabled": "Stranded auto-policy enabled",
  "runsQueue.strandedAutopolicy.autoRetriesPerDay": "Stranded auto-retries per day",
  "runsQueue.settledHolds.blockExplicitWakes": "Settled holds block explicit wakes",
  "runsQueue.infraInterrupt.codes": "Infra interrupt codes (comma-separated)",
  "runsQueue.writeLock.requiresLiveRun": "Write lock requires live run",
  "runsQueue.crossIssueInfluence.limit": "Cross-issue influence limit",
  "runsQueue.continuationHistory.limit": "Continuation history limit",
  "runsQueue.staleLease.graceMs": "Stale lease grace, ms",
  "runsQueue.taskPrSync.enabled": "Task PR sync enabled",
  "runsQueue.swarm.supervisorTaskMax": "Swarm supervisor task max",
  "runsQueue.swarm.pilotBaselineDoc": "Swarm pilot baseline doc",
  "runsQueue.dbBackup.catchupWindow": "DB backup catch-up window",
  "runsQueue.workspaceHygiene.mergedCooldownMs": "Workspace merged cooldown, ms",
  "runsQueue.workspaceHygiene.stuckSignalAfterMs": "Workspace stuck signal after, ms",
};

export function RunsQueueSettingsPanel() {
  const queryClient = useQueryClient();
  const [localValues, setLocalValues] = useState<Record<string, unknown>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const query = useQuery({
    queryKey: behaviorSettingsQueryKey,
    queryFn: behaviorSettingsApi.get,
  });

  const updateMutation = useMutation({
    mutationFn: (patch: Record<string, BehaviorSettingValue>) =>
      behaviorSettingsApi.update(patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: behaviorSettingsQueryKey });
    },
  });

  if (query.isLoading) {
    return (
      <section className="space-y-4" data-testid="myrmidon-runs-queue-settings">
        <h2 className="text-sm font-semibold">Runs &amp; Queue</h2>
        <p className="text-sm text-muted-foreground">Loading settings...</p>
      </section>
    );
  }

  if (query.error || !query.data) {
    return (
      <section className="space-y-4" data-testid="myrmidon-runs-queue-settings">
        <h2 className="text-sm font-semibold">Runs &amp; Queue</h2>
        <p role="alert" className="text-sm text-destructive">Failed to load settings.</p>
      </section>
    );
  }

  const { settings, sources } = query.data;

  const renderField = (key: (typeof RUNS_QUEUE_KEYS)[number]) => {
    const label = LABELS[key] ?? key;
    const source = sources[key];
    const isEnv = source === "env";
    const rawVal = localValues[key] !== undefined ? localValues[key] : settings[key];

    const sourceDesc = sourceLabel(source, {
      env: "env override",
      ui: "saved",
      default: "default",
    });

    if ((BOOLEAN_KEYS as readonly string[]).includes(key)) {
      const checked = Boolean(rawVal);
      return (
        <div key={key} className="flex items-center justify-between gap-4 py-2">
          <div>
            <Label htmlFor={key} className="text-sm font-normal">
              {label}
            </Label>
            <p className="text-xs text-muted-foreground">{sourceDesc}</p>
          </div>
          <ToggleSwitch
            id={key}
            checked={checked}
            disabled={isEnv || savingKey === key}
            onCheckedChange={(checkedVal) => {
              setLocalValues((prev) => ({ ...prev, [key]: checkedVal }));
              setSavingKey(key);
              updateMutation.mutate({ [key]: checkedVal }, {
                onSettled: () => setSavingKey(null),
              });
            }}
          />
        </div>
      );
    }

    if ((NUMBER_KEYS as readonly string[]).includes(key)) {
      const numVal = typeof rawVal === "number" ? rawVal : Number(rawVal) || 0;
      return (
        <div key={key} className="flex items-center justify-between gap-4 py-2">
          <div>
            <Label htmlFor={key} className="text-sm font-normal">
              {label}
            </Label>
            <p className="text-xs text-muted-foreground">{sourceDesc}</p>
          </div>
          <Input
            id={key}
            type="number"
            className="w-28 text-right"
            value={numVal}
            disabled={isEnv || savingKey === key}
            onChange={(e) => {
              const next = Number(e.target.value);
              setLocalValues((prev) => ({ ...prev, [key]: next }));
            }}
            onBlur={() => {
              if (numVal !== settings[key]) {
                setSavingKey(key);
                updateMutation.mutate({ [key]: numVal }, {
                  onSettled: () => setSavingKey(null),
                });
              }
            }}
          />
        </div>
      );
    }

    // string / json list
    const displayValue = Array.isArray(rawVal) ? rawVal.join(", ") : String(rawVal ?? "");
    return (
      <div key={key} className="flex items-center justify-between gap-4 py-2">
        <div>
          <Label htmlFor={key} className="text-sm font-normal">
            {label}
          </Label>
          <p className="text-xs text-muted-foreground">{sourceDesc}</p>
        </div>
        <Input
          id={key}
          className="w-56 text-right"
          value={displayValue}
          disabled={isEnv || savingKey === key}
          onChange={(e) => {
            setLocalValues((prev) => ({ ...prev, [key]: e.target.value }));
          }}
          onBlur={() => {
            if (rawVal !== settings[key]) {
              const next: BehaviorSettingValue = key === "runsQueue.infraInterrupt.codes" ||
                           key === "runsQueue.autoResume.backoffMs"
                ? String(rawVal).split(",").map((s) => s.trim()).filter(Boolean)
                : (rawVal as BehaviorSettingValue);
              setSavingKey(key);
              updateMutation.mutate({ [key]: next }, {
                onSettled: () => setSavingKey(null),
              });
            }
          }}
        />
      </div>
    );
  };

  const coreKeys = RUNS_QUEUE_KEYS.filter((k) =>
    k.startsWith("runsQueue.idlePickup.") ||
    k.startsWith("runsQueue.runStall.") ||
    k.startsWith("runsQueue.autoResume.") ||
    k.startsWith("runsQueue.pauseDrains.") ||
    k.startsWith("runsQueue.pauseResumeWake.") ||
    k.startsWith("runsQueue.taskPrSync.") ||
    k.startsWith("runsQueue.strandedAutopolicy.") ||
    k.startsWith("runsQueue.settledHolds."),
  );
  const tuningKeys = RUNS_QUEUE_KEYS.filter((k) =>
    !coreKeys.includes(k as never),
  );

  return (
    <section className="space-y-6" data-testid="myrmidon-runs-queue-settings">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Runs &amp; Queue</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Idle pickup, run stall detection, auto resume, pause/wake drains, stranded policy,
          outbox sweeps, task-pr-sync, swarm supervisor, backup catch-up, and workspace hygiene.
          Changes apply without a restart; an env var set on the host overrides the UI value.
        </p>
      </div>

      <div className="space-y-4">
        <h3 className="text-sm font-medium">Core switches</h3>
        <div className="divide-y rounded-md border px-3">{coreKeys.map(renderField)}</div>
      </div>

      <div className="space-y-4">
        <h3 className="text-sm font-medium">Advanced tuning</h3>
        <div className="divide-y rounded-md border px-3">{tuningKeys.map(renderField)}</div>
      </div>
    </section>
  );
}

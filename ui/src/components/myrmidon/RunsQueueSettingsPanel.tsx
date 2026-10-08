// myrmidon(1.7, OPE-4096, SETTINGS-TO-UI B): the Runs & Queue settings tab of
// the instance settings. It shows the behavior keys of the section
// "runs-queue" from the part A registry (idle pickup, run stall, auto resume,
// pause/wake, stranded policy, outbox sweeps, task-pr-sync, swarm supervisor,
// backup catch-up, workspace hygiene) and writes through the behavior-settings
// API; a set env var is a forced override and the field is shown read-only
// with a hint.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

interface BehaviorSettingValue {
  key: string;
  envName: string;
  value: unknown;
  source: "ui" | "env" | "default";
  default: unknown;
  scope: string;
  section: string;
  valueType: "boolean" | "string" | "number" | "json";
}

const RUNS_QUEUE_KEYS = [
  "runsQueue.idlePickup.enabled",
  "runsQueue.idlePickup.intervalSec",
  "runsQueue.idlePickup.recentSuccessWindowMs",
  "runsQueue.runStall.enabled",
  "runsQueue.runStall.thresholdSec",
  "runsQueue.autoResume.enabled",
  "runsQueue.autoResume.attempts",
  "runsQueue.autoResume.intervalSec",
  "runsQueue.autoResume.seriesWindowMs",
  "runsQueue.autoResume.backoffMs",
  "runsQueue.pauseDrains.enabled",
  "runsQueue.pauseDrains.resumeWakeBatch",
  "runsQueue.pauseDrains.pauseMs",
  "runsQueue.wake.skipIdleHeartbeats",
  "runsQueue.wake.pendingInteractionGraceMs",
  "runsQueue.wake.pendingInteractionReAdmissions",
  "runsQueue.outbox.sweepAgeMs",
  "runsQueue.stranded.autoPolicy",
  "runsQueue.stranded.autoRetriesPerDay",
  "runsQueue.stranded.settledHoldsBlockExplicitWakes",
  "runsQueue.pipeline.infraInterruptCodes",
  "runsQueue.pipeline.writeLockRequiresLiveRun",
  "runsQueue.pipeline.crossIssueInfluenceLimit",
  "runsQueue.pipeline.continuationHistoryLimit",
  "runsQueue.pipeline.staleLeaseGraceMs",
  "runsQueue.taskPrSync.enabled",
  "runsQueue.swarm.supervisorTaskMax",
  "runsQueue.swarm.pilotBaselineDoc",
  "runsQueue.dbBackup.catchupWindow",
  "runsQueue.workspaceHygiene.mergedCooldownMs",
  "runsQueue.workspaceHygiene.stuckSignalAfterMs",
] as const;

const LABELS: Record<(typeof RUNS_QUEUE_KEYS)[number], string> = {
  "runsQueue.idlePickup.enabled": "Idle pickup enabled",
  "runsQueue.idlePickup.intervalSec": "Idle pickup interval, sec",
  "runsQueue.idlePickup.recentSuccessWindowMs": "Recent success window, ms",
  "runsQueue.runStall.enabled": "Run stall detection enabled",
  "runsQueue.runStall.thresholdSec": "Run stall threshold, sec",
  "runsQueue.autoResume.enabled": "Auto resume enabled",
  "runsQueue.autoResume.attempts": "Auto resume attempts",
  "runsQueue.autoResume.intervalSec": "Auto resume interval, sec",
  "runsQueue.autoResume.seriesWindowMs": "Auto resume series window, ms",
  "runsQueue.autoResume.backoffMs": "Auto resume backoff, ms (comma-separated)",
  "runsQueue.pauseDrains.enabled": "Pause drains enabled",
  "runsQueue.pauseDrains.resumeWakeBatch": "Resume wake batch size",
  "runsQueue.pauseDrains.pauseMs": "Pause duration, ms",
  "runsQueue.wake.skipIdleHeartbeats": "Skip idle heartbeats",
  "runsQueue.wake.pendingInteractionGraceMs": "Pending interaction grace, ms",
  "runsQueue.wake.pendingInteractionReAdmissions": "Pending interaction re-admissions",
  "runsQueue.outbox.sweepAgeMs": "Outbox sweep age, ms",
  "runsQueue.stranded.autoPolicy": "Stranded auto-policy enabled",
  "runsQueue.stranded.autoRetriesPerDay": "Stranded auto-retries per day",
  "runsQueue.stranded.settledHoldsBlockExplicitWakes": "Settled holds block explicit wakes",
  "runsQueue.pipeline.infraInterruptCodes": "Infra interrupt codes (comma-separated)",
  "runsQueue.pipeline.writeLockRequiresLiveRun": "Write lock requires live run",
  "runsQueue.pipeline.crossIssueInfluenceLimit": "Cross-issue influence limit",
  "runsQueue.pipeline.continuationHistoryLimit": "Continuation history limit",
  "runsQueue.pipeline.staleLeaseGraceMs": "Stale lease grace, ms",
  "runsQueue.taskPrSync.enabled": "Task PR sync enabled",
  "runsQueue.swarm.supervisorTaskMax": "Swarm supervisor task max",
  "runsQueue.swarm.pilotBaselineDoc": "Swarm pilot baseline doc",
  "runsQueue.dbBackup.catchupWindow": "DB backup catch-up window",
  "runsQueue.workspaceHygiene.mergedCooldownMs": "Workspace merged cooldown, ms",
  "runsQueue.workspaceHygiene.stuckSignalAfterMs": "Workspace stuck signal after, ms",
};

function behaviorSettingsQueryKey() {
  return ["myrmidon", "behavior-settings", "runs-queue"] as const;
}

export function RunsQueueSettingsPanel() {
  const queryClient = useQueryClient();
  const [localValues, setLocalValues] = useState<Record<string, unknown>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const behaviorQuery = useQuery({
    queryKey: behaviorSettingsQueryKey(),
    queryFn: () => api.get<{ values: BehaviorSettingValue[] }>("/myrmidon/behavior-settings"),
  });

  const updateMutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch<{ ok: boolean }>("/myrmidon/behavior-settings", patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: behaviorSettingsQueryKey() });
    },
  });

  useEffect(() => {
    if (behaviorQuery.data) {
      const map: Record<string, unknown> = {};
      for (const item of behaviorQuery.data.values) {
        if ((RUNS_QUEUE_KEYS as readonly string[]).includes(item.key)) {
          map[item.key] = item.value;
        }
      }
      setLocalValues(map);
    }
  }, [behaviorQuery.data]);

  const runsQueueValues = (behaviorQuery.data?.values ?? []).filter((v) =>
    (RUNS_QUEUE_KEYS as readonly string[]).includes(v.key),
  );

  const renderField = (item: BehaviorSettingValue) => {
    const label = LABELS[item.key as (typeof RUNS_QUEUE_KEYS)[number]] ?? item.key;
    const isEnv = item.source === "env";
    const value = localValues[item.key] ?? item.value;

    if (item.valueType === "boolean") {
      return (
        <div key={item.key} className="flex items-center justify-between gap-4 py-2">
          <Label htmlFor={item.key} className="text-sm font-normal">
            {label}
            {isEnv ? <span className="ml-2 text-xs text-muted-foreground">(env override)</span> : null}
          </Label>
          <ToggleSwitch
            id={item.key}
            checked={value === true}
            disabled={isEnv || savingKey === item.key}
            onCheckedChange={(checked) => {
              setLocalValues((prev) => ({ ...prev, [item.key]: checked }));
              setSavingKey(item.key);
              updateMutation.mutate({ [item.key]: checked }, {
                onSettled: () => setSavingKey(null),
              });
            }}
          />
        </div>
      );
    }

    if (item.valueType === "number") {
      return (
        <div key={item.key} className="flex items-center justify-between gap-4 py-2">
          <Label htmlFor={item.key} className="text-sm font-normal">
            {label}
            {isEnv ? <span className="ml-2 text-xs text-muted-foreground">(env override)</span> : null}
          </Label>
          <Input
            id={item.key}
            type="number"
            className="w-28 text-right"
            value={typeof value === "number" ? value : Number(value) || 0}
            disabled={isEnv || savingKey === item.key}
            onChange={(e) => {
              const next = Number(e.target.value);
              setLocalValues((prev) => ({ ...prev, [item.key]: next }));
            }}
            onBlur={() => {
              if (value !== item.value) {
                setSavingKey(item.key);
                updateMutation.mutate({ [item.key]: value }, {
                  onSettled: () => setSavingKey(null),
                });
              }
            }}
          />
        </div>
      );
    }

    // json / string
    const displayValue = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    return (
      <div key={item.key} className="flex items-center justify-between gap-4 py-2">
        <Label htmlFor={item.key} className="text-sm font-normal">
          {label}
          {isEnv ? <span className="ml-2 text-xs text-muted-foreground">(env override)</span> : null}
        </Label>
        <Input
          id={item.key}
          className="w-56 text-right"
          value={displayValue}
          disabled={isEnv || savingKey === item.key}
          onChange={(e) => {
            setLocalValues((prev) => ({ ...prev, [item.key]: e.target.value }));
          }}
          onBlur={() => {
            if (value !== item.value) {
              const next = item.key === "runsQueue.pipeline.infraInterruptCodes" ||
                           item.key === "runsQueue.autoResume.backoffMs"
                ? String(value).split(",").map((s) => s.trim()).filter(Boolean)
                : value;
              setSavingKey(item.key);
              updateMutation.mutate({ [item.key]: next }, {
                onSettled: () => setSavingKey(null),
              });
            }
          }}
        />
      </div>
    );
  };

  const coreKeys = runsQueueValues.filter((v) =>
    v.key.startsWith("runsQueue.idlePickup.") ||
    v.key.startsWith("runsQueue.runStall.") ||
    v.key.startsWith("runsQueue.autoResume.") ||
    v.key.startsWith("runsQueue.pauseDrains.") ||
    v.key.startsWith("runsQueue.taskPrSync.") ||
    v.key.startsWith("runsQueue.stranded."),
  );
  const tuningKeys = runsQueueValues.filter((v) =>
    !coreKeys.some((c) => c.key === v.key),
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

// myrmidon(1.7, OPE-4096, SETTINGS-TO-UI B): the Runs & Queue settings tab of
// the instance settings. It shows the behavior keys of the section
// "runs-queue" from the part A registry (idle pickup, run stall, auto resume,
// pause/wake, stranded policy, outbox sweeps, task-pr-sync, swarm supervisor,
// backup catch-up, workspace hygiene) and writes through the behavior-settings
// API; a set env var is a forced override and the field is shown read-only
// with a hint.
//
// myrmidon(1.6.7 SETTINGS-GENERAL-CRASH): the server answers
// `{ settings, sources }` (the shared behaviorSettingsApi contract); this tab
// read a `values[]` array instead, and the effect that walked it threw on every
// open, which dropped the whole Settings -> General page to the error screen.
// The tab now reads the shared contract through `readRunsQueueItems`, which
// never throws, and a failed or unexpected response is shown as an error
// inside the panel.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useTranslation } from "@/i18n";
import {
  behaviorSettingsApi,
  behaviorSettingsQueryKey,
  type BehaviorSettingValue,
} from "./behaviorSettingsApi";
import { describeSettingsError } from "./settingsErrors";
import {
  formatRunsQueueValue,
  parseRunsQueueInput,
  readRunsQueueItems,
  runsQueueValueChanged,
  type RunsQueueItem,
  type RunsQueueKey,
} from "./runsQueueSettingsModel";

const LABELS: Record<RunsQueueKey, string> = {
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

const CORE_PREFIXES = [
  "runsQueue.idlePickup.",
  "runsQueue.runStall.",
  "runsQueue.autoResume.",
  "runsQueue.pauseDrains.",
  "runsQueue.pauseResumeWake.",
  "runsQueue.taskPrSync.",
  "runsQueue.strandedAutopolicy.",
  "runsQueue.settledHolds.",
];

export interface RunsQueueSettingsPanelViewProps {
  /** The `GET /myrmidon/behavior-settings` body as served (unknown until read; undefined while loading). */
  data: unknown;
  /** The error of that request, if it failed. */
  error?: unknown;
  /** Typed-but-unsaved text per key, or the just-toggled boolean until it is saved. */
  drafts?: Record<string, unknown>;
  /** The key whose typed text did not parse, if any. */
  invalidKey?: string | null;
  savingKey?: string | null;
  saveError?: string | null;
  onDraft?: (key: RunsQueueKey, value: unknown) => void;
  onCommitText?: (item: RunsQueueItem) => void;
  onToggle?: (key: RunsQueueKey, checked: boolean) => void;
}

/**
 * The panel body. It reads `data` through `readRunsQueueItems`, so a body of
 * any shape (the old `values[]`, an array, null, a string) renders as an error
 * inside the panel and never throws into the page.
 */
export function RunsQueueSettingsPanelView({
  data,
  error = null,
  drafts = {},
  invalidKey = null,
  savingKey = null,
  saveError = null,
  onDraft,
  onCommitText,
  onToggle,
}: RunsQueueSettingsPanelViewProps) {
  const { t } = useTranslation();

  // null: the response is not the `{ settings, sources }` shape.
  const items = useMemo(() => (data === undefined ? null : readRunsQueueItems(data)), [data]);
  const unexpectedShape = data !== undefined && items === null;

  const renderField = (item: RunsQueueItem) => {
    const label = LABELS[item.key] ?? item.key;
    const isEnv = item.source === "env";
    const disabled = isEnv || savingKey === item.key;
    const envHint = isEnv ? <span className="ml-2 text-xs text-muted-foreground">(env override)</span> : null;

    if (item.valueType === "boolean") {
      return (
        <div key={item.key} className="flex items-center justify-between gap-4 py-2">
          <Label htmlFor={item.key} className="text-sm font-normal">
            {label}
            {envHint}
          </Label>
          <ToggleSwitch
            id={item.key}
            checked={(drafts[item.key] ?? item.value) === true}
            disabled={disabled}
            onCheckedChange={(checked) => onToggle?.(item.key, checked)}
          />
        </div>
      );
    }

    const typed = drafts[item.key];
    const text = typeof typed === "string" ? typed : formatRunsQueueValue(item.value);
    const isNumber = item.valueType === "number";
    return (
      <div key={item.key} className="flex items-center justify-between gap-4 py-2">
        <Label htmlFor={item.key} className="text-sm font-normal">
          {label}
          {envHint}
        </Label>
        <Input
          id={item.key}
          type={isNumber ? "number" : "text"}
          className={isNumber ? "w-28 text-right" : "w-56 text-right"}
          value={text}
          aria-invalid={invalidKey === item.key ? true : undefined}
          disabled={disabled}
          onChange={(e) => onDraft?.(item.key, e.target.value)}
          onBlur={() => onCommitText?.(item)}
        />
      </div>
    );
  };

  const coreItems = (items ?? []).filter((v) => CORE_PREFIXES.some((prefix) => v.key.startsWith(prefix)));
  const tuningItems = (items ?? []).filter((v) => !coreItems.some((c) => c.key === v.key));

  const loadError = error
    ? describeSettingsError(error, t, "runQueue.behaviorLoadFailed")
    : unexpectedShape
      ? String(t("runQueue.behaviorBadShape"))
      : null;

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

      {loadError ? (
        <div role="alert" className="text-sm text-destructive" data-testid="runs-queue-settings-error">
          {loadError}
        </div>
      ) : (
        <>
          {saveError ? (
            <div role="alert" className="text-sm text-destructive" data-testid="runs-queue-settings-save-error">
              {saveError}
            </div>
          ) : null}
          {invalidKey ? (
            <div role="alert" className="text-sm text-destructive" data-testid="runs-queue-settings-invalid">
              {String(t("runQueue.behaviorInvalid"))}
            </div>
          ) : null}
          {items !== null && items.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="runs-queue-settings-empty">
              {String(t("runQueue.behaviorEmpty"))}
            </p>
          ) : null}

          <div className="space-y-4">
            <h3 className="text-sm font-medium">Core switches</h3>
            <div className="divide-y rounded-md border px-3">{coreItems.map(renderField)}</div>
          </div>

          <div className="space-y-4">
            <h3 className="text-sm font-medium">Advanced tuning</h3>
            <div className="divide-y rounded-md border px-3">{tuningItems.map(renderField)}</div>
          </div>
        </>
      )}
    </section>
  );
}

export function RunsQueueSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [invalidKey, setInvalidKey] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The shared behavior-settings query: the same request the Guardrails and
  // Input-limit panels make.
  const behaviorQuery = useQuery({
    queryKey: behaviorSettingsQueryKey,
    queryFn: behaviorSettingsApi.get,
  });

  const updateMutation = useMutation({
    mutationFn: (patch: Record<string, BehaviorSettingValue>) => behaviorSettingsApi.update(patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: behaviorSettingsQueryKey });
    },
  });

  const dropDraft = (key: string) =>
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const commit = (key: RunsQueueKey, value: unknown) => {
    setSavingKey(key);
    setSaveError(null);
    updateMutation.mutate({ [key]: value as BehaviorSettingValue }, {
      onError: (err) => setSaveError(describeSettingsError(err, t, "runQueue.behaviorSaveFailed")),
      onSettled: () => {
        setSavingKey(null);
        dropDraft(key);
      },
    });
  };

  const commitText = (item: RunsQueueItem) => {
    const raw = drafts[item.key];
    if (typeof raw !== "string") return;
    const parsed = parseRunsQueueInput(item, raw);
    if (!parsed.ok) {
      setInvalidKey(item.key);
      return;
    }
    setInvalidKey(null);
    if (!runsQueueValueChanged(item.value, parsed.value)) {
      dropDraft(item.key);
      return;
    }
    commit(item.key, parsed.value);
  };

  return (
    <RunsQueueSettingsPanelView
      data={behaviorQuery.data}
      error={behaviorQuery.error}
      drafts={drafts}
      invalidKey={invalidKey}
      savingKey={savingKey}
      saveError={saveError}
      onDraft={(key, value) => {
        if (invalidKey === key) setInvalidKey(null);
        setDrafts((prev) => ({ ...prev, [key]: value }));
      }}
      onCommitText={commitText}
      onToggle={(key, checked) => {
        setDrafts((prev) => ({ ...prev, [key]: checked }));
        commit(key, checked);
      }}
    />
  );
}

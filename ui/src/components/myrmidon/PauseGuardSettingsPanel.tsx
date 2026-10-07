// Forgotten-pause guard (myrmidon 1.6.5 PAUSE-GUARD): the settings block that
// sits next to "Run limits" on the instance settings page.
//
// The guard lifts operator pauses that were left behind: an agent that is
// paused with the operator's own reason and has been paused longer than the
// threshold is resumed, so its queued runs and stranded tasks come back to
// life. Pauses the board set for its own reasons (budget, archive, import) are
// never touched. Saving applies the values at the guard's next pass — no
// restart, no run in flight is dropped.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClockCheck } from "lucide-react";
import {
  MAX_PAUSE_GUARD_INTERVAL_SEC,
  MAX_PAUSE_GUARD_MAX_RESUMES_PER_PASS,
  MAX_PAUSE_GUARD_THRESHOLD_MINUTES,
  MIN_PAUSE_GUARD_INTERVAL_SEC,
  MIN_PAUSE_GUARD_MAX_RESUMES_PER_PASS,
  MIN_PAUSE_GUARD_THRESHOLD_MINUTES,
  type PauseGuardSettings,
  type PauseGuardSettingsPatch,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  describePauseGuardSource,
  formatAllowlist,
  parseAllowlistDraft,
  pauseGuardApi,
  pauseGuardQueryKey,
  type PauseGuardView,
} from "./pauseGuardApi";

export interface PauseGuardDraft {
  enabled: boolean;
  thresholdMinutes: string;
  intervalSec: string;
  allowlist: string;
  maxResumesPerPass: string;
}

export function toPauseGuardDraft(settings: PauseGuardSettings): PauseGuardDraft {
  return {
    enabled: settings.enabled,
    thresholdMinutes: String(settings.thresholdMinutes),
    intervalSec: String(settings.intervalSec),
    allowlist: formatAllowlist(settings.allowlist),
    maxResumesPerPass: String(settings.maxResumesPerPass),
  };
}

interface PauseGuardDraftParse {
  patch: PauseGuardSettingsPatch | null;
  errors: Partial<Record<keyof PauseGuardDraft, string>>;
}

function wholeNumber(
  raw: string,
  min: number,
  max: number,
): { value: number | null; error: string | null } {
  const text = raw.trim();
  if (!text) return { value: null, error: "Required" };
  if (!/^\d+$/.test(text)) {
    return { value: null, error: `Enter a whole number between ${min} and ${max}` };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { value: null, error: `Enter a whole number between ${min} and ${max}` };
  }
  return { value, error: null };
}

/** Validate the edited block into an API patch; nothing is sent while a field is wrong. */
export function parsePauseGuardDraft(draft: PauseGuardDraft): PauseGuardDraftParse {
  const errors: Partial<Record<keyof PauseGuardDraft, string>> = {};
  const threshold = wholeNumber(
    draft.thresholdMinutes,
    MIN_PAUSE_GUARD_THRESHOLD_MINUTES,
    MAX_PAUSE_GUARD_THRESHOLD_MINUTES,
  );
  if (threshold.error) errors.thresholdMinutes = threshold.error;
  const interval = wholeNumber(
    draft.intervalSec,
    MIN_PAUSE_GUARD_INTERVAL_SEC,
    MAX_PAUSE_GUARD_INTERVAL_SEC,
  );
  if (interval.error) errors.intervalSec = interval.error;
  const perPass = wholeNumber(
    draft.maxResumesPerPass,
    MIN_PAUSE_GUARD_MAX_RESUMES_PER_PASS,
    MAX_PAUSE_GUARD_MAX_RESUMES_PER_PASS,
  );
  if (perPass.error) errors.maxResumesPerPass = perPass.error;

  if (Object.keys(errors).length > 0) return { patch: null, errors };
  return {
    patch: {
      enabled: draft.enabled,
      thresholdMinutes: threshold.value!,
      intervalSec: interval.value!,
      allowlist: parseAllowlistDraft(draft.allowlist),
      maxResumesPerPass: perPass.value!,
    },
    errors,
  };
}

export function PauseGuardSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: PauseGuardView | null | undefined;
  onSave: (patch: PauseGuardSettingsPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const [draft, setDraft] = useState<PauseGuardDraft | null>(null);
  const current = draft ?? (view ? toPauseGuardDraft(view.settings) : null);
  const { patch, errors } = current
    ? parsePauseGuardDraft(current)
    : { patch: null, errors: {} as Partial<Record<keyof PauseGuardDraft, string>> };
  const dirty =
    draft !== null &&
    view !== null &&
    view !== undefined &&
    JSON.stringify(parsePauseGuardDraft(toPauseGuardDraft(view.settings)).patch) !==
      JSON.stringify(patch);

  return (
    <section className="space-y-4" data-testid="myrmidon-pause-guard">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <AlarmClockCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Forgotten pauses</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          The board resumes agents that an operator paused and left paused longer than the threshold, so their queued runs and
          stranded tasks come back on their own. Pauses the board sets for its own reasons — budget, archived company, import —
          are never lifted, and names on the allowlist are skipped. Saving takes effect at the next pass; nothing is restarted.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view && current ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="pause-guard-enabled">Guard is on</Label>
            <div className="flex items-center gap-2">
              <ToggleSwitch
                id="pause-guard-enabled"
                checked={current.enabled}
                onCheckedChange={(checked) => setDraft({ ...current, enabled: checked })}
              />
              <span data-testid="pause-guard-source-enabled" className="text-xs text-muted-foreground">
                {describePauseGuardSource(view.sources.enabled)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Switched off, no pause is ever lifted automatically: an operator resume is the only way back.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="pause-guard-threshold">Pause longer than, minutes</Label>
            <Input
              id="pause-guard-threshold"
              inputMode="numeric"
              value={current.thresholdMinutes}
              onChange={(event) => setDraft({ ...current, thresholdMinutes: event.target.value })}
            />
            <div className="text-xs text-muted-foreground">
              <span data-testid="pause-guard-source-thresholdMinutes">
                {describePauseGuardSource(view.sources.thresholdMinutes)}
              </span>
              {errors.thresholdMinutes ? (
                <span className="ml-2 text-destructive">{errors.thresholdMinutes}</span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              A pause older than this is treated as forgotten. Default 20 minutes.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="pause-guard-interval">Check every, seconds</Label>
            <Input
              id="pause-guard-interval"
              inputMode="numeric"
              value={current.intervalSec}
              onChange={(event) => setDraft({ ...current, intervalSec: event.target.value })}
            />
            <div className="text-xs text-muted-foreground">
              <span data-testid="pause-guard-source-intervalSec">
                {describePauseGuardSource(view.sources.intervalSec)}
              </span>
              {errors.intervalSec ? <span className="ml-2 text-destructive">{errors.intervalSec}</span> : null}
            </div>
            <p className="text-xs text-muted-foreground">
              How often the board looks for forgotten pauses. Default 600 (every 10 minutes).
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="pause-guard-max">Resumes per pass, at most</Label>
            <Input
              id="pause-guard-max"
              inputMode="numeric"
              value={current.maxResumesPerPass}
              onChange={(event) => setDraft({ ...current, maxResumesPerPass: event.target.value })}
            />
            <div className="text-xs text-muted-foreground">
              <span data-testid="pause-guard-source-maxResumesPerPass">
                {describePauseGuardSource(view.sources.maxResumesPerPass)}
              </span>
              {errors.maxResumesPerPass ? (
                <span className="ml-2 text-destructive">{errors.maxResumesPerPass}</span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              A ceiling on one pass, so a fleet-wide resume does not start every backlog at once. Default 20; the rest wait for
              the next pass and raise a notice on the attention desk.
            </p>
          </div>

          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="pause-guard-allowlist">Never resume these agents</Label>
            <Textarea
              id="pause-guard-allowlist"
              rows={4}
              value={current.allowlist}
              onChange={(event) => setDraft({ ...current, allowlist: event.target.value })}
            />
            <div className="text-xs text-muted-foreground">
              <span data-testid="pause-guard-source-allowlist">
                {describePauseGuardSource(view.sources.allowlist)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Agent names, one per line or separated by commas. Empty by default: an agent stays paused exactly as long as the
              operator left it.
            </p>
          </div>

          <div className="md:col-span-2">
            <Button
              type="button"
              size="sm"
              disabled={pending || patch === null || !dirty}
              onClick={() => {
                if (patch) onSave(patch);
              }}
            >
              {pending ? "Saving..." : "Save pause guard"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading pause guard settings...</p>
      )}
    </section>
  );
}

export function PauseGuardSettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: pauseGuardQueryKey,
    queryFn: () => pauseGuardApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: pauseGuardApi.update,
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the pause guard settings failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: pauseGuardQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load the pause guard settings."}
      </div>
    );
  }

  return (
    <PauseGuardSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}
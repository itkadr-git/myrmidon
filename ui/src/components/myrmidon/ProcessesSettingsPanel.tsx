// Processes of the board (myrmidon PROCS-1.1, design OPE-5394 §7.2): how many
// board processes exist and what each of them does. Saving stores the setting
// and applies it without a restart; the mode itself is read by a process when
// it starts, which is what PAPERCLIP_PROCESS_MODE=single is the escape for.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ServerCog } from "lucide-react";
import type {
  ProcessesLiveEventsBus,
  ProcessesMode,
  ProcessesSettingsPatch,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  describeProcessesEffectNotice,
  describeProcessesMode,
  describeProcessesSource,
  processesApi,
  processesQueryKey,
  type ProcessesSettingsView,
} from "./processesApi";

export function ProcessesSettingsPanel() {
  const queryClient = useQueryClient();
  const [draftError, setDraftError] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: processesQueryKey,
    queryFn: () => processesApi.get(),
  });

  const save = useMutation({
    mutationFn: (patch: ProcessesSettingsPatch) => processesApi.update(patch),
    onSuccess: (view: ProcessesSettingsView) => {
      setDraftError(null);
      queryClient.setQueryData(processesQueryKey, view);
    },
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading process settings…</p>;
  if (error || !data) {
    return <p className="text-sm text-destructive">Process settings are unavailable right now.</p>;
  }
  const { settings, sources, effectiveMode } = data;
  const notice = describeProcessesEffectNotice(data);
  const sourceOf = (key: keyof typeof sources) => describeProcessesSource(sources[key]);
  const disabled = save.isPending;

  return (
    <section className="space-y-4">
      <header className="flex items-center gap-2">
        <ServerCog className="h-4 w-4" aria-hidden />
        <h3 className="text-sm font-medium">Processes of the board</h3>
      </header>
      <p className="text-sm text-muted-foreground">
        How the board is split across processes. Saving applies the setting without restarting the
        server; the mode in force is reported by each process when it starts, and
        <code className="mx-1">PAPERCLIP_PROCESS_MODE=single</code>
        on the server starts it as one process whatever this page says.
      </p>

      {notice ? <p className="text-sm text-amber-600" data-testid="myrmidon-processes-notice">{notice}</p> : null}
      {save.isError ? (
        <p className="text-sm text-destructive" data-testid="myrmidon-processes-error">
          Could not save the process settings: {String(save.error)}
        </p>
      ) : null}
      {draftError ? <p className="text-sm text-destructive">{draftError}</p> : null}

      <div className="space-y-2">
        <Label htmlFor="processes-mode">Mode</Label>
        <select
          id="processes-mode"
          data-testid="myrmidon-processes-mode"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          value={settings.mode}
          disabled={disabled}
          onChange={(event) => {
            const mode = event.target.value as ProcessesMode;
            save.mutate({ mode });
          }}
        >
          {(["single", "split"] as const).map((mode) => (
            <option key={mode} value={mode}>
              {describeProcessesMode(mode)}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-processes-effective">
          In force now: {describeProcessesMode(effectiveMode)}. Source: {sourceOf("mode")}.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="processes-api-count">Api processes</Label>
        <Input
          id="processes-api-count"
          type="number"
          min={1}
          max={4}
          defaultValue={settings.apiCount}
          disabled={disabled}
          onBlur={(event) => {
            const apiCount = Number(event.target.value);
            if (!Number.isInteger(apiCount) || apiCount < 1 || apiCount > 4) {
              setDraftError("Api processes must be a whole number between 1 and 4.");
              return;
            }
            setDraftError(null);
            if (apiCount !== settings.apiCount) save.mutate({ apiCount });
          }}
        />
        <p className="text-xs text-muted-foreground">
          How many api processes a split board runs (the recommended arrangement is one worker and
          two api processes). Source: {sourceOf("apiCount")}.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="processes-lease">Leader lease, seconds</Label>
        <Input
          id="processes-lease"
          type="number"
          min={5}
          max={600}
          defaultValue={settings.leaderLeaseTtlSec}
          disabled={disabled}
          onBlur={(event) => {
            const leaderLeaseTtlSec = Number(event.target.value);
            if (!Number.isInteger(leaderLeaseTtlSec) || leaderLeaseTtlSec < 5 || leaderLeaseTtlSec > 600) {
              setDraftError("The leader lease must be a whole number of seconds between 5 and 600.");
              return;
            }
            setDraftError(null);
            if (leaderLeaseTtlSec !== settings.leaderLeaseTtlSec) save.mutate({ leaderLeaseTtlSec });
          }}
        />
        <p className="text-xs text-muted-foreground">
          How long the background role holds the leader lease before it has to renew it. Source:{" "}
          {sourceOf("leaderLeaseTtlSec")}.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="processes-bus">Live events bus</Label>
        <select
          id="processes-bus"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          value={settings.liveEventsBus}
          disabled={disabled}
          onChange={(event) => save.mutate({ liveEventsBus: event.target.value as ProcessesLiveEventsBus })}
        >
          <option value="local">Local (in-process)</option>
          <option value="pg">PostgreSQL (shared between processes)</option>
        </select>
        <p className="text-xs text-muted-foreground">
          Where live events travel when the board runs as several processes. Source:{" "}
          {sourceOf("liveEventsBus")}.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="processes-admission">Run admission store</Label>
        <select
          id="processes-admission"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          value={settings.admissionStore}
          disabled={disabled}
          onChange={(event) =>
            save.mutate({ admissionStore: event.target.value as ProcessesSettingsPatch["admissionStore"] })
          }
        >
          <option value="memory">In memory (this process)</option>
          <option value="db">Database (shared between processes)</option>
        </select>
        <p className="text-xs text-muted-foreground">
          Where run admission is decided. Source: {sourceOf("admissionStore")}.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <input
          id="processes-proxy"
          type="checkbox"
          className="h-4 w-4 rounded border-input"
          checked={settings.singletonProxy}
          disabled={disabled}
          onChange={(event) => save.mutate({ singletonProxy: event.target.checked })}
        />
        <Label htmlFor="processes-proxy">Proxy single-process routes to the leader</Label>
      </div>
      <p className="text-xs text-muted-foreground">
        A process that is not the leader proxies the routes that must run once (the scheduler, the
        background timers) to the process that owns them. Source: {sourceOf("singletonProxy")}.
      </p>

      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => queryClient.invalidateQueries({ queryKey: processesQueryKey })}
      >
        Reload from the server
      </Button>
    </section>
  );
}
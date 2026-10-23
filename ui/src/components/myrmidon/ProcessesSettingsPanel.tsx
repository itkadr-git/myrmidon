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
import { Trans } from "react-i18next";
import { useTranslation } from "@/i18n";
import {
  describeProcessesEffectNotice,
  describeProcessesMode,
  describeProcessesSource,
  processesApi,
  processesQueryKey,
  type ProcessesSettingsView,
} from "./processesApi";

// myrmidon(OPE-8950): visible strings live in area.settings-bots-host-2.processes-settings-panel.*
type Translate = (key: string, options?: Record<string, unknown>) => string;

export function ProcessesSettingsPanel() {
  const { t } = useTranslation() as { t: Translate };
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

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("area.settings-bots-host-2.processes-settings-panel.loading")}</p>;
  if (error || !data) {
    return <p className="text-sm text-destructive">{t("area.settings-bots-host-2.processes-settings-panel.unavailable")}</p>;
  }
  const { settings, sources, effectiveMode } = data;
  const notice = describeProcessesEffectNotice(data);
  const sourceOf = (key: keyof typeof sources) => describeProcessesSource(sources[key]);
  const disabled = save.isPending;

  return (
    <section className="space-y-4">
      <header className="flex items-center gap-2">
        <ServerCog className="h-4 w-4" aria-hidden />
        <h3 className="text-sm font-medium">{t("area.settings-bots-host-2.processes-settings-panel.title")}</h3>
      </header>
      <p className="text-sm text-muted-foreground">
        <Trans i18nKey="area.settings-bots-host-2.processes-settings-panel.description" components={{ code: <code className="mx-1" /> }} />
      </p>

      {notice ? <p className="text-sm text-amber-600" data-testid="myrmidon-processes-notice">{notice}</p> : null}
      {save.isError ? (
        <p className="text-sm text-destructive" data-testid="myrmidon-processes-error">
          {t("area.settings-bots-host-2.processes-settings-panel.saveError", { error: String(save.error) })}
        </p>
      ) : null}
      {draftError ? <p className="text-sm text-destructive">{draftError}</p> : null}

      <div className="space-y-2">
        <Label htmlFor="processes-mode">{t("area.settings-bots-host-2.processes-settings-panel.modeLabel")}</Label>
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
          {t("area.settings-bots-host-2.processes-settings-panel.effective", { mode: describeProcessesMode(effectiveMode), source: sourceOf("mode") })}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="processes-api-count">{t("area.settings-bots-host-2.processes-settings-panel.apiCountLabel")}</Label>
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
              setDraftError(t("area.settings-bots-host-2.processes-settings-panel.apiCountInvalid"));
              return;
            }
            setDraftError(null);
            if (apiCount !== settings.apiCount) save.mutate({ apiCount });
          }}
        />
        <p className="text-xs text-muted-foreground">
          {t("area.settings-bots-host-2.processes-settings-panel.apiCountHint", { source: sourceOf("apiCount") })}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="processes-lease">{t("area.settings-bots-host-2.processes-settings-panel.leaseLabel")}</Label>
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
              setDraftError(t("area.settings-bots-host-2.processes-settings-panel.leaseInvalid"));
              return;
            }
            setDraftError(null);
            if (leaderLeaseTtlSec !== settings.leaderLeaseTtlSec) save.mutate({ leaderLeaseTtlSec });
          }}
        />
        <p className="text-xs text-muted-foreground">
          {t("area.settings-bots-host-2.processes-settings-panel.leaseHint", { source: sourceOf("leaderLeaseTtlSec") })}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="processes-bus">{t("area.settings-bots-host-2.processes-settings-panel.busLabel")}</Label>
        <select
          id="processes-bus"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          value={settings.liveEventsBus}
          disabled={disabled}
          onChange={(event) => save.mutate({ liveEventsBus: event.target.value as ProcessesLiveEventsBus })}
        >
          <option value="local">{t("area.settings-bots-host-2.processes-settings-panel.busLocal")}</option>
          <option value="pg">{t("area.settings-bots-host-2.processes-settings-panel.busPg")}</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {t("area.settings-bots-host-2.processes-settings-panel.busHint", { source: sourceOf("liveEventsBus") })}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="processes-admission">{t("area.settings-bots-host-2.processes-settings-panel.admissionLabel")}</Label>
        <select
          id="processes-admission"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          value={settings.admissionStore}
          disabled={disabled}
          onChange={(event) =>
            save.mutate({ admissionStore: event.target.value as ProcessesSettingsPatch["admissionStore"] })
          }
        >
          <option value="memory">{t("area.settings-bots-host-2.processes-settings-panel.admissionMemory")}</option>
          <option value="db">{t("area.settings-bots-host-2.processes-settings-panel.admissionDb")}</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {t("area.settings-bots-host-2.processes-settings-panel.admissionHint", { source: sourceOf("admissionStore") })}
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
        <Label htmlFor="processes-proxy">{t("area.settings-bots-host-2.processes-settings-panel.proxyLabel")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("area.settings-bots-host-2.processes-settings-panel.proxyHint", { source: sourceOf("singletonProxy") })}
      </p>

      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => queryClient.invalidateQueries({ queryKey: processesQueryKey })}
      >
        {t("area.settings-bots-host-2.processes-settings-panel.reload")}
      </Button>
    </section>
  );
}
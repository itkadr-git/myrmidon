import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { TimerReset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { idleStopApi, idleStopBotsQueryKey, idleStopQueryKey, type IdleStopBot, type IdleStopMode, type IdleStopSettings } from "./idleStopApi";

function integer(raw: string, min: number, max: number): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export function IdleStopSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: idleStopQueryKey, queryFn: idleStopApi.get });
  const [afterSec, setAfterSec] = useState("");
  const [healthTimeoutMs, setHealthTimeoutMs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: (patch: Partial<IdleStopSettings>) => idleStopApi.update(patch),
    onSuccess: (data) => {
      queryClient.setQueryData(idleStopQueryKey, data);
      setSaved(true);
      setError(null);
    },
    onError: () => {
      setSaved(false);
      setError(t("area.settings-company.idle-stop-settings-panel.saveError"));
    },
  });

  useEffect(() => {
    if (!query.data) return;
    setAfterSec((current) => current || String(query.data.settings.afterSec));
    setHealthTimeoutMs((current) => current || String(query.data.settings.healthTimeoutMs));
  }, [query.data]);

  if (query.isLoading) return <p className="text-sm text-muted-foreground">{t("area.settings-company.idle-stop-settings-panel.loading")}</p>;
  if (query.isError || !query.data) return <p className="text-sm text-destructive">{t("area.settings-company.idle-stop-settings-panel.unavailable")}</p>;

  const settings = query.data.settings;
  const save = () => {
    const after = integer(afterSec, 60, 31_536_000);
    const timeout = integer(healthTimeoutMs, 1_000, 600_000);
    if (after === null || timeout === null) {
      setSaved(false);
      setError(t("area.settings-company.idle-stop-settings-panel.validationError"));
      return;
    }
    mutation.mutate({ enabled: settings.enabled, afterSec: after, healthTimeoutMs: timeout });
  };

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="idle-stop-settings-panel">
      <header className="flex items-center gap-2">
        <TimerReset className="h-4 w-4" aria-hidden />
        <h3 className="text-sm font-medium">{t("area.settings-company.idle-stop-settings-panel.title")}</h3>
      </header>
      <p className="text-sm text-muted-foreground">
        {t("area.settings-company.idle-stop-settings-panel.description")}
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={mutation.isPending}
          onChange={(event) => mutation.mutate({ enabled: event.target.checked })}
        />
        {t("area.settings-company.idle-stop-settings-panel.enabledByDefault")}
      </label>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="idle-stop-after-sec">{t("area.settings-company.idle-stop-settings-panel.afterSecLabel")}</Label>
          <Input id="idle-stop-after-sec" type="number" value={afterSec} onChange={(event) => setAfterSec(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="idle-stop-health-timeout">{t("area.settings-company.idle-stop-settings-panel.healthTimeoutLabel")}</Label>
          <Input id="idle-stop-health-timeout" type="number" value={healthTimeoutMs} onChange={(event) => setHealthTimeoutMs(event.target.value)} />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" onClick={save} disabled={mutation.isPending}>{t("common.save")}</Button>
        {saved ? <span className="text-sm text-muted-foreground">{t("area.settings-company.idle-stop-settings-panel.saved")}</span> : null}
        {error ? <span className="text-sm text-destructive">{error}</span> : null}
      </div>
      <IdleStopBotsList />
    </section>
  );
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}

function containerText(bot: IdleStopBot, t: TFunction): string {
  if (bot.idleStopped) return t("area.settings-company.idle-stop-settings-panel.stoppedOnIdle");
  if (bot.state === null) return t("area.settings-company.idle-stop-settings-panel.unknown");
  return bot.state === "running" ? t("area.settings-company.idle-stop-settings-panel.running") : bot.state === "stopped" ? t("area.settings-company.idle-stop-settings-panel.stopped") : bot.state;
}

/** Every container bot with its IDLE-STOP mode: set one, the selected ones, or all at once. */
export function IdleStopBotsList() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: idleStopBotsQueryKey, queryFn: idleStopApi.bots });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: ({ ids, mode }: { ids: string[]; mode: IdleStopMode }) => idleStopApi.setBotMode(ids, mode),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: idleStopBotsQueryKey });
    },
    onError: () => setError(t("area.settings-company.idle-stop-settings-panel.botsList.modeError")),
  });

  if (query.isLoading) return <p className="text-sm text-muted-foreground">{t("area.settings-company.idle-stop-settings-panel.botsList.loading")}</p>;
  if (query.isError || !query.data) return <p className="text-sm text-destructive">{t("area.settings-company.idle-stop-settings-panel.botsList.unavailable")}</p>;

  const bots = query.data.bots;
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const apply = (ids: string[], mode: IdleStopMode) => {
    if (ids.length > 0) mutation.mutate({ ids, mode });
  };

  return (
    <div className="space-y-3" data-testid="idle-stop-bots-list">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium">{t("area.settings-company.idle-stop-settings-panel.botsList.heading")}</h4>
        <span className="text-xs text-muted-foreground">{t("area.settings-company.idle-stop-settings-panel.botsList.summary", { total: bots.length, onDemand: t("area.settings-company.idle-stop-settings-panel.botsList.onDemand") })}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={mutation.isPending || selected.size === 0} onClick={() => apply([...selected], "always_on")}>
          {t("area.settings-company.idle-stop-settings-panel.botsList.selectedAlwaysOn")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={mutation.isPending || selected.size === 0} onClick={() => apply([...selected], "on_demand")}>
          {t("area.settings-company.idle-stop-settings-panel.botsList.selectedOnDemand")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={mutation.isPending || bots.length === 0} onClick={() => apply(bots.map((bot) => bot.agentId), "on_demand")}>
          {t("area.settings-company.idle-stop-settings-panel.botsList.allOnDemand")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={mutation.isPending || bots.length === 0} onClick={() => apply(bots.map((bot) => bot.agentId), "always_on")}>
          {t("area.settings-company.idle-stop-settings-panel.botsList.allAlwaysOn")}
        </Button>
        {error ? <span className="text-sm text-destructive">{error}</span> : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="w-8 py-1" />
              <th className="py-1">{t("area.settings-company.idle-stop-settings-panel.botsList.columnBot")}</th>
              <th className="py-1">{t("area.settings-company.idle-stop-settings-panel.botsList.columnMode")}</th>
              <th className="py-1">{t("area.settings-company.idle-stop-settings-panel.botsList.columnContainer")}</th>
              <th className="py-1">{t("area.settings-company.idle-stop-settings-panel.botsList.columnLastStopped")}</th>
              <th className="py-1">{t("area.settings-company.idle-stop-settings-panel.botsList.columnLastStarted")}</th>
            </tr>
          </thead>
          <tbody>
            {bots.map((bot) => (
              <tr key={bot.agentId} className="border-t" data-testid={`idle-stop-bot-${bot.agentId}`}>
                <td className="py-1">
                  <input type="checkbox" aria-label={t("area.settings-company.idle-stop-settings-panel.botsList.selectBot", { name: bot.name })} checked={selected.has(bot.agentId)} onChange={() => toggle(bot.agentId)} />
                </td>
                <td className="py-1">{bot.name}</td>
                <td className="py-1">
                  <select
                    aria-label={t("area.settings-company.idle-stop-settings-panel.botsList.modeFor", { name: bot.name })}
                    className="rounded-md border bg-background px-2 py-1 text-sm"
                    value={bot.mode}
                    disabled={mutation.isPending}
                    onChange={(event) => apply([bot.agentId], event.target.value as IdleStopMode)}
                  >
                    <option value="on_demand">{t("area.settings-company.idle-stop-settings-panel.botsList.onDemand")}</option>
                    <option value="always_on">{t("area.settings-company.idle-stop-settings-panel.botsList.alwaysOn")}</option>
                  </select>
                </td>
                <td className="py-1">{containerText(bot, t)}</td>
                <td className="py-1">{formatTime(bot.lastStoppedAt)}</td>
                <td className="py-1">{formatTime(bot.lastStartedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

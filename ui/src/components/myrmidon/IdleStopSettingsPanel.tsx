import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
      setError("Could not save IDLE-STOP settings.");
    },
  });

  useEffect(() => {
    if (!query.data) return;
    setAfterSec((current) => current || String(query.data.settings.afterSec));
    setHealthTimeoutMs((current) => current || String(query.data.settings.healthTimeoutMs));
  }, [query.data]);

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Loading IDLE-STOP settings...</p>;
  if (query.isError || !query.data) return <p className="text-sm text-destructive">IDLE-STOP settings are unavailable.</p>;

  const settings = query.data.settings;
  const save = () => {
    const after = integer(afterSec, 60, 31_536_000);
    const timeout = integer(healthTimeoutMs, 1_000, 600_000);
    if (after === null || timeout === null) {
      setSaved(false);
      setError("Idle threshold must be 60-31536000 seconds and health timeout 1000-600000 ms.");
      return;
    }
    mutation.mutate({ enabled: settings.enabled, afterSec: after, healthTimeoutMs: timeout });
  };

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="idle-stop-settings-panel">
      <header className="flex items-center gap-2">
        <TimerReset className="h-4 w-4" aria-hidden />
        <h3 className="text-sm font-medium">IDLE-STOP</h3>
      </header>
      <p className="text-sm text-muted-foreground">
        Stop idle bot containers and wake them before the next run. Changes apply without a restart.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={mutation.isPending}
          onChange={(event) => mutation.mutate({ enabled: event.target.checked })}
        />
        Enabled by default
      </label>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="idle-stop-after-sec">Idle threshold (seconds)</Label>
          <Input id="idle-stop-after-sec" type="number" value={afterSec} onChange={(event) => setAfterSec(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="idle-stop-health-timeout">Health timeout (ms)</Label>
          <Input id="idle-stop-health-timeout" type="number" value={healthTimeoutMs} onChange={(event) => setHealthTimeoutMs(event.target.value)} />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" onClick={save} disabled={mutation.isPending}>Save</Button>
        {saved ? <span className="text-sm text-muted-foreground">Saved</span> : null}
        {error ? <span className="text-sm text-destructive">{error}</span> : null}
      </div>
      <IdleStopBotsList />
    </section>
  );
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}

function containerText(bot: IdleStopBot): string {
  if (bot.idleStopped) return "Stopped on idle";
  if (bot.state === null) return "Unknown";
  return bot.state === "running" ? "Running" : bot.state === "stopped" ? "Stopped" : bot.state;
}

/** Every container bot with its IDLE-STOP mode: set one, the selected ones, or all at once. */
export function IdleStopBotsList() {
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
    onError: () => setError("Could not change the mode."),
  });

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Loading bots...</p>;
  if (query.isError || !query.data) return <p className="text-sm text-destructive">The bot list is unavailable.</p>;

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
        <h4 className="text-sm font-medium">Bots</h4>
        <span className="text-xs text-muted-foreground">{bots.length} with a container; "On demand" is the default.</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={mutation.isPending || selected.size === 0} onClick={() => apply([...selected], "always_on")}>
          Selected: always on
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={mutation.isPending || selected.size === 0} onClick={() => apply([...selected], "on_demand")}>
          Selected: on demand
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={mutation.isPending || bots.length === 0} onClick={() => apply(bots.map((bot) => bot.agentId), "on_demand")}>
          All: on demand
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={mutation.isPending || bots.length === 0} onClick={() => apply(bots.map((bot) => bot.agentId), "always_on")}>
          All: always on
        </Button>
        {error ? <span className="text-sm text-destructive">{error}</span> : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="w-8 py-1" />
              <th className="py-1">Bot</th>
              <th className="py-1">Mode</th>
              <th className="py-1">Container</th>
              <th className="py-1">Last stopped</th>
              <th className="py-1">Last started</th>
            </tr>
          </thead>
          <tbody>
            {bots.map((bot) => (
              <tr key={bot.agentId} className="border-t" data-testid={`idle-stop-bot-${bot.agentId}`}>
                <td className="py-1">
                  <input type="checkbox" aria-label={`Select ${bot.name}`} checked={selected.has(bot.agentId)} onChange={() => toggle(bot.agentId)} />
                </td>
                <td className="py-1">{bot.name}</td>
                <td className="py-1">
                  <select
                    aria-label={`Idle stop mode for ${bot.name}`}
                    className="rounded-md border bg-background px-2 py-1 text-sm"
                    value={bot.mode}
                    disabled={mutation.isPending}
                    onChange={(event) => apply([bot.agentId], event.target.value as IdleStopMode)}
                  >
                    <option value="on_demand">On demand</option>
                    <option value="always_on">Always on</option>
                  </select>
                </td>
                <td className="py-1">{containerText(bot)}</td>
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

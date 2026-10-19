import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TimerReset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { idleStopApi, idleStopQueryKey, type IdleStopSettings } from "./idleStopApi";

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
    </section>
  );
}

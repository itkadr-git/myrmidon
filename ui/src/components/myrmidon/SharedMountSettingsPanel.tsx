import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useIsInstanceAdmin } from "./licensingApi";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function validSharedMountPath(value: string): boolean {
  return value === "" || (value.startsWith("/") && value !== "/" &&
    !/[,:\\\x00-\x1f\x7f]/.test(value) && !value.includes("//") &&
    !value.endsWith("/") && value.split("/").every((part) => part !== "." && part !== ".."));
}

export function SharedMountSettingsPanel() {
  const admin = useIsInstanceAdmin();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: queryKeys.instance.generalSettings, queryFn: instanceSettingsApi.getGeneral });
  const [draft, setDraft] = useState<{ enabled: boolean; hostPath: string; writable: boolean; allowedBots: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stored = data?.sharedMount;
  const current = draft ?? {
    enabled: stored?.enabled ?? false,
    hostPath: stored?.hostPath ?? "",
    writable: stored?.writable ?? false,
    allowedBots: (stored?.allowedBots ?? []).join(", "),
  };
  const set = (next: typeof current) => { setDraft(next); setConfirmed(false); setError(null); };
  const save = useMutation({
    mutationFn: instanceSettingsApi.updateGeneral,
    onSuccess: () => { setDraft(null); setConfirmed(false); queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings }); },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Save failed"),
  });
  const submit = () => {
    const bots = current.allowedBots.split(",").map((value) => value.trim()).filter(Boolean);
    if (!validSharedMountPath(current.hostPath) || bots.some((value) => !/^[0-9a-f-]{36}$/i.test(value))) {
      setError("Enter a normalized absolute host path and comma-separated bot UUIDs.");
      return;
    }
    if (!confirmed) return;
    save.mutate({ sharedMount: {
      enabled: current.enabled,
      ...(current.hostPath ? { hostPath: current.hostPath } : {}),
      writable: current.writable,
      allowedBots: bots,
    } });
  };
  return (
    <section className="space-y-3 rounded-lg border p-4" data-testid="shared-mount-settings">
      <h2 className="text-sm font-semibold">Shared bot mount</h2>
      <p className="text-xs text-muted-foreground">Changes affect new or reconciled bot containers; already running containers retain their mount until recreated. An empty allowlist permits every bot.</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={current.enabled} disabled={!admin} onChange={(event) => set({ ...current, enabled: event.target.checked })} />Enabled</label>
      <div className="space-y-1"><Label htmlFor="shared-mount-path">Host directory (blank uses volume root/shared)</Label><Input id="shared-mount-path" value={current.hostPath} disabled={!admin} onChange={(event) => set({ ...current, hostPath: event.target.value })} /></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={current.writable} disabled={!admin} onChange={(event) => set({ ...current, writable: event.target.checked })} />Writable by bots</label>
      <div className="space-y-1"><Label htmlFor="shared-mount-bots">Allowed bot IDs (comma separated; blank allows all)</Label><Input id="shared-mount-bots" value={current.allowedBots} disabled={!admin} onChange={(event) => set({ ...current, allowedBots: event.target.value })} /></div>
      {admin && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I confirm this host path and access scope may expose files to bots.</label>}
      <Button size="sm" disabled={!admin || !confirmed || save.isPending || !validSharedMountPath(current.hostPath)} onClick={submit}>Save shared mount</Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </section>
  );
}

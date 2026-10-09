import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { boardProcessesApi, type BoardProcess } from "@/api/instanceSettings";
import { Card } from "@/components/ui/card";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { formatBytes } from "@/lib/issue-output";

const PULSE_STALE_MS = 30_000; // three missed 10 s pulses

function pulseLabel(row: BoardProcess): { text: string; stale: boolean } {
  const ageMs = Date.now() - new Date(row.lastSeenAt).getTime();
  if (!Number.isFinite(ageMs)) return { text: "—", stale: true };
  if (ageMs < 0) return { text: "just now", stale: false };
  const sec = Math.round(ageMs / 1000);
  const stale = ageMs > PULSE_STALE_MS;
  if (sec < 60) return { text: `${sec}s ago`, stale };
  return { text: `${Math.floor(sec / 60)}m${sec % 60 ? ` ${sec % 60}s` : ""} ago`, stale };
}

function formatStartedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function InstanceProcesses() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Processes" },
    ]);
  }, [setBreadcrumbs]);

  // The pulse rewrites the rows every 10 s, so a 10 s poll keeps the panel
  // within one beat of the truth without a websocket.
  const processesQuery = useQuery({
    queryKey: queryKeys.instance.processes,
    queryFn: () => boardProcessesApi.list(),
    refetchInterval: 10_000,
  });

  if (processesQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading processes…</div>;
  }

  if (processesQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {processesQuery.error instanceof Error
          ? processesQuery.error.message
          : "Failed to load processes."}
      </div>
    );
  }

  const rows = processesQuery.data ?? [];

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Processes</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The live board processes, their roles and pulse, from the instance's
          board_processes registry. Each process refreshes its row every 10
          seconds; a row whose pulse went quiet is dropped after two minutes.
        </p>
      </div>

      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2 font-medium">Boot ID</th>
                <th className="px-4 py-2 font-medium">Pulse</th>
                <th className="px-4 py-2 font-medium">Event loop lag</th>
                <th className="px-4 py-2 font-medium">RSS</th>
                <th className="px-4 py-2 font-medium">PID</th>
                <th className="px-4 py-2 font-medium">Host</th>
                <th className="px-4 py-2 font-medium">Version</th>
                <th className="px-4 py-2 font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-center text-muted-foreground" colSpan={9}>
                    No processes have reported yet.
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const pulse = pulseLabel(row);
                  return (
                    <tr key={row.bootId} className="border-b last:border-0">
                      <td className="px-4 py-2 font-medium">{row.role}</td>
                      <td className="px-4 py-2 font-mono text-xs">{row.bootId.slice(0, 8)}…</td>
                      <td className={`px-4 py-2 ${pulse.stale ? "text-amber-600 dark:text-amber-400" : ""}`}>
                        {pulse.text}
                      </td>
                      <td className="px-4 py-2">
                        {row.eventLoopLagMs === null ? "—" : `${row.eventLoopLagMs.toFixed(1)} ms`}
                      </td>
                      <td className="px-4 py-2">
                        {row.rssBytes === null ? "—" : formatBytes(row.rssBytes)}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">{row.pid}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {row.container ?? row.hostname}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{row.version}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {formatStartedAt(row.startedAt)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

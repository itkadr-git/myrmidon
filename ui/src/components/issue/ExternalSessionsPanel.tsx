import type { AiManagedConnectionSummary } from "@myrmidonai/shared";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { aiConnectionsApi } from "../../api/ai-connections";
import { agentsApi } from "../../api/agents";
import { heartbeatsApi, type ExternalSessionRun } from "../../api/heartbeats";
import { issuesApi } from "../../api/issues";

export function ExternalSessionsPanel({
  companyId,
  issueId,
  issueIdentifier,
  agentId,
  agentModel,
  canLaunch = false,
}: {
  companyId: string;
  issueId: string;
  issueIdentifier: string | null;
  agentId: string;
  agentModel: string | null;
  canLaunch?: boolean;
}) {
  const queryClient = useQueryClient();
  const [connectionId, setConnectionId] = useState("");
  const [model, setModel] = useState(agentModel ?? "");
  const [logRun, setLogRun] = useState<ExternalSessionRun | null>(null);
  const connectionsQuery = useQuery({
    queryKey: ["ai-connections", companyId, agentId],
    queryFn: () => aiConnectionsApi.list(companyId, agentId),
    enabled: Boolean(agentId && canLaunch),
  });
  const sessionsQuery = useQuery({
    queryKey: ["external-sessions", companyId, issueId],
    queryFn: () => heartbeatsApi.externalSessions(companyId, issueId),
    refetchInterval: 5000,
  });
  const launch = useMutation({
    mutationFn: async () => {
      const connection = connectionsQuery.data?.connections.find((item) => item.id === connectionId);
      if (!connection) throw new Error("Select an available managed connection");
      return agentsApi.externalSession(agentId, {
        issueId,
        externalSession: { connectionId, grantId: connection.grantId, model: model.trim() },
      }, companyId);
    },
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({ queryKey: ["external-sessions", companyId, issueId] });
      if ("id" in response) {
        await issuesApi.addComment(issueId, `External session started (run ${response.id}). Use the session controls below to view logs or cancel.`);
      }
    },
  });
  const cancel = useMutation({
    mutationFn: (runId: string) => heartbeatsApi.cancel(runId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["external-sessions", companyId, issueId] });
    },
  });
  const connections = (connectionsQuery.data?.connections ?? []).filter(
    (item: AiManagedConnectionSummary) => item.ownership === "shared" && item.status === "connected",
  );

  return (
    <section className="space-y-3 rounded-lg border border-border p-3" aria-label="External sessions">
      {!agentId && <p className="text-sm text-muted-foreground">Assign this task to an agent before starting an external session.</p>}
      {canLaunch ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid min-w-48 gap-1 text-sm">
            Managed connection
            <select className="rounded border border-border bg-background px-2 py-1" value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
              <option value="">Select connection</option>
              {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
            </select>
          </label>
          <label className="grid min-w-40 gap-1 text-sm">
            Model
            <input className="rounded border border-border bg-background px-2 py-1" value={model} onChange={(event) => setModel(event.target.value)} />
          </label>
          <button type="button" className="rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50" disabled={!connectionId || !model.trim() || launch.isPending || !connections.length} onClick={() => launch.mutate()}>
            {launch.isPending ? "Starting…" : "Start external session"}
          </button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Starting external sessions is unavailable until the durable session runner is enabled.</p>
      )}
      {connectionsQuery.isError && <p role="alert" className="text-sm text-destructive">Could not load managed connections.</p>}
      {launch.isError && <p role="alert" className="text-sm text-destructive">{launch.error.message}</p>}
      {sessionsQuery.isError && <p role="alert" className="text-sm text-destructive">Could not load external sessions.</p>}
      {sessionsQuery.data?.length ? (
        <ul className="divide-y divide-border">
          {sessionsQuery.data.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span><strong>{session.agentName}</strong> · {session.externalSession.model ?? "model unavailable"} · {session.status}</span>
              <span className="flex gap-2">
                <button type="button" className="underline" onClick={() => setLogRun(session)}>Log tail</button>
                {["queued", "running"].includes(session.status) && <button type="button" className="underline text-destructive" disabled={cancel.isPending} onClick={() => cancel.mutate(session.id)}>Cancel</button>}
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted-foreground">No external sessions for this task yet.</p>}
      {logRun && <ExternalSessionLog companyId={companyId} run={logRun} onClose={() => setLogRun(null)} />}
      {issueIdentifier && <span className="sr-only">Sessions are attached to {issueIdentifier}.</span>}
    </section>
  );
}

function ExternalSessionLog({ companyId, run, onClose }: { companyId: string; run: ExternalSessionRun; onClose: () => void }) {
  const log = useQuery({
    queryKey: ["external-session-log", companyId, run.id],
    queryFn: () => heartbeatsApi.logTail(run.id),
    refetchInterval: ["queued", "running"].includes(run.status) ? 3000 : false,
  });
  return (
    <div role="dialog" aria-modal="true" aria-label="External session log tail" className="space-y-2 rounded border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between"><strong>Log tail · {run.id.slice(0, 8)}</strong><button type="button" className="underline" onClick={onClose}>Close</button></div>
      {log.isError ? <p role="alert" className="text-sm text-destructive">Could not load run log.</p> : <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{log.data?.content ?? "Loading log…"}</pre>}
    </div>
  );
}

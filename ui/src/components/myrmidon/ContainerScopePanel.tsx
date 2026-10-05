// myrmidon(CONTAINER-SCOPE): "Containers of an isolation area".
//
// The disk axis above decides which bots share a directory; this panel decides
// which of them share one container. Every agent resolves to an area (its own
// override, a group, a caste, a reporting subtree, a project, a catalog team,
// the company) in the shared resolver; a scope instance set to "one container
// for the area" puts all of its members into one container with one set of
// limits, and the default stays one container per agent. A change only changes
// what an agent resolves to: the affected agents show "restart required" until
// the runtime reports the container it applied. Pausing one member of a shared
// container never stops the others — the plan of an action says so per member.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Container } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOptionalCompany } from "@/context/CompanyContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  containerScopeApi,
  containerScopeQueryKey,
  describeContainerMode,
  describeContainerReason,
  describeLimits,
  type ContainerActionPlan,
  type ContainerMode,
  type SettableScopeKind,
} from "./containerScopeApi";

const KINDS: SettableScopeKind[] = ["group", "caste", "subtree", "project", "catalog", "company"];

const KIND_HINT: Record<SettableScopeKind, string> = {
  group: "a group id from the disk panel above",
  caste: "a role key, e.g. engineer",
  subtree: "the agent id of the lead",
  project: "a project id",
  catalog: "a catalog team id",
  company: "the whole company",
};

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function ContainerScopePanel() {
  const companyId = useOptionalCompany()?.selectedCompanyId ?? "";
  const queryClient = useQueryClient();
  const queryKey = containerScopeQueryKey(companyId);
  const { data: overview } = useQuery({
    queryKey,
    queryFn: () => containerScopeApi.overview(companyId),
    enabled: companyId.length > 0,
  });

  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<SettableScopeKind>("group");
  const [ref, setRef] = useState("");
  const [mode, setMode] = useState<ContainerMode>("per-scope");
  const [plan, setPlan] = useState<ContainerActionPlan | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey });

  const putInstance = useMutation({
    mutationFn: () => containerScopeApi.putInstance(companyId, { kind, ref: ref.trim(), mode }),
    onSuccess: () => {
      setError(null);
      setRef("");
      void refresh();
    },
    onError: (err) => setError(errorText(err, "The instance could not be saved.")),
  });
  const deleteInstance = useMutation({
    mutationFn: (instance: { kind: SettableScopeKind; ref: string }) =>
      containerScopeApi.deleteInstance(companyId, instance.kind, instance.ref),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (err) => setError(errorText(err, "The instance could not be removed.")),
  });
  const recompute = useMutation({
    mutationFn: () => containerScopeApi.recompute(companyId),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (err) => setError(errorText(err, "The areas could not be recomputed.")),
  });
  const markApplied = useMutation({
    mutationFn: (agent: { agentId: string; containerKey: string }) =>
      containerScopeApi.markApplied(companyId, agent.agentId, agent.containerKey),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (err) => setError(errorText(err, "The container could not be recorded.")),
  });
  const planAction = useMutation({
    mutationFn: (agent: { agentId: string; kind: "pause" | "resume" | "restart" }) =>
      containerScopeApi.planAction(companyId, agent.agentId, agent.kind),
    onSuccess: (result) => {
      setError(null);
      setPlan(result);
    },
    onError: (err) => setError(errorText(err, "The plan could not be built.")),
  });

  return (
    <section className="space-y-4" data-testid="myrmidon-container-scope">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Container className="h-4 w-4" /> Containers of an isolation area
        </h3>
        <p className="text-sm text-muted-foreground">
          One container per agent by default. Set an instance to share one container and its limits between all its
          members; a change marks the affected agents “restart required”. The area itself comes from the same resolver as
          the disk panel above.
        </p>
        {overview ? (
          <p className="text-sm text-muted-foreground" data-testid="container-scope-summary">
            Limits of one container: {describeLimits(overview.limits)} · containers: {overview.containers.length} ·
            agents in a shared container: {overview.sharedAgentCount}
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Level</span>
          <Select value={kind} onValueChange={(value) => setKind(value as SettableScopeKind)}>
            <SelectTrigger className="w-40" aria-label="Scope kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Instance</span>
          <Input
            className="w-72"
            value={ref}
            onChange={(event) => setRef(event.target.value)}
            placeholder={KIND_HINT[kind]}
            aria-label="Scope instance"
          />
        </div>
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Containers</span>
          <Select value={mode} onValueChange={(value) => setMode(value as ContainerMode)}>
            <SelectTrigger className="w-56" aria-label="Container mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="per-scope">one for the area</SelectItem>
              <SelectItem value="per-agent">one per agent</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          disabled={ref.trim().length === 0 || putInstance.isPending}
          onClick={() => putInstance.mutate()}
        >
          Save instance
        </Button>
        <Button type="button" variant="outline" disabled={recompute.isPending} onClick={() => recompute.mutate()}>
          Recompute
        </Button>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Configured instances</h4>
        {(overview?.instances.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No instance is configured: every agent keeps its own container.</p>
        ) : (
          <ul className="space-y-1" data-testid="container-scope-instances">
            {overview?.instances.map((instance) => (
              <li key={`${instance.kind}:${instance.ref}`} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {instance.kind} · {instance.label} · {describeContainerMode(instance.mode)} ·{" "}
                  {instance.agentCount} agent(s)
                  {instance.diskMode ? ` · disk: ${instance.diskMode}` : ""}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => deleteInstance.mutate({ kind: instance.kind, ref: instance.ref })}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Containers</h4>
        <ul className="space-y-1" data-testid="container-scope-containers">
          {overview?.containers.map((container) => (
            <li key={container.containerKey} className="text-sm">
              <span className="font-mono">{container.containerKey}</span> ·{" "}
              {container.shared ? "shared" : "own"} · {describeLimits(container.limits)} ·{" "}
              {container.members.map((member) => member.name).join(", ")}
              {container.restartRequired.length > 0 ? ` · restart required: ${container.restartRequired.length}` : ""}
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Agents and their containers</h4>
        <ul className="space-y-1" data-testid="container-scope-agents">
          {overview?.agents.map((agent) => (
            <li key={agent.agentId} className="space-y-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span>{agent.name}</span>
                <span className="font-mono text-xs">{agent.containerKey}</span>
                <span className="text-muted-foreground">({describeContainerReason(agent)})</span>
                {agent.restartRequired ? (
                  <span className="text-destructive">restart required</span>
                ) : null}
                {agent.problems.length > 0 ? <span className="text-destructive">choice needed</span> : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => planAction.mutate({ agentId: agent.agentId, kind: "pause" })}
                >
                  Plan pause
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={agent.appliedContainerKey === agent.containerKey}
                  onClick={() =>
                    markApplied.mutate({ agentId: agent.agentId, containerKey: agent.containerKey })
                  }
                >
                  Record as applied
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {plan ? (
        <div className="space-y-1" data-testid="container-scope-plan">
          <h4 className="text-sm font-medium">
            The plan of one action ({plan.shared ? "shared container" : "own container"})
          </h4>
          <ul className="space-y-1 text-sm">
            {plan.actions.map((action) => (
              <li key={action.agentId}>
                {action.agentId}: {action.action} ({action.note})
              </li>
            ))}
          </ul>
          <Button type="button" variant="ghost" size="sm" onClick={() => setPlan(null)}>
            Hide the plan
          </Button>
        </div>
      ) : null}
    </section>
  );
}
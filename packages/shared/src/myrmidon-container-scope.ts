// packages/shared/src/myrmidon-container-scope.ts
//
// myrmidon(CONTAINER-SCOPE): the container axis of an isolation area.
//
// The disk axis (packages/shared/src/myrmidon-isolation-scope.ts, BOT-DISK-F)
// decides which bots share a host directory. This module decides which bots
// share one container, and it consumes that same resolution instead of
// resolving areas a second time:
//
//   - the default is unchanged: one container per agent;
//   - a scope instance may be set to `per-scope`, so the agents that resolved to
//     that instance run in one container with one set of limits;
//   - an agent keeps its own container when it resolved to no scope, when its
//     instance is `per-agent`, or when the instance id cannot address a
//     container at all;
//   - pausing, restarting or rolling out one agent inside a shared container
//     changes that agent only; the other members keep running.
//
// Everything here is pure: resolutions plus container settings go in, a plan
// comes out. The runtime (bot containers, dockergate) consumes the plan.

import { z } from "zod";
import {
  SETTABLE_SCOPE_KINDS,
  scopeIdProblem,
  scopeInstanceDirName,
  type AgentScopeResolution,
  type SettableScopeKind,
} from "./myrmidon-isolation-scope.js";

/** One container for each agent, or one container for the whole instance. */
export const CONTAINER_MODES = ["per-agent", "per-scope"] as const;
export type ContainerMode = (typeof CONTAINER_MODES)[number];

export function isContainerMode(value: unknown): value is ContainerMode {
  return typeof value === "string" && (CONTAINER_MODES as readonly string[]).includes(value);
}

/** The container setting of one scope instance. */
export interface ContainerInstanceSetting {
  kind: SettableScopeKind;
  id: string;
  mode: ContainerMode;
}

/** The limits one container runs with; the members of a shared container share them. */
export interface ContainerLimits {
  memoryMb: number;
  cpus: number;
}

/** The container of one agent, and the company of agents it shares it with. */
export interface ContainerPlan {
  agentId: string;
  /** `agent:<agentId>` or `scope:<instance dir name>`; stable while the area holds. */
  containerKey: string;
  shared: boolean;
  /** The instance that put this agent into a shared container, or null. */
  scope: { kind: SettableScopeKind; id: string } | null;
  /** Every agent of this container, sorted. The agent itself when private. */
  roster: readonly string[];
  /** The limits of the whole container — not of one agent inside it. */
  limits: ContainerLimits;
  /** Why the agent is where it is; shown in the interface. */
  reason: "default" | "agent-isolated" | "instance-per-agent" | "instance-per-scope" | "instance-invalid";
}

/** Every container of a company: one row per container key. */
export interface ContainerRow {
  containerKey: string;
  shared: boolean;
  scope: { kind: SettableScopeKind; id: string } | null;
  roster: readonly string[];
  limits: ContainerLimits;
}

export interface ContainerPlanInput {
  companyId: string;
  resolutions: ReadonlyMap<string, AgentScopeResolution>;
  settings: readonly ContainerInstanceSetting[];
  limits: ContainerLimits;
}

export interface ContainerPlanResult {
  plans: Map<string, ContainerPlan>;
  containers: ContainerRow[];
}

function settingKey(kind: SettableScopeKind, id: string): string {
  return `${kind}\u0000${id}`;
}

function agentContainerKey(agentId: string): string {
  return `agent:${agentId}`;
}

/**
 * The container key of one agent. A shared container is addressed by the
 * instance directory name, so the container and the shared directory of one
 * instance carry the same name — an operator reads one name in both places.
 */
export function containerKeyForAgent(input: {
  companyId: string;
  agentId: string;
  resolution: AgentScopeResolution | undefined;
  settings: ReadonlyMap<string, ContainerInstanceSetting>;
}): { containerKey: string; shared: boolean; scope: { kind: SettableScopeKind; id: string } | null; reason: ContainerPlan["reason"] } {
  const agentKey = agentContainerKey(input.agentId);
  const isolated = { containerKey: agentKey, shared: false as const, scope: null, reason: "default" as const };
  const resolution = input.resolution ?? null;
  if (!resolution) return isolated;
  // An agent that keeps its own area keeps its own container, whatever the
  // instances say.
  if (resolution.effective.scope === null) {
    return { ...isolated, reason: resolution.effective.source === "agent" ? "agent-isolated" : "default" };
  }
  const scope = resolution.effective.scope;
  const setting = input.settings.get(settingKey(scope.kind, scope.id));
  if (!setting || setting.mode !== "per-scope") {
    return { ...isolated, reason: "instance-per-agent" };
  }
  // The instance must be able to name a container; an unusable id must not
  // silently merge strangers into one container.
  if (scopeIdProblem(scope.kind, scope.id)) {
    return { ...isolated, reason: "instance-invalid" };
  }
  return {
    containerKey: `scope:${scopeInstanceDirName(scope.kind, input.companyId, scope.id)}`,
    shared: true,
    scope: { kind: scope.kind, id: scope.id },
    reason: "instance-per-scope",
  };
}

/** The container plan of every agent of a company, plus one row per container. */
export function planContainers(input: ContainerPlanInput): ContainerPlanResult {
  const settings = new Map<string, ContainerInstanceSetting>();
  for (const setting of input.settings) settings.set(settingKey(setting.kind, setting.id), setting);

  const planned = new Map<string, Omit<ContainerPlan, "roster" | "limits">>();
  for (const [agentId, resolution] of input.resolutions) {
    const decided = containerKeyForAgent({
      companyId: input.companyId,
      agentId,
      resolution,
      settings,
    });
    planned.set(agentId, { agentId, ...decided });
  }

  const rosterOf = new Map<string, string[]>();
  for (const plan of planned.values()) {
    const roster = rosterOf.get(plan.containerKey) ?? [];
    roster.push(plan.agentId);
    rosterOf.set(plan.containerKey, roster);
  }

  const plans = new Map<string, ContainerPlan>();
  for (const [agentId, plan] of planned) {
    const roster = [...(rosterOf.get(plan.containerKey) ?? [agentId])].sort();
    plans.set(agentId, { ...plan, roster, limits: input.limits });
  }

  const containers: ContainerRow[] = [];
  for (const [containerKey, roster] of rosterOf) {
    const first = planned.get([...roster].sort()[0]);
    containers.push({
      containerKey,
      shared: first?.shared ?? false,
      scope: first?.scope ?? null,
      roster: [...roster].sort(),
      limits: input.limits,
    });
  }
  containers.sort((a, b) => a.containerKey.localeCompare(b.containerKey));
  return { plans, containers };
}

/** The members of one container, sorted; the agent alone when it has no container. */
export function containerRoster(result: ContainerPlanResult, agentId: string): readonly string[] {
  return result.plans.get(agentId)?.roster ?? [agentId];
}

// ---- actions --------------------------------------------------------------

export type ContainerActionKind = "stop" | "start" | "restart" | "keep";

export interface ContainerAction {
  agentId: string;
  action: ContainerActionKind;
  /** The other members of the container keep running; this says how. */
  note: "container-keeps-running" | "container-not-restarted" | "container-shared" | "container-private";
}

export interface ContainerActionRequest {
  /** The agent the operator acts on. */
  agentId: string;
  kind: "pause" | "resume" | "restart" | "rollout";
}

/**
 * What one operator action does to every member of the affected container.
 * The rule the ticket asks for: pausing one agent inside a shared container
 * must not stop the other members — the request is answered per agent, and the
 * other members always come back as `keep`.
 */
export function planContainerActions(
  result: ContainerPlanResult,
  request: ContainerActionRequest,
): ContainerAction[] {
  const target = result.plans.get(request.agentId);
  const shared = target?.shared ?? false;
  const keepNote: ContainerAction["note"] = shared ? "container-shared" : "container-private";
  const roster = shared ? (target?.roster ?? [request.agentId]) : [request.agentId];
  const actions: ContainerAction[] = [];
  for (const agentId of [...roster].sort()) {
    const isTarget = agentId === request.agentId;
    if (!isTarget) {
      actions.push({ agentId, action: "keep", note: keepNote });
      continue;
    }
    switch (request.kind) {
      case "pause":
        actions.push({ agentId, action: "stop", note: shared ? "container-keeps-running" : "container-private" });
        break;
      case "resume":
        actions.push({ agentId, action: "start", note: keepNote });
        break;
      case "restart":
      case "rollout":
        actions.push({ agentId, action: "restart", note: shared ? "container-not-restarted" : "container-private" });
        break;
    }
  }
  return actions;
}

/** One container that a runtime refuses to serve more than once. */
export interface ContainerEnrolmentRow {
  containerKey: string;
  shared: boolean;
  scope: { kind: SettableScopeKind; id: string } | null;
  roster: readonly string[];
}

/**
 * The rows a container runtime (dockergate) checks a request against: a shared
 * container is served only for the agents enrolled in it.
 */
export function containerEnrolment(result: ContainerPlanResult): ContainerEnrolmentRow[] {
  return result.containers.map((row) => ({
    containerKey: row.containerKey,
    shared: row.shared,
    scope: row.scope,
    roster: row.roster,
  }));
}

/**
 * True when the container an agent runs in is not the one its area asks for now.
 * An agent that never applied anything runs in its own container, so the first
 * change of an area is a restart too — the same rule the disk axis follows.
 */
export function containerRestartRequired(input: {
  agentId: string;
  appliedContainerKey: string | null;
  resolvedContainerKey: string;
}): boolean {
  return (input.appliedContainerKey ?? agentContainerKey(input.agentId)) !== input.resolvedContainerKey;
}

// ---- request bodies --------------------------------------------------------

/** Body of `PUT .../container-scope/instances`: the container setting of one instance. */
export const putContainerInstanceSchema = z
  .object({
    kind: z.enum(SETTABLE_SCOPE_KINDS),
    ref: z.string().min(1).max(100),
    mode: z.enum(CONTAINER_MODES),
  })
  .strict();

/** Body of `POST .../container-scope/agents/:agentId/actions`. */
export const containerScopeActionSchema = z
  .object({ kind: z.enum(["pause", "resume", "restart", "rollout"]) })
  .strict();

/** Body of `POST .../container-scope/agents/:agentId/applied`: the runtime reports its container. */
export const markContainerAppliedSchema = z.object({ containerKey: z.string().min(1).max(200) }).strict();

export type PutContainerInstanceBody = z.infer<typeof putContainerInstanceSchema>;
export type ContainerScopeActionBody = z.infer<typeof containerScopeActionSchema>;
export type MarkContainerAppliedBody = z.infer<typeof markContainerAppliedSchema>;

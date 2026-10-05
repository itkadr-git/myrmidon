// server/src/myrmidon/container-scope/service.ts
//
// myrmidon(CONTAINER-SCOPE): the container axis of an isolation area. The area
// itself is resolved once, by the shared resolver BOT-DISK-F owns; this service
// decides the container of every agent from that resolution and the container
// settings, and writes the restart markers the interface reads.

import {
  isContainerMode,
  planContainerActions,
  planContainers,
  resolveIsolationScopes,
  scopeIdProblem,
  containerRestartRequired,
  type AgentScopeResolution,
  type ContainerAction,
  type ContainerLimits,
  type ContainerMode,
  type ContainerPlanResult,
  type ContainerInstanceSetting,
  type IsolationMode,
  type ScopeAgentInput,
  type ScopeSettingInput,
  type SettableScopeKind,
} from "@paperclipai/shared";
import type {
  ContainerAgentView,
  ContainerInstanceView,
  ContainerScopeActionRequest,
  ContainerScopeActionResult,
  ContainerScopeOverview,
  ContainerScopeServiceOptions,
  ContainerView,
} from "./domain.js";
import type {
  ContainerScopeStore,
  ContainerStateRow,
  ContainerStateWrite,
} from "./store.js";

export const CONTAINER_REASON_APPLIED = "container-scope-applied";
export const CONTAINER_REASON_CHANGED = "container-scope-changed";

const DEFAULT_LIMITS: ContainerLimits = { memoryMb: 4096, cpus: 2 };

export interface SetContainerInstanceInput {
  kind: SettableScopeKind;
  ref: string;
  mode: ContainerMode;
}

export interface SetContainerInstanceResult {
  instance: ContainerInstanceView;
  /** Agents whose container changed; they are marked for a restart. */
  restartRequired: string[];
}

export interface ContainerScopeService {
  overview(companyId: string): Promise<ContainerScopeOverview>;
  setInstance(companyId: string, input: SetContainerInstanceInput): Promise<SetContainerInstanceResult | null>;
  removeInstance(companyId: string, kind: SettableScopeKind, ref: string): Promise<boolean>;
  recompute(companyId: string): Promise<{ agents: number; restartRequired: string[] }>;
  markApplied(companyId: string, agentId: string, containerKey: string): Promise<ContainerAgentView | null>;
  actions(companyId: string, request: ContainerScopeActionRequest): Promise<ContainerScopeActionResult | null>;
}

interface CompanyModel {
  resolutions: Map<string, AgentScopeResolution>;
  plan: ContainerPlanResult;
  agentsById: Map<string, string>;
  rolesById: Map<string, string | null>;
  statusByAgent: Map<string, ContainerStateRow>;
  instanceSettings: ContainerInstanceSetting[];
  diskModes: Map<string, IsolationMode>;
  groupNames: Map<string, string>;
}

function settingKey(kind: SettableScopeKind, id: string): string {
  return `${kind}\u0000${id}`;
}

export function containerScopeService(
  store: ContainerScopeStore,
  options: ContainerScopeServiceOptions = {},
): ContainerScopeService {
  const limits = options.limits ?? DEFAULT_LIMITS;

  async function loadModel(companyId: string): Promise<CompanyModel> {
    const [agentRows, groupRows, diskRows, prefRows, instanceRows, stateRows] = await Promise.all([
      store.listAgents(companyId),
      store.listGroups(companyId),
      store.listDiskSettings(companyId),
      store.listPrefs(companyId),
      store.listContainerSettings(companyId),
      store.listStates(companyId),
    ]);

    const agents: ScopeAgentInput[] = agentRows.map((row) => ({
      id: row.id,
      role: row.role,
      reportsTo: row.reportsTo,
      catalogId: row.catalogId,
      projectIds: row.projectIds,
    }));

    // An instance that is configured for containers but not for the disk still
    // has to name an area, or the resolver would never hand it to an agent. It
    // is added as an isolated disk instance; the container axis stays the one
    // that decides the container.
    const diskModes = new Map<string, IsolationMode>();
    const settings: ScopeSettingInput[] = diskRows.map((row) => {
      diskModes.set(settingKey(row.kind, row.id), row.mode);
      return { kind: row.kind, id: row.id, mode: row.mode };
    });
    const known = new Set(settings.map((setting) => settingKey(setting.kind, setting.id)));
    const instanceSettings: ContainerInstanceSetting[] = [];
    for (const row of instanceRows) {
      instanceSettings.push({ kind: row.kind, id: row.scopeId, mode: row.mode });
      const key = settingKey(row.kind, row.scopeId);
      if (!known.has(key)) {
        settings.push({ kind: row.kind, id: row.scopeId, mode: "isolated" });
        known.add(key);
      }
      if (!diskModes.has(key)) diskModes.set(key, "isolated");
    }

    const resolutions = resolveIsolationScopes({
      companyId,
      agents,
      groups: groupRows.map((group) => ({ id: group.id, name: group.name, memberIds: group.memberIds })),
      settings,
      prefs: prefRows.map((pref) => ({
        agentId: pref.agentId,
        isolate: pref.isolate,
        groupId: pref.groupId,
        projectId: pref.projectId,
      })),
    });

    const plan = planContainers({ companyId, resolutions, settings: instanceSettings, limits });

    return {
      resolutions,
      plan,
      agentsById: new Map(agentRows.map((row) => [row.id, row.name])),
      rolesById: new Map(agentRows.map((row) => [row.id, row.role])),
      statusByAgent: new Map(stateRows.map((row) => [row.agentId, row])),
      instanceSettings,
      diskModes,
      groupNames: new Map(groupRows.map((group) => [group.id, group.name])),
    };
  }

  function labelFor(kind: SettableScopeKind, ref: string, model: CompanyModel): string {
    switch (kind) {
      case "group":
        return model.groupNames.get(ref) ?? ref;
      case "subtree":
        return model.agentsById.get(ref) ?? ref;
      default:
        return ref;
    }
  }

  function agentView(agentId: string, model: CompanyModel): ContainerAgentView {
    const plan = model.plan.plans.get(agentId);
    const resolution = model.resolutions.get(agentId);
    const status = model.statusByAgent.get(agentId) ?? null;
    const containerKey = plan?.containerKey ?? `agent:${agentId}`;
    return {
      agentId,
      name: model.agentsById.get(agentId) ?? agentId,
      role: model.rolesById.get(agentId) ?? null,
      containerKey,
      shared: plan?.shared ?? false,
      scope: plan?.scope
        ? { kind: plan.scope.kind, ref: plan.scope.id, label: labelFor(plan.scope.kind, plan.scope.id, model) }
        : null,
      source: resolution?.effective.source ?? "default",
      reason: plan?.reason ?? "default",
      problems: resolution?.problems ?? [],
      appliedContainerKey: status?.appliedContainerKey ?? null,
      restartRequired: Boolean(status?.restartRequiredAt),
      restartReason: status?.restartReason ?? null,
      enrolled: plan?.roster.includes(agentId) ?? true,
    };
  }

  async function overview(companyId: string): Promise<ContainerScopeOverview> {
    const model = await loadModel(companyId);

    const containers: ContainerView[] = model.plan.containers.map((row) => ({
      containerKey: row.containerKey,
      shared: row.shared,
      scope: row.scope
        ? { kind: row.scope.kind, ref: row.scope.id, label: labelFor(row.scope.kind, row.scope.id, model) }
        : null,
      members: [...row.roster]
        .map((agentId) => ({ agentId, name: model.agentsById.get(agentId) ?? agentId }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      limits: row.limits,
      restartRequired: [...row.roster]
        .filter((agentId) => Boolean(model.statusByAgent.get(agentId)?.restartRequiredAt))
        .sort(),
    }));

    const instances: ContainerInstanceView[] = model.instanceSettings.map((setting) => ({
      kind: setting.kind,
      ref: setting.id,
      mode: setting.mode,
      diskMode: model.diskModes.get(settingKey(setting.kind, setting.id)) ?? null,
      label: labelFor(setting.kind, setting.id, model),
      agentCount: [...model.resolutions.values()].filter(
        (resolution) => resolution.effective.scope?.kind === setting.kind && resolution.effective.scope.id === setting.id,
      ).length,
    }));

    const agents = [...model.agentsById.keys()].map((agentId) => agentView(agentId, model));
    agents.sort((a, b) => a.name.localeCompare(b.name));
    containers.sort((a, b) => a.containerKey.localeCompare(b.containerKey));

    return {
      instances: instances.sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`)),
      containers,
      agents,
      enrolments: model.plan.containers.map((row) => ({
        containerKey: row.containerKey,
        shared: row.shared,
        roster: [...row.roster],
      })),
      limits,
      sharedAgentCount: containers.filter((row) => row.shared).reduce((sum, row) => sum + row.members.length, 0),
    };
  }

  /** Why `ref` cannot name an instance of `kind` in this company, or null. */
  async function refProblem(companyId: string, kind: SettableScopeKind, ref: string): Promise<string | null> {
    if (kind === "company") return ref === companyId ? null : "is not this company";
    const problem = scopeIdProblem(kind, ref);
    if (problem) return problem;
    if (kind === "group") return (await store.groupExists(companyId, ref)) ? null : "does not name a group of this company";
    if (kind === "subtree") return (await store.agentExists(companyId, ref)) ? null : "does not name an agent of this company";
    if (kind === "project") return (await store.projectExists(companyId, ref)) ? null : "does not name a project of this company";
    return null;
  }

  async function recompute(companyId: string): Promise<{ agents: number; restartRequired: string[] }> {
    const model = await loadModel(companyId);
    const timestamp = new Date();
    const restartRequired: string[] = [];
    const writes: ContainerStateWrite[] = [];

    for (const [agentId, plan] of model.plan.plans) {
      const status = model.statusByAgent.get(agentId) ?? null;
      const applied = status?.appliedContainerKey ?? null;
      const needsRestart = containerRestartRequired({
        agentId,
        appliedContainerKey: applied,
        resolvedContainerKey: plan.containerKey,
      });
      if (needsRestart) restartRequired.push(agentId);
      writes.push({
        agentId,
        appliedContainerKey: applied,
        restartRequiredAt: needsRestart ? (status?.restartRequiredAt ?? timestamp) : null,
        restartReason: needsRestart ? (applied === null ? CONTAINER_REASON_APPLIED : CONTAINER_REASON_CHANGED) : null,
      });
    }

    await store.saveStates(companyId, writes);
    return { agents: writes.length, restartRequired };
  }

  async function setInstance(companyId: string, input: SetContainerInstanceInput): Promise<SetContainerInstanceResult | null> {
    if (!isContainerMode(input.mode)) return null;
    const problem = await refProblem(companyId, input.kind, input.ref);
    if (problem) return null;
    const row = await store.upsertContainerSetting(companyId, {
      kind: input.kind,
      scopeId: input.ref,
      mode: input.mode,
    });
    if (!row) return null;
    const recomputed = await recompute(companyId);
    const model = await loadModel(companyId);
    const agentIds = [...model.resolutions.values()]
      .filter((resolution) => resolution.effective.scope?.kind === row.kind && resolution.effective.scope.id === row.scopeId)
      .map((resolution) => resolution.agentId)
      .sort();
    return {
      instance: {
        kind: row.kind,
        ref: row.scopeId,
        mode: row.mode,
        diskMode: model.diskModes.get(settingKey(row.kind, row.scopeId)) ?? null,
        label: labelFor(row.kind, row.scopeId, model),
        agentCount: agentIds.length,
      },
      restartRequired: recomputed.restartRequired,
    };
  }

  async function removeInstance(companyId: string, kind: SettableScopeKind, ref: string): Promise<boolean> {
    const removed = await store.deleteContainerSetting(companyId, kind, ref);
    if (!removed) return false;
    await recompute(companyId);
    return true;
  }

  async function markApplied(companyId: string, agentId: string, containerKey: string): Promise<ContainerAgentView | null> {
    const model = await loadModel(companyId);
    const plan = model.plan.plans.get(agentId);
    if (!plan || plan.containerKey !== containerKey) return null;
    const status = await store.markApplied(companyId, agentId, containerKey);
    if (!status) return null;
    const after: CompanyModel = { ...model, statusByAgent: new Map(model.statusByAgent).set(agentId, status) };
    return agentView(agentId, after);
  }

  async function actions(
    companyId: string,
    request: ContainerScopeActionRequest,
  ): Promise<ContainerScopeActionResult | null> {
    const model = await loadModel(companyId);
    const plan = model.plan.plans.get(request.agentId);
    if (!plan) return null;
    const planned: ContainerAction[] = planContainerActions(model.plan, {
      agentId: request.agentId,
      kind: request.kind,
    });
    return { agentId: request.agentId, actions: planned, shared: plan.shared };
  }

  return { overview, setInstance, removeInstance, recompute, markApplied, actions };
}
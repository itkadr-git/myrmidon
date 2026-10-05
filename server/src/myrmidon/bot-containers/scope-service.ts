// server/src/myrmidon/bot-containers/scope-service.ts
//
// myrmidon(BOT-DISK-F): the owner-managed side of the isolation scope of the bot
// disk: named groups, the isolated/shared mode of each scope instance, the
// per-agent choices, and "apply" (the owner's go-ahead to restart a bot onto a
// new layout). The resolver itself is packages/shared/src/myrmidon-isolation-scope.ts;
// this file only gathers its inputs from a store port and shapes the answers, so
// it is tested with an in-memory store (scope-service.myrmidon.test.ts) and the
// database wiring lives in scope-wiring.ts.
//
// Two layouts matter for a bot, and they are different on purpose:
//   - the EFFECTIVE layout: what the resolver computes from the current settings;
//   - the APPLIED layout: what the board keeps the container on right now.
// A change to groups, settings or choices moves the effective layout at once and
// leaves the applied one alone: the agent shows "restart required". The owner's
// `apply` copies effective to applied; the reconciler then sees the drift and
// recreates the container through its maintenance window, moving the directories
// first (scope-migration.ts). So no setting change restarts a bot by itself.

import {
  ISOLATED_LAYOUT,
  isScopeInstanceDirName,
  listScopeInstances,
  resolveIsolationScopes,
  sameScopeLayout,
  scopeIdProblem,
  type BotScopeAgentView,
  type BotScopeGroupView,
  type BotScopeOverview,
  type IsolationMode,
  type PutScopeAgentPrefBody,
  type ScopeAgentInput,
  type ScopeAgentPref,
  type ScopeLayout,
  type ScopeSettingInput,
  type SettableScopeKind,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound } from "../../errors.js";

export interface ScopeAgentRow extends ScopeAgentInput {
  name: string;
  /** The agent runs in a bot container (adapterConfig.container.enabled). */
  container: boolean;
}

export interface ScopePrefRow extends ScopeAgentPref {
  appliedLayout: ScopeLayout;
}

export interface ScopeGroupRow {
  id: string;
  name: string;
  memberIds: string[];
}

/** Everything the service reads and writes; the database wiring implements it. */
export interface ScopeStore {
  listAgents(companyId: string): Promise<ScopeAgentRow[]>;
  listGroups(companyId: string): Promise<ScopeGroupRow[]>;
  listSettings(companyId: string): Promise<ScopeSettingInput[]>;
  listPrefs(companyId: string): Promise<ScopePrefRow[]>;
  /** The ids among `agentIds` that are agents of the company. */
  agentsInCompany(companyId: string, agentIds: string[]): Promise<string[]>;
  projectExists(companyId: string, projectId: string): Promise<boolean>;
  /** Throws a unique violation as `conflict`-able: returns null when the name is taken. */
  createGroup(companyId: string, name: string, memberIds: string[]): Promise<ScopeGroupRow | null>;
  /** Null: no such group. `"name-taken"`: the new name clashes. */
  patchGroup(
    companyId: string,
    groupId: string,
    patch: { name?: string; memberIds?: string[] },
  ): Promise<ScopeGroupRow | null | "name-taken">;
  /** Deletes the group, its memberships and its setting; false: no such group. */
  deleteGroup(companyId: string, groupId: string): Promise<boolean>;
  putSetting(companyId: string, kind: SettableScopeKind, id: string, mode: IsolationMode): Promise<void>;
  /** False: there was no such setting. */
  deleteSetting(companyId: string, kind: SettableScopeKind, id: string): Promise<boolean>;
  putPref(companyId: string, agentId: string, pref: { isolate: boolean; groupId: string | null; projectId: string | null }): Promise<void>;
  setApplied(companyId: string, agentId: string, layout: ScopeLayout): Promise<void>;
}

export interface BotScopeService {
  overview(companyId: string): Promise<BotScopeOverview>;
  createGroup(companyId: string, input: { name: string; memberIds?: string[] }): Promise<BotScopeGroupView>;
  patchGroup(companyId: string, groupId: string, patch: { name?: string; memberIds?: string[] }): Promise<BotScopeGroupView>;
  deleteGroup(companyId: string, groupId: string): Promise<void>;
  putSetting(companyId: string, kind: SettableScopeKind, id: string, mode: IsolationMode): Promise<BotScopeOverview>;
  deleteSetting(companyId: string, kind: SettableScopeKind, id: string): Promise<BotScopeOverview>;
  putAgentPref(companyId: string, agentId: string, body: PutScopeAgentPrefBody): Promise<BotScopeAgentView>;
  /** Owner's go-ahead for one agent; refused while its scope has an open conflict. */
  apply(companyId: string, agentId: string): Promise<BotScopeAgentView>;
  /** Applies every agent whose scope is decided and differs; returns the agents applied and the ones skipped. */
  applyAll(companyId: string): Promise<{ applied: string[]; skipped: Array<{ agentId: string; reason: string }> }>;
  /** The layout the board keeps a bot's container on (the applied one). */
  appliedLayout(companyId: string, agentId: string): Promise<ScopeLayout>;
}

async function gather(store: ScopeStore, companyId: string) {
  const [agents, groups, settings, prefs] = await Promise.all([
    store.listAgents(companyId),
    store.listGroups(companyId),
    store.listSettings(companyId),
    store.listPrefs(companyId),
  ]);
  const resolutions = resolveIsolationScopes({ companyId, agents, groups, settings, prefs });
  const prefById = new Map(prefs.map((pref) => [pref.agentId, pref]));
  return { agents, groups, settings, prefs, prefById, resolutions };
}

function agentView(
  row: ScopeAgentRow,
  data: Awaited<ReturnType<typeof gather>>,
): BotScopeAgentView {
  const resolution = data.resolutions.get(row.id)!;
  const pref = data.prefById.get(row.id);
  const applied = pref?.appliedLayout ?? ISOLATED_LAYOUT;
  return {
    agentId: row.id,
    name: row.name,
    role: row.role,
    container: row.container,
    effective: resolution.effective,
    candidates: resolution.candidates,
    problems: resolution.problems,
    pref: { isolate: pref?.isolate ?? false, groupId: pref?.groupId ?? null, projectId: pref?.projectId ?? null },
    applied,
    restartRequired: !sameScopeLayout(applied, resolution.effective.layout),
  };
}

export function botScopeService(store: ScopeStore, options: { scopeRoot?: string | null } = {}): BotScopeService {
  async function overview(companyId: string): Promise<BotScopeOverview> {
    const data = await gather(store, companyId);
    const groups: BotScopeGroupView[] = data.groups
      .map((group) => ({
        id: group.id,
        name: group.name,
        memberIds: [...group.memberIds].sort(),
        mode: data.settings.find((s) => s.kind === "group" && s.id === group.id)?.mode ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      companyId,
      scopeRoot: options.scopeRoot ?? null,
      agents: data.agents.map((row) => agentView(row, data)).sort((a, b) => a.name.localeCompare(b.name)),
      groups,
      instances: listScopeInstances({ companyId, settings: data.settings }, data.resolutions),
    };
  }

  async function groupView(companyId: string, groupId: string): Promise<BotScopeGroupView> {
    const found = (await overview(companyId)).groups.find((g) => g.id === groupId);
    if (!found) throw notFound("Group not found");
    return found;
  }

  async function requireMembers(companyId: string, memberIds: string[] | undefined): Promise<string[]> {
    const unique = [...new Set(memberIds ?? [])];
    const known = new Set(await store.agentsInCompany(companyId, unique));
    const missing = unique.filter((id) => !known.has(id));
    if (missing.length > 0) throw badRequest("Some members are not agents of this company", { code: "scope_unknown_members", agentIds: missing });
    return unique;
  }

  async function agentOf(companyId: string, agentId: string): Promise<BotScopeAgentView> {
    const data = await gather(store, companyId);
    const row = data.agents.find((a) => a.id === agentId);
    if (!row) throw notFound("Agent not found");
    return agentView(row, data);
  }

  return {
    overview,

    async createGroup(companyId, input) {
      const members = await requireMembers(companyId, input.memberIds);
      const created = await store.createGroup(companyId, input.name, members);
      if (!created) throw conflict("A group with this name already exists", { code: "scope_group_name_taken" });
      return groupView(companyId, created.id);
    },

    async patchGroup(companyId, groupId, patch) {
      const members = patch.memberIds === undefined ? undefined : await requireMembers(companyId, patch.memberIds);
      const result = await store.patchGroup(companyId, groupId, { name: patch.name, memberIds: members });
      if (result === null) throw notFound("Group not found");
      if (result === "name-taken") throw conflict("A group with this name already exists", { code: "scope_group_name_taken" });
      return groupView(companyId, groupId);
    },

    async deleteGroup(companyId, groupId) {
      if (!(await store.deleteGroup(companyId, groupId))) throw notFound("Group not found");
    },

    async putSetting(companyId, kind, id, mode) {
      const problem = scopeIdProblem(kind, id);
      if (problem) throw badRequest(`Scope id ${problem}`, { code: "scope_id_invalid" });
      if (kind === "company" && id !== companyId) throw badRequest("The company scope is the company itself", { code: "scope_id_invalid" });
      if (kind === "group" && !(await store.listGroups(companyId)).some((g) => g.id === id)) throw notFound("Group not found");
      if (kind === "subtree" && (await store.agentsInCompany(companyId, [id])).length === 0) throw notFound("Agent not found");
      if (kind === "project" && !(await store.projectExists(companyId, id))) throw notFound("Project not found");
      await store.putSetting(companyId, kind, id, mode);
      return overview(companyId);
    },

    async deleteSetting(companyId, kind, id) {
      if (!(await store.deleteSetting(companyId, kind, id))) throw notFound("No such scope setting");
      return overview(companyId);
    },

    async putAgentPref(companyId, agentId, body) {
      const data = await gather(store, companyId);
      const row = data.agents.find((a) => a.id === agentId);
      if (!row) throw notFound("Agent not found");
      const current = data.prefById.get(agentId);
      const next = {
        isolate: body.isolate ?? current?.isolate ?? false,
        groupId: body.groupId === undefined ? (current?.groupId ?? null) : body.groupId,
        projectId: body.projectId === undefined ? (current?.projectId ?? null) : body.projectId,
      };
      if (next.groupId) {
        const defining = new Set(
          data.groups.filter((g) => g.memberIds.includes(agentId) && data.settings.some((s) => s.kind === "group" && s.id === g.id)).map((g) => g.id),
        );
        if (!defining.has(next.groupId)) {
          throw badRequest("The chosen group does not define an isolation scope for this agent", { code: "scope_choice_invalid" });
        }
      }
      if (next.projectId) {
        const defining = new Set(row.projectIds.filter((id) => data.settings.some((s) => s.kind === "project" && s.id === id)));
        if (!defining.has(next.projectId)) {
          throw badRequest("The chosen project does not define an isolation scope for this agent", { code: "scope_choice_invalid" });
        }
      }
      await store.putPref(companyId, agentId, next);
      return agentOf(companyId, agentId);
    },

    async apply(companyId, agentId) {
      const view = await agentOf(companyId, agentId);
      if (view.problems.length > 0) {
        throw conflict("This agent's isolation scope has an open choice; choose first", {
          code: "scope_choice_required",
          problems: view.problems,
        });
      }
      if (view.restartRequired) {
        const layout = view.effective.layout;
        if (layout.kind === "shared" && !isScopeInstanceDirName(layout.dirName)) {
          throw badRequest("Invalid scope instance", { code: "scope_id_invalid" });
        }
        await store.setApplied(companyId, agentId, layout);
      }
      return agentOf(companyId, agentId);
    },

    async applyAll(companyId) {
      const data = await gather(store, companyId);
      const applied: string[] = [];
      const skipped: Array<{ agentId: string; reason: string }> = [];
      for (const row of data.agents) {
        const view = agentView(row, data);
        if (!view.restartRequired) continue;
        if (view.problems.length > 0) {
          skipped.push({ agentId: row.id, reason: view.problems[0]!.code });
          continue;
        }
        await store.setApplied(companyId, row.id, view.effective.layout);
        applied.push(row.id);
      }
      return { applied, skipped };
    },

    async appliedLayout(companyId, agentId) {
      const pref = (await store.listPrefs(companyId)).find((p) => p.agentId === agentId);
      return pref?.appliedLayout ?? ISOLATED_LAYOUT;
    },
  };
}

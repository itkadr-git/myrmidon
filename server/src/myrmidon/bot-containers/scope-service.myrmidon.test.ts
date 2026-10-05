// myrmidon(BOT-DISK-F): the owner-managed side of the isolation scope, against an
// in-memory store: instances, groups, conflicts that need a choice, "restart
// required" and "apply". The resolver's own rules are tested in packages/shared.

import { describe, expect, it } from "vitest";
import { ISOLATED_LAYOUT, type IsolationMode, type ScopeLayout, type ScopeSettingInput, type SettableScopeKind } from "@paperclipai/shared";
import {
  botScopeService,
  type ScopeAgentRow,
  type ScopeGroupRow,
  type ScopePrefRow,
  type ScopeStore,
} from "./scope-service.js";

const COMPANY = "00000000-0000-4000-8000-0000000000c0";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function memoryStore(agents: ScopeAgentRow[], projects: string[] = []) {
  const groups: ScopeGroupRow[] = [];
  const settings: ScopeSettingInput[] = [];
  const prefs = new Map<string, ScopePrefRow>();
  let next = 100;
  const pref = (agentId: string): ScopePrefRow =>
    prefs.get(agentId) ?? { agentId, isolate: false, groupId: null, projectId: null, appliedLayout: ISOLATED_LAYOUT };
  const store: ScopeStore = {
    listAgents: async () => agents,
    listGroups: async () => groups.map((g) => ({ ...g, memberIds: [...g.memberIds] })),
    listSettings: async () => [...settings],
    listPrefs: async () => [...prefs.values()],
    agentsInCompany: async (_c, ids) => ids.filter((i) => agents.some((a) => a.id === i)),
    projectExists: async (_c, projectId) => projects.includes(projectId),
    createGroup: async (_c, name, memberIds) => {
      if (groups.some((g) => g.name === name)) return null;
      const group = { id: id(next++), name, memberIds };
      groups.push(group);
      return group;
    },
    patchGroup: async (_c, groupId, patch) => {
      const group = groups.find((g) => g.id === groupId);
      if (!group) return null;
      if (patch.name !== undefined && groups.some((g) => g.id !== groupId && g.name === patch.name)) return "name-taken";
      if (patch.name !== undefined) group.name = patch.name;
      if (patch.memberIds !== undefined) group.memberIds = patch.memberIds;
      return group;
    },
    deleteGroup: async (_c, groupId) => {
      const index = groups.findIndex((g) => g.id === groupId);
      if (index < 0) return false;
      groups.splice(index, 1);
      const at = settings.findIndex((s) => s.kind === "group" && s.id === groupId);
      if (at >= 0) settings.splice(at, 1);
      return true;
    },
    putSetting: async (_c, kind: SettableScopeKind, scopeId: string, mode: IsolationMode) => {
      const at = settings.findIndex((s) => s.kind === kind && s.id === scopeId);
      if (at >= 0) settings[at] = { kind, id: scopeId, mode };
      else settings.push({ kind, id: scopeId, mode });
    },
    deleteSetting: async (_c, kind, scopeId) => {
      const at = settings.findIndex((s) => s.kind === kind && s.id === scopeId);
      if (at < 0) return false;
      settings.splice(at, 1);
      return true;
    },
    putPref: async (_c, agentId, p) => {
      prefs.set(agentId, { ...pref(agentId), ...p });
    },
    setApplied: async (_c, agentId, layout: ScopeLayout) => {
      prefs.set(agentId, { ...pref(agentId), appliedLayout: layout });
    },
  };
  return { store, groups, settings, prefs };
}

const agent = (n: number, extra: Partial<ScopeAgentRow> = {}): ScopeAgentRow => ({
  id: id(n),
  name: `bot-${n}`,
  role: "engineer",
  reportsTo: null,
  catalogId: null,
  projectIds: [],
  container: true,
  ...extra,
});

describe("botScopeService", () => {
  it("everything is isolated and nothing needs a restart until something is configured", async () => {
    const { store } = memoryStore([agent(1), agent(2)]);
    const overview = await botScopeService(store, { scopeRoot: "/srv/scopes" }).overview(COMPANY);
    expect(overview.scopeRoot).toBe("/srv/scopes");
    expect(overview.agents.every((a) => a.effective.source === "default" && !a.restartRequired)).toBe(true);
    expect(overview.instances).toEqual([]);
  });

  it("a scope change marks the members restart required; apply moves them, and only them", async () => {
    const { store } = memoryStore([agent(1), agent(2), agent(3, { role: "marketing" })]);
    const service = botScopeService(store);
    const after = await service.putSetting(COMPANY, "caste", "engineer", "shared");
    const byId = new Map(after.agents.map((a) => [a.agentId, a]));
    expect(byId.get(id(1))).toMatchObject({ restartRequired: true, effective: { source: "caste", mode: "shared" } });
    expect(byId.get(id(3))!.restartRequired).toBe(false);
    expect(after.instances[0]).toMatchObject({ kind: "caste", id: "engineer", mode: "shared", memberIds: [id(1), id(2)] });

    const applied = await service.apply(COMPANY, id(1));
    expect(applied.restartRequired).toBe(false);
    expect(applied.applied).toEqual(applied.effective.layout);
    expect(await service.appliedLayout(COMPANY, id(1))).toEqual(applied.effective.layout);
    // the other member is still pending
    expect((await service.overview(COMPANY)).agents.find((a) => a.agentId === id(2))!.restartRequired).toBe(true);
  });

  it("changing the setting back removes the restart-required mark of an agent that was never applied", async () => {
    const { store } = memoryStore([agent(1)]);
    const service = botScopeService(store);
    await service.putSetting(COMPANY, "caste", "engineer", "shared");
    const back = await service.putSetting(COMPANY, "caste", "engineer", "isolated");
    expect(back.agents[0]!.restartRequired).toBe(false);
  });

  it("an agent in two groups that both define isolation needs a choice before it can be applied", async () => {
    const { store } = memoryStore([agent(1)]);
    const service = botScopeService(store);
    const a = await service.createGroup(COMPANY, { name: "a", memberIds: [id(1)] });
    const b = await service.createGroup(COMPANY, { name: "b", memberIds: [id(1)] });
    await service.putSetting(COMPANY, "group", a.id, "shared");
    await service.putSetting(COMPANY, "group", b.id, "isolated");
    const overview = await service.overview(COMPANY);
    expect(overview.agents[0]!.problems).toEqual([{ code: "group-conflict", groupIds: [a.id, b.id] }]);
    await expect(service.apply(COMPANY, id(1))).rejects.toMatchObject({ status: 409 });
    // a choice that is not one of the defining groups is refused
    await expect(service.putAgentPref(COMPANY, id(1), { groupId: id(999) })).rejects.toMatchObject({ status: 400 });
    const chosen = await service.putAgentPref(COMPANY, id(1), { groupId: a.id });
    expect(chosen.problems).toEqual([]);
    expect(chosen.effective.layout).toEqual({ kind: "shared", dirName: `group-${a.id}` });
    expect((await service.apply(COMPANY, id(1))).restartRequired).toBe(false);
  });

  it("apply-all applies the decided agents and reports the ones with an open choice", async () => {
    const p1 = id(71);
    const p2 = id(72);
    const { store } = memoryStore([agent(1), agent(2, { projectIds: [p1, p2] })], [p1, p2]);
    const service = botScopeService(store);
    await service.putSetting(COMPANY, "project", p1, "shared");
    await service.putSetting(COMPANY, "project", p2, "shared");
    await service.putSetting(COMPANY, "caste", "engineer", "shared");
    const result = await service.applyAll(COMPANY);
    // agent 1 is only in the caste; agent 2 resolves caste before project, so both are decided
    expect(result.applied.sort()).toEqual([id(1), id(2)]);
    expect(result.skipped).toEqual([]);
    // remove the caste: agent 2 now has two projects -> ambiguous, skipped
    await service.deleteSetting(COMPANY, "caste", "engineer");
    const next = await service.applyAll(COMPANY);
    expect(next.skipped).toEqual([{ agentId: id(2), reason: "project-ambiguous" }]);
  });

  it("groups: create, rename, member changes, name clash and delete without a restart", async () => {
    const { store, settings } = memoryStore([agent(1), agent(2)]);
    const service = botScopeService(store);
    const g = await service.createGroup(COMPANY, { name: "devs", memberIds: [id(1)] });
    expect(g.memberIds).toEqual([id(1)]);
    await expect(service.createGroup(COMPANY, { name: "devs" })).rejects.toMatchObject({ status: 409 });
    expect((await service.patchGroup(COMPANY, g.id, { name: "builders", memberIds: [id(1), id(2)] })).name).toBe("builders");
    await expect(service.createGroup(COMPANY, { name: "x", memberIds: [id(404)] })).rejects.toMatchObject({ status: 400 });
    await service.putSetting(COMPANY, "group", g.id, "shared");
    await service.deleteGroup(COMPANY, g.id);
    expect(settings).toEqual([]);
    expect((await service.overview(COMPANY)).groups).toEqual([]);
    await expect(service.deleteGroup(COMPANY, g.id)).rejects.toMatchObject({ status: 404 });
  });

  it("validates the scope an owner names", async () => {
    const { store } = memoryStore([agent(1)]);
    const service = botScopeService(store);
    await expect(service.putSetting(COMPANY, "caste", "../etc", "shared")).rejects.toMatchObject({ status: 400 });
    await expect(service.putSetting(COMPANY, "company", id(5), "shared")).rejects.toMatchObject({ status: 400 });
    await expect(service.putSetting(COMPANY, "group", id(5), "shared")).rejects.toMatchObject({ status: 404 });
    await expect(service.putSetting(COMPANY, "subtree", id(9), "shared")).rejects.toMatchObject({ status: 404 });
    await expect(service.putSetting(COMPANY, "project", id(9), "shared")).rejects.toMatchObject({ status: 404 });
    await expect(service.deleteSetting(COMPANY, "caste", "engineer")).rejects.toMatchObject({ status: 404 });
    await service.putSetting(COMPANY, "company", COMPANY, "shared");
  });

  it("keep isolated overrides every level", async () => {
    const { store } = memoryStore([agent(1)]);
    const service = botScopeService(store);
    await service.putSetting(COMPANY, "caste", "engineer", "shared");
    const view = await service.putAgentPref(COMPANY, id(1), { isolate: true });
    expect(view.effective).toMatchObject({ source: "agent", mode: "isolated" });
    expect(view.restartRequired).toBe(false);
  });
});

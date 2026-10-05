// myrmidon(CONTAINER-SCOPE): the service — the container of every agent, the
// one-container-per-instance mode, the restart markers and the rule that pausing
// one member of a shared container never stops the others. The store is a fake:
// this pins the behaviour, not the vendor.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTAINER_REASON_APPLIED,
  CONTAINER_REASON_CHANGED,
  containerScopeService,
} from "./service.js";
import type {
  ContainerInstanceRow,
  ContainerScopeAgentRow,
  ContainerScopeGroupRow,
  ContainerScopeStore,
  ContainerStateRow,
  ContainerStateWrite,
} from "./store.js";

const COMPANY = "company-a";
const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const AGENT_MKT = "33333333-3333-4333-8333-333333333333";
const GROUP_DEV = "55555555-5555-4555-8555-555555555555";
const PROJECT = "77777777-7777-4777-8777-777777777777";

const LIMITS = { memoryMb: 2048, cpus: 1 };

interface FakeState {
  agents: ContainerScopeAgentRow[];
  groups: ContainerScopeGroupRow[];
  disk: Array<{ kind: "group"; id: string; mode: "isolated" | "shared" }>;
  prefs: Array<{ agentId: string; isolate: boolean; groupId: string | null; projectId: string | null }>;
  instances: ContainerInstanceRow[];
  states: ContainerStateRow[];
  projects: string[];
}

function agent(id: string, name: string, role: string | null, reportsTo: string | null = null): ContainerScopeAgentRow {
  return { id, name, role, reportsTo, catalogId: null, projectIds: [], container: true };
}

function fakeState(): FakeState {
  return {
    agents: [
      agent(AGENT_A, "dev-1", "engineer"),
      agent(AGENT_B, "dev-2", "engineer", AGENT_A),
      agent(AGENT_MKT, "mkt-1", "cmo"),
    ],
    groups: [{ id: GROUP_DEV, name: "Developers", memberIds: [AGENT_A, AGENT_B] }],
    disk: [],
    prefs: [],
    instances: [],
    states: [],
    projects: [PROJECT],
  };
}

function fakeStore(state: FakeState): ContainerScopeStore {
  return {
    listAgents: vi.fn(async () => state.agents),
    listGroups: vi.fn(async () => state.groups),
    listDiskSettings: vi.fn(async () => state.disk),
    listPrefs: vi.fn(async () => state.prefs),
    listContainerSettings: vi.fn(async () => state.instances),
    listStates: vi.fn(async () => state.states),
    upsertContainerSetting: vi.fn(async (_companyId: string, input: ContainerInstanceRow) => {
      const existing = state.instances.find(
        (row) => row.kind === input.kind && row.scopeId === input.scopeId,
      );
      if (existing) {
        existing.mode = input.mode;
        return existing;
      }
      state.instances.push({ ...input });
      return state.instances[state.instances.length - 1];
    }),
    deleteContainerSetting: vi.fn(async (_companyId: string, kind: ContainerInstanceRow["kind"], scopeId: string) => {
      const index = state.instances.findIndex((row) => row.kind === kind && row.scopeId === scopeId);
      if (index < 0) return false;
      state.instances.splice(index, 1);
      return true;
    }),
    saveStates: vi.fn(async (_companyId: string, rows: readonly ContainerStateWrite[]) => {
      for (const row of rows) {
        const existing = state.states.find((stateRow) => stateRow.agentId === row.agentId);
        if (existing) {
          existing.appliedContainerKey = row.appliedContainerKey;
          existing.restartRequiredAt = row.restartRequiredAt;
          existing.restartReason = row.restartReason;
        } else {
          state.states.push({ ...row });
        }
      }
    }),
    markApplied: vi.fn(async (_companyId: string, agentId: string, containerKey: string) => {
      const existing = state.states.find((row) => row.agentId === agentId);
      const row: ContainerStateRow = {
        agentId,
        appliedContainerKey: containerKey,
        restartRequiredAt: null,
        restartReason: null,
      };
      if (existing) Object.assign(existing, row);
      else state.states.push(row);
      return row;
    }),
    agentExists: vi.fn(async (_companyId: string, agentId: string) =>
      state.agents.some((row) => row.id === agentId),
    ),
    groupExists: vi.fn(async (_companyId: string, groupId: string) =>
      state.groups.some((row) => row.id === groupId),
    ),
    projectExists: vi.fn(async (_companyId: string, projectId: string) => state.projects.includes(projectId)),
  };
}

function serviceFor(state: FakeState) {
  return containerScopeService(fakeStore(state), { limits: LIMITS });
}

let state: FakeState;

beforeEach(() => {
  state = fakeState();
});

describe("myrmidon(CONTAINER-SCOPE) the container of an agent", () => {
  it("gives every agent its own container while nothing is configured", async () => {
    const overview = await serviceFor(state).overview(COMPANY);
    expect(overview.containers).toHaveLength(3);
    expect(overview.containers.every((row) => !row.shared)).toBe(true);
    expect(overview.sharedAgentCount).toBe(0);
    const dev = overview.agents.find((row) => row.agentId === AGENT_A);
    expect(dev?.containerKey).toBe(`agent:${AGENT_A}`);
    expect(dev?.source).toBe("default");
  });

  it("puts the members of a per-scope group into one container with one limit row", async () => {
    await serviceFor(state).setInstance(COMPANY, { kind: "group", ref: GROUP_DEV, mode: "per-scope" });
    const overview = await serviceFor(state).overview(COMPANY);

    const shared = overview.containers.filter((row) => row.shared);
    expect(shared).toHaveLength(1);
    expect(shared[0].containerKey).toBe(`scope:group-${GROUP_DEV}`);
    expect(shared[0].members.map((member) => member.agentId).sort()).toEqual([AGENT_A, AGENT_B].sort());
    expect(shared[0].limits).toEqual(LIMITS);
    // The marketer is in no instance and keeps its own container.
    expect(overview.agents.find((row) => row.agentId === AGENT_MKT)?.shared).toBe(false);
  });

  it("lets a container-only instance name an area even without a disk setting", async () => {
    state.disk = [];
    const result = await serviceFor(state).setInstance(COMPANY, { kind: "group", ref: GROUP_DEV, mode: "per-scope" });
    expect(result?.instance).toMatchObject({ kind: "group", ref: GROUP_DEV, mode: "per-scope", diskMode: "isolated" });
    const overview = await serviceFor(state).overview(COMPANY);
    expect(overview.agents.find((row) => row.agentId === AGENT_A)?.source).toBe("group");
  });

  it("keeps private containers when the instance is per-agent", async () => {
    await serviceFor(state).setInstance(COMPANY, { kind: "group", ref: GROUP_DEV, mode: "per-agent" });
    const overview = await serviceFor(state).overview(COMPANY);
    expect(overview.containers.filter((row) => row.shared)).toHaveLength(0);
    expect(overview.agents.find((row) => row.agentId === AGENT_A)?.reason).toBe("instance-per-agent");
  });

  it("counts the agents of an instance in the overview", async () => {
    await serviceFor(state).setInstance(COMPANY, { kind: "group", ref: GROUP_DEV, mode: "per-scope" });
    const overview = await serviceFor(state).overview(COMPANY);
    const instance = overview.instances.find((row) => row.ref === GROUP_DEV);
    expect(instance?.agentCount).toBe(2);
    expect(instance?.label).toBe("Developers");
  });

  it("enrols every container for the runtime", async () => {
    await serviceFor(state).setInstance(COMPANY, { kind: "group", ref: GROUP_DEV, mode: "per-scope" });
    const overview = await serviceFor(state).overview(COMPANY);
    const shared = overview.enrolments.find((row) => row.shared);
    expect(shared?.roster.sort()).toEqual([AGENT_A, AGENT_B].sort());
    expect(overview.enrolments).toHaveLength(2);
  });
});

describe("myrmidon(CONTAINER-SCOPE) writing an instance", () => {
  it("stores the mode of a group and reports who must be restarted", async () => {
    const result = await serviceFor(state).setInstance(COMPANY, { kind: "group", ref: GROUP_DEV, mode: "per-scope" });
    expect(result?.restartRequired.sort()).toEqual([AGENT_A, AGENT_B].sort());
    expect(state.instances).toEqual([{ kind: "group", scopeId: GROUP_DEV, mode: "per-scope" }]);
  });

  it("refuses an instance that names nothing of this company", async () => {
    const service = serviceFor(state);
    expect(await service.setInstance(COMPANY, { kind: "group", ref: AGENT_MKT, mode: "per-scope" })).toBeNull();
    expect(await service.setInstance(COMPANY, { kind: "project", ref: AGENT_A, mode: "per-scope" })).toBeNull();
    expect(await service.setInstance(COMPANY, { kind: "company", ref: "company-b", mode: "per-scope" })).toBeNull();
    expect(await service.setInstance(COMPANY, { kind: "caste", ref: "Engineer Upper", mode: "per-scope" })).toBeNull();
    expect(state.instances).toHaveLength(0);
  });

  it("accepts a subtree root, a project of the company and the company itself", async () => {
    const service = serviceFor(state);
    expect(await service.setInstance(COMPANY, { kind: "subtree", ref: AGENT_A, mode: "per-scope" })).not.toBeNull();
    expect(await service.setInstance(COMPANY, { kind: "project", ref: PROJECT, mode: "per-scope" })).not.toBeNull();
    expect(await service.setInstance(COMPANY, { kind: "company", ref: COMPANY, mode: "per-scope" })).not.toBeNull();
    expect(state.instances).toHaveLength(3);
  });

  it("removes a setting and recomputes", async () => {
    const service = serviceFor(state);
    await service.setInstance(COMPANY, { kind: "group", ref: GROUP_DEV, mode: "per-scope" });
    expect(await service.removeInstance(COMPANY, "group", GROUP_DEV)).toBe(true);
    expect(await service.removeInstance(COMPANY, "group", GROUP_DEV)).toBe(false);
    const overview = await service.overview(COMPANY);
    expect(overview.containers.filter((row) => row.shared)).toHaveLength(0);
  });
});

describe("myrmidon(CONTAINER-SCOPE) restart markers and applied containers", () => {
  it("marks an agent for a restart when its container is not the one that runs", async () => {
    await serviceFor(state).setInstance(COMPANY, { kind: "group", ref: GROUP_DEV, mode: "per-scope" });
    state.states = [
      { agentId: AGENT_A, appliedContainerKey: `agent:${AGENT_A}`, restartRequiredAt: null, restartReason: null },
      { agentId: AGENT_B, appliedContainerKey: `scope:group-${GROUP_DEV}`, restartRequiredAt: null, restartReason: null },
    ];
    const recomputed = await serviceFor(state).recompute(COMPANY);
    expect(recomputed.restartRequired).toEqual([AGENT_A]);
    const marked = state.states.find((row) => row.agentId === AGENT_A);
    expect(marked?.restartReason).toBe(CONTAINER_REASON_CHANGED);
    expect(state.states.find((row) => row.agentId === AGENT_B)?.restartRequiredAt).toBeNull();
  });

  it("names the first apply as its own reason", async () => {
    await serviceFor(state).setInstance(COMPANY, { kind: "group", ref: GROUP_DEV, mode: "per-scope" });
    const reason = state.states.find((row) => row.agentId === AGENT_A)?.restartReason;
    expect(reason).toBe(CONTAINER_REASON_APPLIED);
  });

  it("clears the marker when the runtime reports the container it applied", async () => {
    const service = serviceFor(state);
    await service.setInstance(COMPANY, { kind: "group", ref: GROUP_DEV, mode: "per-scope" });
    const applied = await service.markApplied(COMPANY, AGENT_A, `scope:group-${GROUP_DEV}`);
    expect(applied?.restartRequired).toBe(false);
    expect(applied?.appliedContainerKey).toBe(`scope:group-${GROUP_DEV}`);
    expect(state.states.find((row) => row.agentId === AGENT_A)?.restartRequiredAt).toBeNull();
  });

  it("refuses a container key the agent does not resolve to", async () => {
    const service = serviceFor(state);
    await service.setInstance(COMPANY, { kind: "group", ref: GROUP_DEV, mode: "per-scope" });
    expect(await service.markApplied(COMPANY, AGENT_A, `scope:group-${PROJECT}`)).toBeNull();
    expect(await service.markApplied(COMPANY, "unknown-agent", `agent:unknown-agent`)).toBeNull();
  });
});

describe("myrmidon(CONTAINER-SCOPE) one agent inside a shared container", () => {
  it("pauses one member and keeps the other members running", async () => {
    const service = serviceFor(state);
    await service.setInstance(COMPANY, { kind: "group", ref: GROUP_DEV, mode: "per-scope" });
    const planned = await service.actions(COMPANY, { agentId: AGENT_A, kind: "pause" });
    expect(planned?.shared).toBe(true);
    expect(planned?.actions).toEqual([
      { agentId: AGENT_A, action: "stop", note: "container-keeps-running" },
      { agentId: AGENT_B, action: "keep", note: "container-shared" },
    ]);
  });

  it("pauses an agent without a shared container on its own", async () => {
    const planned = await serviceFor(state).actions(COMPANY, { agentId: AGENT_MKT, kind: "pause" });
    expect(planned?.actions).toEqual([{ agentId: AGENT_MKT, action: "stop", note: "container-private" }]);
  });

  it("answers nothing for an agent of another company", async () => {
    expect(await serviceFor(state).actions(COMPANY, { agentId: "unknown", kind: "pause" })).toBeNull();
  });
});
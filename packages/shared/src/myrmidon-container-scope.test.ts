// myrmidon(CONTAINER-SCOPE): the container axis of an isolation area — the plain
// cases, the one rule the ticket names (pausing one member of a shared container
// never stops the others) and one end-to-end pass over the real resolver.
import { describe, expect, it } from "vitest";
import {
  resolveIsolationScopes,
  type AgentScopeResolution,
  type ScopeSettingInput,
} from "./myrmidon-isolation-scope.js";
import {
  CONTAINER_MODES,
  containerEnrolment,
  containerKeyForAgent,
  containerRestartRequired,
  containerRoster,
  isContainerMode,
  planContainerActions,
  planContainers,
  type ContainerInstanceSetting,
} from "./myrmidon-container-scope.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT_A = "22222222-2222-4222-8222-222222222222";
const AGENT_B = "33333333-3333-4333-8333-333333333333";
const AGENT_C = "44444444-4444-4444-8444-444444444444";
const GROUP_DEV = "55555555-5555-4555-8555-555555555555";
const GROUP_MKT = "66666666-6666-4666-8666-666666666666";

const LIMITS = { memoryMb: 4096, cpus: 2 };

function resolution(
  agentId: string,
  effective: Partial<AgentScopeResolution["effective"]> = {},
): AgentScopeResolution {
  return {
    agentId,
    effective: {
      source: "default",
      scope: null,
      mode: "isolated",
      layout: { kind: "isolated" },
      ...effective,
    },
    candidates: [],
    problems: [],
  };
}

function resolutionsOf(...rows: AgentScopeResolution[]): Map<string, AgentScopeResolution> {
  return new Map(rows.map((row) => [row.agentId, row]));
}

function setting(kind: ContainerInstanceSetting["kind"], id: string, mode: ContainerInstanceSetting["mode"]): ContainerInstanceSetting {
  return { kind, id, mode };
}

describe("myrmidon(CONTAINER-SCOPE) the container of an agent", () => {
  it("answers the modes", () => {
    expect(CONTAINER_MODES).toEqual(["per-agent", "per-scope"]);
    expect(isContainerMode("per-scope")).toBe(true);
    expect(isContainerMode("shared")).toBe(false);
    expect(isContainerMode(null)).toBe(false);
  });

  it("keeps the container of an agent with no area", () => {
    const decided = containerKeyForAgent({
      companyId: COMPANY,
      agentId: AGENT_A,
      resolution: resolution(AGENT_A),
      settings: new Map(),
    });
    expect(decided).toEqual({ containerKey: `agent:${AGENT_A}`, shared: false, scope: null, reason: "default" });
  });

  it("lets an explicit agent override keep its own container", () => {
    const decided = containerKeyForAgent({
      companyId: COMPANY,
      agentId: AGENT_A,
      resolution: resolution(AGENT_A, { source: "agent" }),
      settings: new Map([[`group\u0000${GROUP_DEV}`, setting("group", GROUP_DEV, "per-scope")]]),
    });
    expect(decided.shared).toBe(false);
    expect(decided.reason).toBe("agent-isolated");
  });

  it("shares the container of a per-scope instance and names it after the instance", () => {
    const decided = containerKeyForAgent({
      companyId: COMPANY,
      agentId: AGENT_A,
      resolution: resolution(AGENT_A, {
        source: "group",
        scope: { kind: "group", id: GROUP_DEV, mode: "shared" },
        mode: "shared",
        layout: { kind: "shared", dirName: `group-${GROUP_DEV}` },
      }),
      settings: new Map([[`group\u0000${GROUP_DEV}`, setting("group", GROUP_DEV, "per-scope")]]),
    });
    expect(decided).toEqual({
      containerKey: `scope:group-${GROUP_DEV}`,
      shared: true,
      scope: { kind: "group", id: GROUP_DEV },
      reason: "instance-per-scope",
    });
  });

  it("keeps a private container when the instance is per-agent", () => {
    const decided = containerKeyForAgent({
      companyId: COMPANY,
      agentId: AGENT_A,
      resolution: resolution(AGENT_A, { source: "group", scope: { kind: "group", id: GROUP_DEV, mode: "isolated" } }),
      settings: new Map([[`group\u0000${GROUP_DEV}`, setting("group", GROUP_DEV, "per-agent")]]),
    });
    expect(decided.shared).toBe(false);
    expect(decided.reason).toBe("instance-per-agent");
  });

  it("never merges strangers when the instance id cannot name a container", () => {
    const decided = containerKeyForAgent({
      companyId: COMPANY,
      agentId: AGENT_A,
      resolution: resolution(AGENT_A, { source: "caste", scope: { kind: "caste", id: "Engineer Upper", mode: "shared" } }),
      settings: new Map([[`caste\u0000Engineer Upper`, setting("caste", "Engineer Upper", "per-scope")]]),
    });
    expect(decided.shared).toBe(false);
    expect(decided.reason).toBe("instance-invalid");
  });
});

describe("myrmidon(CONTAINER-SCOPE) the containers of a company", () => {
  it("gives every member of one instance the same container and roster", () => {
    const result = planContainers({
      companyId: COMPANY,
      resolutions: resolutionsOf(
        resolution(AGENT_A, { source: "group", scope: { kind: "group", id: GROUP_DEV, mode: "shared" } }),
        resolution(AGENT_B, { source: "group", scope: { kind: "group", id: GROUP_DEV, mode: "shared" } }),
        resolution(AGENT_C),
      ),
      settings: [setting("group", GROUP_DEV, "per-scope")],
      limits: LIMITS,
    });

    expect(result.plans.get(AGENT_A)?.containerKey).toBe(`scope:group-${GROUP_DEV}`);
    expect(result.plans.get(AGENT_B)?.roster).toEqual([AGENT_A, AGENT_B].sort());
    expect(result.plans.get(AGENT_C)?.containerKey).toBe(`agent:${AGENT_C}`);
    expect(result.plans.get(AGENT_A)?.limits).toEqual(LIMITS);
    expect(result.containers).toHaveLength(2);
    const shared = result.containers.find((row) => row.shared);
    expect(shared?.roster).toEqual([AGENT_A, AGENT_B].sort());
  });

  it("never shares a container between two instances of one level", () => {
    const result = planContainers({
      companyId: COMPANY,
      resolutions: resolutionsOf(
        resolution(AGENT_A, { source: "group", scope: { kind: "group", id: GROUP_DEV, mode: "shared" } }),
        resolution(AGENT_B, { source: "group", scope: { kind: "group", id: GROUP_MKT, mode: "shared" } }),
      ),
      settings: [setting("group", GROUP_DEV, "per-scope"), setting("group", GROUP_MKT, "per-scope")],
      limits: LIMITS,
    });
    expect(result.containers).toHaveLength(2);
    expect(result.containers.every((row) => row.shared)).toBe(true);
    expect(result.plans.get(AGENT_A)?.roster).not.toContain(AGENT_B);
  });

  it("carries one limit row per container, not one per member", () => {
    const result = planContainers({
      companyId: COMPANY,
      resolutions: resolutionsOf(
        resolution(AGENT_A, { source: "company", scope: { kind: "company", id: COMPANY, mode: "shared" } }),
        resolution(AGENT_B, { source: "company", scope: { kind: "company", id: COMPANY, mode: "shared" } }),
        resolution(AGENT_C, { source: "company", scope: { kind: "company", id: COMPANY, mode: "shared" } }),
      ),
      settings: [setting("company", COMPANY, "per-scope")],
      limits: LIMITS,
    });
    expect(result.containers).toHaveLength(1);
    expect(result.containers[0].roster).toHaveLength(3);
    expect(result.containers[0].limits).toEqual(LIMITS);
  });

  it("reads through the real resolver end to end", () => {
    const settings: ScopeSettingInput[] = [{ kind: "group", id: GROUP_DEV, mode: "shared" }];
    const resolutions = resolveIsolationScopes({
      companyId: COMPANY,
      agents: [
        { id: AGENT_A, role: "engineer", reportsTo: null, catalogId: null, projectIds: [] },
        { id: AGENT_B, role: "engineer", reportsTo: AGENT_A, catalogId: null, projectIds: [] },
        { id: AGENT_C, role: "cmo", reportsTo: null, catalogId: null, projectIds: [] },
      ],
      groups: [{ id: GROUP_DEV, name: "Developers", memberIds: [AGENT_A, AGENT_B] }],
      settings,
      prefs: [],
    });
    const result = planContainers({
      companyId: COMPANY,
      resolutions,
      settings: [setting("group", GROUP_DEV, "per-scope")],
      limits: LIMITS,
    });
    expect(resolutions.get(AGENT_A)?.effective.source).toBe("group");
    expect(result.plans.get(AGENT_A)?.containerKey).toBe(`scope:group-${GROUP_DEV}`);
    expect(containerRoster(result, AGENT_B)).toEqual([AGENT_A, AGENT_B].sort());
    expect(result.plans.get(AGENT_C)?.shared).toBe(false);
    expect(containerRoster(result, AGENT_C)).toEqual([AGENT_C]);
  });
});

describe("myrmidon(CONTAINER-SCOPE) one agent inside a shared container", () => {
  const shared = planContainers({
    companyId: COMPANY,
    resolutions: resolutionsOf(
      resolution(AGENT_A, { source: "group", scope: { kind: "group", id: GROUP_DEV, mode: "shared" } }),
      resolution(AGENT_B, { source: "group", scope: { kind: "group", id: GROUP_DEV, mode: "shared" } }),
    ),
    settings: [setting("group", GROUP_DEV, "per-scope")],
    limits: LIMITS,
  });

  const private_ = planContainers({
    companyId: COMPANY,
    resolutions: resolutionsOf(resolution(AGENT_C)),
    settings: [],
    limits: LIMITS,
  });

  it("pauses only the requested agent and keeps the other members running", () => {
    const actions = planContainerActions(shared, { agentId: AGENT_A, kind: "pause" });
    expect(actions).toEqual([
      { agentId: AGENT_A, action: "stop", note: "container-keeps-running" },
      { agentId: AGENT_B, action: "keep", note: "container-shared" },
    ]);
  });

  it("pauses a private agent on its own container", () => {
    expect(planContainerActions(private_, { agentId: AGENT_C, kind: "pause" })).toEqual([
      { agentId: AGENT_C, action: "stop", note: "container-private" },
    ]);
  });

  it("restarts one member without restarting the container of the others", () => {
    const actions = planContainerActions(shared, { agentId: AGENT_B, kind: "restart" });
    expect(actions.find((action) => action.agentId === AGENT_B)).toEqual({
      agentId: AGENT_B,
      action: "restart",
      note: "container-not-restarted",
    });
    expect(actions.find((action) => action.agentId === AGENT_A)?.action).toBe("keep");
  });

  it("resumes one member and leaves the others alone", () => {
    const actions = planContainerActions(shared, { agentId: AGENT_A, kind: "resume" });
    expect(actions.find((action) => action.agentId === AGENT_A)?.action).toBe("start");
    expect(actions.filter((action) => action.action === "keep")).toHaveLength(1);
  });

  it("asks for a restart only when the applied container is a different one", () => {
    const restart = (appliedContainerKey: string | null, resolvedContainerKey: string) =>
      containerRestartRequired({ agentId: AGENT_A, appliedContainerKey, resolvedContainerKey });
    // Nothing applied yet: the agent runs in its own container.
    expect(restart(null, `agent:${AGENT_A}`)).toBe(false);
    expect(restart(null, `scope:group-${GROUP_DEV}`)).toBe(true);
    expect(restart(`scope:group-${GROUP_DEV}`, `scope:group-${GROUP_DEV}`)).toBe(false);
    expect(restart(`agent:${AGENT_A}`, `scope:group-${GROUP_DEV}`)).toBe(true);
    expect(restart(`scope:group-${GROUP_DEV}`, `agent:${AGENT_A}`)).toBe(true);
  });

  it("enrols the agents of every container for the runtime", () => {
    const rows = containerEnrolment(shared);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      containerKey: `scope:group-${GROUP_DEV}`,
      shared: true,
      scope: { kind: "group", id: GROUP_DEV },
    });
    expect(rows[0].roster).toEqual([AGENT_A, AGENT_B].sort());
  });
});
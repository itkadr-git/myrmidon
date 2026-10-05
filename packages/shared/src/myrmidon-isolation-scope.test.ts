import { describe, expect, it } from "vitest";
import {
  botHostDirs,
  listScopeInstances,
  planScopeMigration,
  resolveIsolationScopes,
  scopeInstanceDirName,
  scopeIdProblem,
  type HostPathState,
  type ResolveIsolationScopesInput,
  type ScopeAgentInput,
} from "./myrmidon-isolation-scope.js";

const COMPANY = "00000000-0000-4000-8000-0000000000c0";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function agent(n: number, extra: Partial<ScopeAgentInput> = {}): ScopeAgentInput {
  return { id: id(n), role: "engineer", reportsTo: null, catalogId: null, projectIds: [], ...extra };
}

function input(over: Partial<ResolveIsolationScopesInput>): ResolveIsolationScopesInput {
  return { companyId: COMPANY, agents: [], groups: [], settings: [], prefs: [], ...over };
}

describe("resolveIsolationScopes", () => {
  it("defaults every agent to its own isolation", () => {
    const out = resolveIsolationScopes(input({ agents: [agent(1)] }));
    const r = out.get(id(1))!;
    expect(r.effective.source).toBe("default");
    expect(r.effective.layout).toEqual({ kind: "isolated" });
    expect(r.problems).toEqual([]);
  });

  it("resolves most specific first: agent > group > caste > subtree > project > catalog > company", () => {
    const a = agent(1, { reportsTo: id(9), projectIds: [id(70)], catalogId: "team-a" });
    const lead = agent(9, { role: "lead" });
    const settings = [
      { kind: "company" as const, id: COMPANY, mode: "shared" as const },
      { kind: "catalog" as const, id: "team-a", mode: "shared" as const },
      { kind: "project" as const, id: id(70), mode: "shared" as const },
      { kind: "subtree" as const, id: id(9), mode: "shared" as const },
      { kind: "caste" as const, id: "engineer", mode: "shared" as const },
      { kind: "group" as const, id: id(50), mode: "shared" as const },
    ];
    const groups = [{ id: id(50), name: "g", memberIds: [id(1)] }];
    const run = (drop: number) =>
      resolveIsolationScopes(input({ agents: [a, lead], groups, settings: settings.slice(0, settings.length - drop) })).get(id(1))!;
    expect(run(0).effective.source).toBe("group");
    // remove levels from the most specific one down
    const without = (kinds: string[]) =>
      resolveIsolationScopes(input({ agents: [a, lead], groups, settings: settings.filter((s) => !kinds.includes(s.kind)) })).get(id(1))!.effective.source;
    expect(without(["group"])).toBe("caste");
    expect(without(["group", "caste"])).toBe("subtree");
    expect(without(["group", "caste", "subtree"])).toBe("project");
    expect(without(["group", "caste", "subtree", "project"])).toBe("catalog");
    expect(without(["group", "caste", "subtree", "project", "catalog"])).toBe("company");
    expect(without(["group", "caste", "subtree", "project", "catalog", "company"])).toBe("default");
    const r = run(0);
    expect(r.candidates.map((c) => c.kind)).toEqual(["group", "caste", "subtree", "project", "catalog", "company"]);
    expect(r.effective.layout).toEqual({ kind: "shared", dirName: `group-${id(50)}` });
  });

  it("an agent override isolates it whatever the levels above say", () => {
    const out = resolveIsolationScopes(
      input({
        agents: [agent(1)],
        settings: [{ kind: "caste", id: "engineer", mode: "shared" }],
        prefs: [{ agentId: id(1), isolate: true, groupId: null, projectId: null }],
      }),
    );
    expect(out.get(id(1))!.effective).toMatchObject({ source: "agent", mode: "isolated", layout: { kind: "isolated" } });
    expect(out.get(id(1))!.candidates).toHaveLength(1);
  });

  it("an explicitly isolated level stops the search (no fall through to a shared lower level)", () => {
    const out = resolveIsolationScopes(
      input({
        agents: [agent(1)],
        settings: [
          { kind: "caste", id: "engineer", mode: "isolated" },
          { kind: "company", id: COMPANY, mode: "shared" },
        ],
      }),
    );
    expect(out.get(id(1))!.effective).toMatchObject({ source: "caste", mode: "isolated", layout: { kind: "isolated" } });
  });

  it("subtree: root and everybody below it, nearest configured root wins, cycles are cut", () => {
    const root = agent(1, { role: "boss" });
    const mid = agent(2, { reportsTo: id(1) });
    const leaf = agent(3, { reportsTo: id(2) });
    const outsider = agent(4);
    const settings = [
      { kind: "subtree" as const, id: id(1), mode: "shared" as const },
      { kind: "subtree" as const, id: id(2), mode: "isolated" as const },
    ];
    const out = resolveIsolationScopes(input({ agents: [root, mid, leaf, outsider], settings }));
    expect(out.get(id(1))!.effective.scope).toMatchObject({ kind: "subtree", id: id(1) });
    expect(out.get(id(2))!.effective.scope).toMatchObject({ id: id(2), mode: "isolated" });
    expect(out.get(id(3))!.effective.scope).toMatchObject({ id: id(2) });
    expect(out.get(id(4))!.effective.source).toBe("default");
    const cyc = resolveIsolationScopes(
      input({ agents: [agent(1, { reportsTo: id(2) }), agent(2, { reportsTo: id(1) })], settings: [] }),
    );
    expect(cyc.get(id(1))!.effective.source).toBe("default");
  });

  it("several projects that each define a scope are ambiguous until the agent chooses", () => {
    const a = agent(1, { projectIds: [id(70), id(71), id(72)] });
    const settings = [
      { kind: "project" as const, id: id(70), mode: "shared" as const },
      { kind: "project" as const, id: id(71), mode: "shared" as const },
    ];
    const open = resolveIsolationScopes(input({ agents: [a], settings })).get(id(1))!;
    expect(open.problems).toEqual([{ code: "project-ambiguous", projectIds: [id(70), id(71)] }]);
    expect(open.effective).toMatchObject({ source: "unresolved", layout: { kind: "isolated" } });
    const chosen = resolveIsolationScopes(
      input({ agents: [a], settings, prefs: [{ agentId: id(1), isolate: false, groupId: null, projectId: id(71) }] }),
    ).get(id(1))!;
    expect(chosen.problems).toEqual([]);
    expect(chosen.effective.scope).toMatchObject({ kind: "project", id: id(71) });
    // a choice that is not one of the defining projects does not resolve it
    const bad = resolveIsolationScopes(
      input({ agents: [a], settings, prefs: [{ agentId: id(1), isolate: false, groupId: null, projectId: id(72) }] }),
    ).get(id(1))!;
    expect(bad.problems).toHaveLength(1);
    // a project without a setting defines nothing: no ambiguity
    const single = resolveIsolationScopes(input({ agents: [a], settings: settings.slice(0, 1) })).get(id(1))!;
    expect(single.problems).toEqual([]);
    expect(single.effective.scope?.id).toBe(id(70));
  });

  it("an agent in several groups: only one may define its scope", () => {
    const groups = [
      { id: id(50), name: "a", memberIds: [id(1)] },
      { id: id(51), name: "b", memberIds: [id(1)] },
      { id: id(52), name: "c", memberIds: [id(1)] },
    ];
    const one = [{ kind: "group" as const, id: id(50), mode: "shared" as const }];
    expect(resolveIsolationScopes(input({ agents: [agent(1)], groups, settings: one })).get(id(1))!.problems).toEqual([]);
    const two = [...one, { kind: "group" as const, id: id(51), mode: "isolated" as const }];
    const conflict = resolveIsolationScopes(
      input({ agents: [agent(1)], groups, settings: [...two, { kind: "caste", id: "engineer", mode: "shared" }] }),
    ).get(id(1))!;
    expect(conflict.problems).toEqual([{ code: "group-conflict", groupIds: [id(50), id(51)] }]);
    // a conflict is not settled by falling to a lower level
    expect(conflict.effective).toMatchObject({ source: "unresolved", layout: { kind: "isolated" } });
    const solved = resolveIsolationScopes(
      input({ agents: [agent(1)], groups, settings: two, prefs: [{ agentId: id(1), isolate: false, groupId: id(50), projectId: null }] }),
    ).get(id(1))!;
    expect(solved.problems).toEqual([]);
    expect(solved.effective.layout).toEqual({ kind: "shared", dirName: `group-${id(50)}` });
  });

  it("different instances never share a directory, even for the same caste key in two companies", () => {
    const other = "00000000-0000-4000-8000-0000000000c1";
    expect(scopeInstanceDirName("caste", COMPANY, "engineer")).not.toBe(scopeInstanceDirName("caste", other, "engineer"));
    expect(scopeInstanceDirName("caste", COMPANY, "engineer")).not.toBe(scopeInstanceDirName("caste", COMPANY, "marketing"));
    expect(scopeInstanceDirName("group", COMPANY, id(50))).not.toBe(scopeInstanceDirName("project", COMPANY, id(50)));
    const roots = { volumeRoot: "/v", scopeRoot: "/s" };
    const dev = botHostDirs(roots, id(1), { kind: "shared", dirName: scopeInstanceDirName("caste", COMPANY, "engineer") });
    const mkt = botHostDirs(roots, id(2), { kind: "shared", dirName: scopeInstanceDirName("caste", COMPANY, "marketing") });
    expect(dev.base.startsWith(mkt.base)).toBe(false);
    expect(mkt.base.startsWith(dev.base)).toBe(false);
    expect(dev.hermes).toBe(`${dev.base}/${id(1)}/hermes`);
  });

  it("rejects ids that cannot be a directory name", () => {
    expect(scopeIdProblem("caste", "../x")).not.toBeNull();
    expect(scopeIdProblem("caste", "Engineer")).not.toBeNull();
    expect(scopeIdProblem("caste", "engineer_2")).toBeNull();
    expect(() => scopeInstanceDirName("caste", COMPANY, "a/b")).toThrow();
  });

  it("lists instances with the agents that resolved to each", () => {
    const settings = [
      { kind: "caste" as const, id: "engineer", mode: "shared" as const },
      { kind: "caste" as const, id: "marketing", mode: "isolated" as const },
    ];
    const agents = [agent(1), agent(2), agent(3, { role: "marketing" })];
    const resolutions = resolveIsolationScopes(input({ agents, settings }));
    const list = listScopeInstances({ companyId: COMPANY, settings }, resolutions);
    expect(list.find((i) => i.id === "engineer")).toMatchObject({ mode: "shared", memberIds: [id(1), id(2)] });
    expect(list.find((i) => i.id === "marketing")).toMatchObject({ mode: "isolated", dirName: null, memberIds: [id(3)] });
  });
});

describe("planScopeMigration", () => {
  const roots = { volumeRoot: "/v", scopeRoot: "/s" };
  const key = id(1);
  const shared = { kind: "shared" as const, dirName: "caste-x" };
  const fsOf = (map: Record<string, HostPathState>) => (p: string): HostPathState => map[p] ?? "absent";

  it("is a no-op between equal layouts", () => {
    expect(planScopeMigration({ roots, botKey: key, from: shared, to: shared, state: fsOf({}) })).toEqual({ ok: true, noop: true, steps: [] });
  });

  it("moves the three directories from the isolated layout into the instance, creating parents first", () => {
    const plan = planScopeMigration({
      roots, botKey: key, from: { kind: "isolated" }, to: shared,
      state: fsOf({ [`/v/${key}`]: "dir", [`/v/${key}/hermes`]: "dir", [`/v/${key}/workspace`]: "dir", [`/v/${key}/scratch`]: "empty-dir" }),
    });
    expect(plan).toEqual({
      ok: true,
      noop: false,
      steps: [
        { op: "mkdir", path: "/s/caste-x" },
        { op: "mkdir", path: `/s/caste-x/${key}` },
        { op: "move", from: `/v/${key}/hermes`, to: `/s/caste-x/${key}/hermes` },
        { op: "move", from: `/v/${key}/workspace`, to: `/s/caste-x/${key}/workspace` },
        { op: "move", from: `/v/${key}/scratch`, to: `/s/caste-x/${key}/scratch` },
      ],
    });
  });

  it("refuses on a conflict, with nothing planned (never merge, never overwrite)", () => {
    const plan = planScopeMigration({
      roots, botKey: key, from: { kind: "isolated" }, to: shared,
      state: fsOf({ [`/v/${key}/hermes`]: "dir", [`/s/caste-x/${key}/hermes`]: "dir", [`/v/${key}/workspace`]: "other" }),
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.conflicts.map((c) => c.path).sort()).toEqual([`/s/caste-x/${key}/hermes`, `/v/${key}/workspace`].sort());
    }
  });

  it("moves back out and accepts an empty target directory", () => {
    const plan = planScopeMigration({
      roots, botKey: key, from: shared, to: { kind: "isolated" },
      state: fsOf({
        [`/s/caste-x/${key}/hermes`]: "dir", [`/s/caste-x/${key}/workspace`]: "dir", [`/s/caste-x/${key}/scratch`]: "dir",
        [`/v/${key}`]: "dir", [`/v/${key}/hermes`]: "empty-dir",
      }),
    });
    expect(plan.ok && plan.steps.filter((s) => s.op === "move")).toHaveLength(3);
  });

  it("a bot with no data yet just gets the target created", () => {
    const plan = planScopeMigration({ roots, botKey: key, from: { kind: "isolated" }, to: shared, state: fsOf({}) });
    expect(plan.ok && plan.steps.every((s) => s.op === "mkdir")).toBe(true);
  });
});

describe("problems are reported only when they matter", () => {
  it("an ambiguous project is moot when the caste already decides", () => {
    const a = agent(1, { projectIds: [id(70), id(71)] });
    const settings = [
      { kind: "project" as const, id: id(70), mode: "shared" as const },
      { kind: "project" as const, id: id(71), mode: "shared" as const },
      { kind: "caste" as const, id: "engineer", mode: "shared" as const },
    ];
    const r = resolveIsolationScopes(input({ agents: [a], settings })).get(id(1))!;
    expect(r.problems).toEqual([]);
    expect(r.effective.source).toBe("caste");
  });

  it("a per-agent override silences a group conflict", () => {
    const groups = [
      { id: id(50), name: "a", memberIds: [id(1)] },
      { id: id(51), name: "b", memberIds: [id(1)] },
    ];
    const settings = [
      { kind: "group" as const, id: id(50), mode: "shared" as const },
      { kind: "group" as const, id: id(51), mode: "shared" as const },
    ];
    const r = resolveIsolationScopes(
      input({ agents: [agent(1)], groups, settings, prefs: [{ agentId: id(1), isolate: true, groupId: null, projectId: null }] }),
    ).get(id(1))!;
    expect(r.problems).toEqual([]);
  });
});

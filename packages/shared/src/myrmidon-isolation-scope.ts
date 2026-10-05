import { z } from "zod";

/**
 * Isolation scope of a bot's disk (myrmidon BOT-DISK-F), and the resolver that
 * decides, for every agent, which scope instance it belongs to.
 *
 * The module is pure (rows in, decisions out), has no Node imports and is shared
 * by the server (mounts, migration, API) and the UI (what an agent resolves to
 * and why). It is written to be reused by other policies: anything that needs
 * "which group of agents does this one belong to, most specific first" calls
 * {@link resolveIsolationScopes} with its own settings (the container scope
 * will do that later); only the {@link ScopeLayout} / host-path half is about
 * the bot disk.
 *
 * Levels, most specific first (the first level whose scope instance has an
 * explicit setting wins; nothing configured means the default):
 *
 *   1. `agent`    a per-agent override ("keep this bot isolated"), plus the
 *                 agent's own choice between several groups or projects;
 *   2. `group`    an explicit named group (first-class entity, any members);
 *   3. `caste`    the agent's role (`agents.role`, a key of the company caste
 *                 directory);
 *   4. `subtree`  the reporting subtree: the root agent and everybody under it
 *                 through `agents.reports_to`; the root's id names the instance;
 *   5. `project`  a project the agent works in;
 *   6. `catalog`  agents installed from the same catalog team;
 *   7. `company`  everybody.
 *
 * A scope instance is "isolated" (each member keeps its own disk, nothing is
 * shared) or "shared" (one host directory per instance, one pnpm store, a
 * subdirectory per member). Nothing configured anywhere resolves to `agent`
 * isolation, which is the single-mount layout of BOT-DISK-D.
 *
 * Two situations cannot be decided from the settings alone and need the owner's
 * choice; until it is made the agent stays isolated (nothing is shared on a
 * guess) and carries a {@link ScopeProblem}. A problem is reported only when it
 * matters: an ambiguous project is moot when the agent's group, caste or subtree
 * already decides, and neither matters under a per-agent override:
 *   - `group-conflict`: the agent is in several groups that each define an
 *     isolation scope (an agent may be in many groups, but only one defines it);
 *   - `project-ambiguous`: the agent is in several projects that each define
 *     one.
 * A group or project without a setting defines nothing and never conflicts.
 */

export const ISOLATION_SCOPE_KINDS = ["agent", "group", "caste", "subtree", "project", "catalog", "company"] as const;
export type IsolationScopeKind = (typeof ISOLATION_SCOPE_KINDS)[number];

/** Kinds that name a scope instance an owner can configure (everything but `agent`). */
export const SETTABLE_SCOPE_KINDS = ["group", "caste", "subtree", "project", "catalog", "company"] as const;
export type SettableScopeKind = (typeof SETTABLE_SCOPE_KINDS)[number];

export const ISOLATION_MODES = ["isolated", "shared"] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

/** Why an agent resolved where it did. `default` and `unresolved` name no level. */
export type IsolationSource = IsolationScopeKind | "default" | "unresolved";

/** Resolution order of the settable kinds (the `agent` override is checked before). */
const LEVEL_ORDER: readonly SettableScopeKind[] = ["group", "caste", "subtree", "project", "catalog", "company"];

// ---- inputs ---------------------------------------------------------------

export interface ScopeAgentInput {
  id: string;
  /** `agents.role`, a caste key. */
  role: string | null;
  /** `agents.reports_to`. */
  reportsTo: string | null;
  /** `metadata.paperclip.catalogTeam.catalogId` of an agent installed from a catalog team. */
  catalogId: string | null;
  /** Projects the agent works in. */
  projectIds: readonly string[];
}

export interface ScopeGroupInput {
  id: string;
  name: string;
  memberIds: readonly string[];
}

/** One explicitly configured scope instance. */
export interface ScopeSettingInput {
  kind: SettableScopeKind;
  /** The scope's own id: group id, role key, subtree root agent id, project id, catalog id; the company id for `company`. */
  id: string;
  mode: IsolationMode;
}

/** Per-agent choices (the `agent` level). */
export interface ScopeAgentPref {
  agentId: string;
  /** Keep this agent isolated whatever its groups, caste, subtree, project, catalog team or company say. */
  isolate: boolean;
  /** Which of several defining groups decides (must be one of them). */
  groupId: string | null;
  /** Which of several defining projects decides (must be one of them). */
  projectId: string | null;
}

export interface ResolveIsolationScopesInput {
  companyId: string;
  agents: readonly ScopeAgentInput[];
  groups: readonly ScopeGroupInput[];
  settings: readonly ScopeSettingInput[];
  prefs: readonly ScopeAgentPref[];
}

// ---- outputs --------------------------------------------------------------

export type ScopeProblem =
  | { code: "group-conflict"; groupIds: string[] }
  | { code: "project-ambiguous"; projectIds: string[] };

export interface ScopeCandidate {
  kind: SettableScopeKind;
  id: string;
  mode: IsolationMode;
}

export interface EffectiveScope {
  /** Level the decision came from. `agent` also stands for the default. */
  source: IsolationSource;
  /** The scope instance that decided; null for the override, the default and an unresolved conflict. */
  scope: ScopeCandidate | null;
  /** `shared` only when a scope instance with mode `shared` decided. */
  mode: IsolationMode;
  /** Host layout of the bot's disk under this decision. */
  layout: ScopeLayout;
}

export interface AgentScopeResolution {
  agentId: string;
  effective: EffectiveScope;
  /** Every configured scope instance the agent is in, most specific first (what it would resolve to without the override and the conflicts). */
  candidates: ScopeCandidate[];
  problems: ScopeProblem[];
}

/** The host layout of one bot's disk: its own tree, or a subdirectory of a scope instance. */
export type ScopeLayout = { kind: "isolated" } | { kind: "shared"; dirName: string };

export const ISOLATED_LAYOUT: ScopeLayout = { kind: "isolated" };

// ---- instance naming ------------------------------------------------------

const SCOPE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const INSTANCE_DIR_PATTERN = /^(group|caste|subtree|project|catalog|company)-[a-z0-9][a-z0-9_-]{0,99}$/;

/**
 * The id used in a scope instance's directory name. Role keys and catalog ids
 * are only unique inside one company, so those two carry the company id; the
 * other kinds already have globally unique ids. Two instances never share a
 * name, whichever company they belong to.
 */
export function scopeInstanceId(kind: SettableScopeKind, companyId: string, id: string): string {
  return kind === "caste" || kind === "catalog" ? `${companyId}-${id}` : id;
}

/** Why `id` cannot name a scope instance of `kind`, or null when it can. */
export function scopeIdProblem(kind: SettableScopeKind, id: string): string | null {
  if (kind === "company") return SCOPE_ID_PATTERN.test(id) ? null : "is not a valid company id";
  if (id.length > 63 || !SCOPE_ID_PATTERN.test(id)) {
    return "must be 1-63 lower-case letters, digits, '_' or '-', starting with a letter or digit";
  }
  return null;
}

/** `<kind>-<id>`, the directory of a shared scope instance under the shared root. */
export function scopeInstanceDirName(kind: SettableScopeKind, companyId: string, id: string): string {
  const name = `${kind}-${scopeInstanceId(kind, companyId, id)}`;
  if (!INSTANCE_DIR_PATTERN.test(name)) throw new Error(`scope instance ${kind}/${id} has no valid directory name`);
  return name;
}

export function isScopeInstanceDirName(value: string): boolean {
  return INSTANCE_DIR_PATTERN.test(value);
}

/** Stable identity of a layout, for comparing and for "restart required". */
export function scopeLayoutKey(layout: ScopeLayout): string {
  return layout.kind === "isolated" ? "isolated" : `shared:${layout.dirName}`;
}

export function sameScopeLayout(a: ScopeLayout, b: ScopeLayout): boolean {
  return scopeLayoutKey(a) === scopeLayoutKey(b);
}

// ---- resolver -------------------------------------------------------------

function settingKey(kind: SettableScopeKind, id: string): string {
  return `${kind}\u0000${id}`;
}

/**
 * Decides every agent's scope. Pure and total: an agent with no settings
 * anywhere resolves to the default (isolated per agent); a `reportsTo` cycle is
 * cut where it closes.
 */
export function resolveIsolationScopes(input: ResolveIsolationScopesInput): Map<string, AgentScopeResolution> {
  const settings = new Map<string, ScopeSettingInput>();
  for (const setting of input.settings) settings.set(settingKey(setting.kind, setting.id), setting);
  const setOf = (kind: SettableScopeKind, id: string | null | undefined): ScopeCandidate | null => {
    if (!id) return null;
    const found = settings.get(settingKey(kind, id));
    return found ? { kind: found.kind, id: found.id, mode: found.mode } : null;
  };

  const groupsOfAgent = new Map<string, string[]>();
  for (const group of input.groups) {
    for (const memberId of new Set(group.memberIds)) {
      const list = groupsOfAgent.get(memberId) ?? [];
      list.push(group.id);
      groupsOfAgent.set(memberId, list);
    }
  }
  const prefs = new Map(input.prefs.map((pref) => [pref.agentId, pref]));
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));

  const subtreeCandidate = (agent: ScopeAgentInput): ScopeCandidate | null => {
    // Nearest configured root wins: the agent itself, then its lead, and so on up.
    const seen = new Set<string>();
    let cursor: ScopeAgentInput | undefined = agent;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const found = setOf("subtree", cursor.id);
      if (found) return found;
      cursor = cursor.reportsTo ? byId.get(cursor.reportsTo) : undefined;
    }
    return null;
  };

  const result = new Map<string, AgentScopeResolution>();
  for (const agent of input.agents) {
    const pref = prefs.get(agent.id);
    const problems: ScopeProblem[] = [];
    const candidates: ScopeCandidate[] = [];

    // group: those that define a scope, and the one that decides.
    const definingGroups = (groupsOfAgent.get(agent.id) ?? []).filter((id) => setOf("group", id));
    let group: ScopeCandidate | null = null;
    let groupUnresolved = false;
    if (definingGroups.length === 1) {
      group = setOf("group", definingGroups[0]);
    } else if (definingGroups.length > 1) {
      const chosen = pref?.groupId && definingGroups.includes(pref.groupId) ? pref.groupId : null;
      if (chosen) group = setOf("group", chosen);
      else groupUnresolved = true;
    }
    for (const id of definingGroups) candidates.push(setOf("group", id)!);

    const caste = setOf("caste", agent.role?.trim().toLowerCase() ?? null);
    if (caste) candidates.push(caste);
    const subtree = subtreeCandidate(agent);
    if (subtree) candidates.push(subtree);

    const definingProjects = [...new Set(agent.projectIds)].filter((id) => setOf("project", id));
    let project: ScopeCandidate | null = null;
    let projectUnresolved = false;
    if (definingProjects.length === 1) {
      project = setOf("project", definingProjects[0]);
    } else if (definingProjects.length > 1) {
      const chosen = pref?.projectId && definingProjects.includes(pref.projectId) ? pref.projectId : null;
      if (chosen) project = setOf("project", chosen);
      else projectUnresolved = true;
    }
    for (const id of definingProjects) candidates.push(setOf("project", id)!);

    const catalog = setOf("catalog", agent.catalogId);
    if (catalog) candidates.push(catalog);
    const company = setOf("company", input.companyId);
    if (company) candidates.push(company);

    const decide = (source: IsolationSource, scope: ScopeCandidate | null): EffectiveScope => ({
      source,
      scope,
      mode: scope?.mode ?? "isolated",
      layout:
        scope && scope.mode === "shared"
          ? { kind: "shared", dirName: scopeInstanceDirName(scope.kind, input.companyId, scope.id) }
          : ISOLATED_LAYOUT,
    });

    let effective: EffectiveScope;
    if (pref?.isolate) {
      effective = decide("agent", null);
    } else if (groupUnresolved) {
      problems.push({ code: "group-conflict", groupIds: [...definingGroups] });
      effective = decide("unresolved", null);
    } else if (group) {
      effective = decide("group", group);
    } else if (caste) {
      effective = decide("caste", caste);
    } else if (subtree) {
      effective = decide("subtree", subtree);
    } else if (projectUnresolved) {
      problems.push({ code: "project-ambiguous", projectIds: [...definingProjects] });
      effective = decide("unresolved", null);
    } else if (project) {
      effective = decide("project", project);
    } else if (catalog) {
      effective = decide("catalog", catalog);
    } else if (company) {
      effective = decide("company", company);
    } else {
      effective = decide("default", null);
    }
    result.set(agent.id, { agentId: agent.id, effective, candidates, problems });
  }
  return result;
}

/** Members of every shared or isolated scope instance that some agent resolved to. */
export interface ScopeInstanceView {
  kind: SettableScopeKind;
  id: string;
  mode: IsolationMode;
  /** Directory name when the instance is shared. */
  dirName: string | null;
  /** Agents that resolved to this instance. */
  memberIds: string[];
}

/** The configured scope instances with the agents that currently resolve to each (members of a shared one share its directory). */
export function listScopeInstances(
  input: Pick<ResolveIsolationScopesInput, "companyId" | "settings">,
  resolutions: ReadonlyMap<string, AgentScopeResolution>,
): ScopeInstanceView[] {
  const views = new Map<string, ScopeInstanceView>();
  for (const setting of input.settings) {
    views.set(settingKey(setting.kind, setting.id), {
      kind: setting.kind,
      id: setting.id,
      mode: setting.mode,
      dirName: setting.mode === "shared" ? scopeInstanceDirName(setting.kind, input.companyId, setting.id) : null,
      memberIds: [],
    });
  }
  for (const resolution of resolutions.values()) {
    const scope = resolution.effective.scope;
    if (!scope) continue;
    views.get(settingKey(scope.kind, scope.id))?.memberIds.push(resolution.agentId);
  }
  return [...views.values()].sort(
    (a, b) => LEVEL_ORDER.indexOf(a.kind) - LEVEL_ORDER.indexOf(b.kind) || a.id.localeCompare(b.id),
  );
}

// ---- host layout and migration --------------------------------------------

export const SCOPE_BOT_DIRS = ["hermes", "workspace", "scratch"] as const;

export interface ScopeRoots {
  /** `MYRMIDON_BOT_VOLUME_ROOT`: one directory per isolated bot. */
  volumeRoot: string;
  /** The shared root: one directory per shared scope instance. */
  scopeRoot: string;
}

/** Host directories of a bot's disk under a layout. `base` is what a container binds. */
export function botHostDirs(
  roots: ScopeRoots,
  botKey: string,
  layout: ScopeLayout,
): { base: string; botDir: string; hermes: string; workspace: string; scratch: string } {
  const base = layout.kind === "isolated" ? `${roots.volumeRoot}/${botKey}` : `${roots.scopeRoot}/${layout.dirName}`;
  const botDir = layout.kind === "isolated" ? base : `${base}/${botKey}`;
  return {
    base,
    botDir,
    hermes: `${botDir}/hermes`,
    workspace: `${botDir}/workspace`,
    scratch: `${botDir}/scratch`,
  };
}

/** What is at a host path, as the migration needs to know it. */
export type HostPathState = "absent" | "empty-dir" | "dir" | "other";

export type ScopeMigrationStep =
  | { op: "mkdir"; path: string }
  | { op: "move"; from: string; to: string };

export interface ScopeMigrationConflict {
  path: string;
  reason: string;
}

export type ScopeMigrationPlan =
  | { ok: true; noop: boolean; steps: ScopeMigrationStep[] }
  | { ok: false; conflicts: ScopeMigrationConflict[] };

/**
 * Plans moving one bot's three directories from one layout to another. The plan
 * never deletes and never overwrites: a directory moves (rename) onto an absent
 * or empty target, anything else is a conflict and the whole plan is refused
 * before a single step runs. A bot with nothing on disk for a directory just
 * gets the target created. `state` answers what is at a host path.
 */
export function planScopeMigration(params: {
  roots: ScopeRoots;
  botKey: string;
  from: ScopeLayout;
  to: ScopeLayout;
  state: (path: string) => HostPathState;
}): ScopeMigrationPlan {
  if (sameScopeLayout(params.from, params.to)) return { ok: true, noop: true, steps: [] };
  const from = botHostDirs(params.roots, params.botKey, params.from);
  const to = botHostDirs(params.roots, params.botKey, params.to);
  const conflicts: ScopeMigrationConflict[] = [];
  const steps: ScopeMigrationStep[] = [];
  const made = new Set<string>();
  const mkdir = (path: string) => {
    if (made.has(path) || params.state(path) !== "absent") return;
    made.add(path);
    steps.push({ op: "mkdir", path });
  };
  if (params.to.kind === "shared") {
    mkdir(to.base);
    mkdir(to.botDir);
  } else {
    mkdir(to.botDir);
  }
  for (const name of SCOPE_BOT_DIRS) {
    const source = from[name];
    const target = to[name];
    const sourceState = params.state(source);
    const targetState = params.state(target);
    if (sourceState === "other") {
      conflicts.push({ path: source, reason: "is not a plain directory (a file or a link); refusing to move it" });
      continue;
    }
    if (sourceState === "absent") {
      // Nothing to move. A target that already exists is the result of an earlier,
      // interrupted run of this very move (the plan is idempotent); an absent one is created.
      if (targetState === "absent") steps.push({ op: "mkdir", path: target });
      else if (targetState === "other") conflicts.push({ path: target, reason: "is not a directory" });
      continue;
    }
    if (targetState === "other" || targetState === "dir") {
      conflicts.push({
        path: target,
        reason: targetState === "dir" ? "already holds data; refusing to merge or overwrite" : "is not a directory",
      });
      continue;
    }
    steps.push({ op: "move", from: source, to: target });
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, noop: false, steps };
}

// ---- API shapes -----------------------------------------------------------

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters");

const uuidList = z.array(z.string().uuid()).max(500);

export const createScopeGroupSchema = z.object({ name: nameSchema, memberIds: uuidList.optional() }).strict();
export const patchScopeGroupSchema = z.object({ name: nameSchema.optional(), memberIds: uuidList.optional() }).strict();

/** Body of `PUT .../bot-scopes/settings/:kind/:scopeId`. */
export const putScopeSettingSchema = z.object({ mode: z.enum(ISOLATION_MODES) }).strict();

/** Body of `PUT .../bot-scopes/agents/:agentId`; `null` clears a choice. */
export const putScopeAgentPrefSchema = z
  .object({
    isolate: z.boolean().optional(),
    groupId: z.string().uuid().nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type CreateScopeGroupBody = z.infer<typeof createScopeGroupSchema>;
export type PatchScopeGroupBody = z.infer<typeof patchScopeGroupSchema>;
export type PutScopeSettingBody = z.infer<typeof putScopeSettingSchema>;
export type PutScopeAgentPrefBody = z.infer<typeof putScopeAgentPrefSchema>;

export interface BotScopeAgentView {
  agentId: string;
  name: string;
  role: string | null;
  /** The agent runs in a bot container (only those have a disk to isolate). */
  container: boolean;
  effective: EffectiveScope;
  candidates: ScopeCandidate[];
  problems: ScopeProblem[];
  pref: { isolate: boolean; groupId: string | null; projectId: string | null };
  /** The layout the board keeps this agent's container on right now. */
  applied: ScopeLayout;
  /** Effective layout differs from the applied one: the container needs a restart (with the disk migration). */
  restartRequired: boolean;
}

export interface BotScopeGroupView {
  id: string;
  name: string;
  memberIds: string[];
  /** Isolation setting of the group; null while it defines none. */
  mode: IsolationMode | null;
}

export interface BotScopeOverview {
  companyId: string;
  /** Host directory of shared scope instances; null when the instance has none configured. */
  scopeRoot: string | null;
  agents: BotScopeAgentView[];
  groups: BotScopeGroupView[];
  instances: ScopeInstanceView[];
}

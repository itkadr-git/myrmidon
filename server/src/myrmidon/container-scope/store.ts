// server/src/myrmidon/container-scope/store.ts
//
// myrmidon(CONTAINER-SCOPE): the reads and writes behind the container axis.
// The area resolution itself reads the disk tables of BOT-DISK-F
// (myrmidon_scope_*) and runs through the one shared resolver; this store only
// adds the container settings and the container state of an agent.

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  agents,
  myrmidonContainerSettings,
  myrmidonContainerStates,
  myrmidonScopeAgentPrefs,
  myrmidonScopeGroupMembers,
  myrmidonScopeGroups,
  myrmidonScopeSettings,
  projectMemberships,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  ISOLATION_MODES,
  SETTABLE_SCOPE_KINDS,
  isContainerMode,
  type ContainerMode,
  type IsolationMode,
  type SettableScopeKind,
} from "@paperclipai/shared";

export interface ContainerScopeAgentRow {
  id: string;
  name: string;
  role: string | null;
  reportsTo: string | null;
  catalogId: string | null;
  projectIds: string[];
  /** True when the agent is allowed a container at all (its own or a shared one). */
  container: boolean;
}

export interface ContainerScopeGroupRow {
  id: string;
  name: string;
  memberIds: string[];
}

export interface ContainerScopeDiskSettingRow {
  kind: SettableScopeKind;
  id: string;
  mode: IsolationMode;
}

export interface ContainerScopePrefRow {
  agentId: string;
  isolate: boolean;
  groupId: string | null;
  projectId: string | null;
}

/** One row of the container axis: `per-agent` (default) or `per-scope`. */
export interface ContainerInstanceRow {
  kind: SettableScopeKind;
  scopeId: string;
  mode: ContainerMode;
}

export interface ContainerStateRow {
  agentId: string;
  appliedContainerKey: string | null;
  restartRequiredAt: Date | null;
  restartReason: string | null;
}

export interface ContainerStateWrite {
  agentId: string;
  appliedContainerKey: string | null;
  restartRequiredAt: Date | null;
  restartReason: string | null;
}

export interface ContainerScopeStore {
  listAgents(companyId: string): Promise<ContainerScopeAgentRow[]>;
  listGroups(companyId: string): Promise<ContainerScopeGroupRow[]>;
  listDiskSettings(companyId: string): Promise<ContainerScopeDiskSettingRow[]>;
  listPrefs(companyId: string): Promise<ContainerScopePrefRow[]>;
  listContainerSettings(companyId: string): Promise<ContainerInstanceRow[]>;
  listStates(companyId: string): Promise<ContainerStateRow[]>;
  upsertContainerSetting(
    companyId: string,
    input: { kind: SettableScopeKind; scopeId: string; mode: ContainerMode },
  ): Promise<ContainerInstanceRow | null>;
  deleteContainerSetting(companyId: string, kind: SettableScopeKind, scopeId: string): Promise<boolean>;
  saveStates(companyId: string, rows: readonly ContainerStateWrite[]): Promise<void>;
  markApplied(companyId: string, agentId: string, containerKey: string): Promise<ContainerStateRow | null>;
  agentExists(companyId: string, agentId: string): Promise<boolean>;
  groupExists(companyId: string, groupId: string): Promise<boolean>;
  projectExists(companyId: string, projectId: string): Promise<boolean>;
}

function catalogIdOf(metadata: unknown): string | null {
  const paperclip = (metadata as { paperclip?: { catalogTeam?: { catalogId?: unknown } } } | null)?.paperclip;
  const id = paperclip?.catalogTeam?.catalogId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function stateOf(row: {
  agentId: string;
  appliedContainerKey: string | null;
  restartRequiredAt: Date | null;
  restartReason: string | null;
}): ContainerStateRow {
  return {
    agentId: row.agentId,
    appliedContainerKey: row.appliedContainerKey,
    restartRequiredAt: row.restartRequiredAt,
    restartReason: row.restartReason,
  };
}

export function containerScopeStore(db: Db): ContainerScopeStore {
  async function members(groupIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (groupIds.length === 0) return map;
    const rows = await db
      .select({ groupId: myrmidonScopeGroupMembers.groupId, agentId: myrmidonScopeGroupMembers.agentId })
      .from(myrmidonScopeGroupMembers)
      .where(inArray(myrmidonScopeGroupMembers.groupId, groupIds));
    for (const row of rows) map.set(row.groupId, [...(map.get(row.groupId) ?? []), row.agentId]);
    return map;
  }

  return {
    async listAgents(companyId) {
      const rows = await db
        .select({
          id: agents.id,
          name: agents.name,
          role: agents.role,
          reportsTo: agents.reportsTo,
          metadata: agents.metadata,
          container: sql<boolean>`coalesce((${agents.adapterConfig} #>> '{container,enabled}') = 'true', false)`,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), sql`${agents.status} <> 'terminated'`));
      const ids = rows.map((row) => row.id);
      const projectIds = new Map<string, Set<string>>();
      const add = (agentId: string, projectId: string) =>
        projectIds.set(agentId, (projectIds.get(agentId) ?? new Set()).add(projectId));
      if (ids.length > 0) {
        const led = await db
          .select({ agentId: projects.leadAgentId, projectId: projects.id })
          .from(projects)
          .where(and(eq(projects.companyId, companyId), inArray(projects.leadAgentId, ids)));
        for (const row of led) if (row.agentId) add(row.agentId, row.projectId);
        const joined = await db
          .select({ userId: projectMemberships.userId, projectId: projectMemberships.projectId })
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.companyId, companyId),
              eq(projectMemberships.state, "joined"),
              inArray(projectMemberships.userId, ids),
            ),
          );
        for (const row of joined) add(row.userId, row.projectId);
      }
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        reportsTo: row.reportsTo,
        catalogId: catalogIdOf(row.metadata),
        projectIds: [...(projectIds.get(row.id) ?? [])].sort(),
        container: Boolean(row.container),
      }));
    },

    async listGroups(companyId) {
      const groups = await db
        .select({ id: myrmidonScopeGroups.id, name: myrmidonScopeGroups.name })
        .from(myrmidonScopeGroups)
        .where(eq(myrmidonScopeGroups.companyId, companyId));
      const byGroup = await members(groups.map((group) => group.id));
      return groups.map((group) => ({ id: group.id, name: group.name, memberIds: byGroup.get(group.id) ?? [] }));
    },

    async listDiskSettings(companyId) {
      const rows = await db
        .select({
          kind: myrmidonScopeSettings.scopeKind,
          id: myrmidonScopeSettings.scopeId,
          mode: myrmidonScopeSettings.mode,
        })
        .from(myrmidonScopeSettings)
        .where(eq(myrmidonScopeSettings.companyId, companyId));
      return rows
        .filter(
          (row) =>
            (SETTABLE_SCOPE_KINDS as readonly string[]).includes(row.kind) &&
            (ISOLATION_MODES as readonly string[]).includes(row.mode),
        )
        .map((row) => ({ kind: row.kind as SettableScopeKind, id: row.id, mode: row.mode as IsolationMode }));
    },

    async listPrefs(companyId) {
      const rows = await db
        .select({
          agentId: myrmidonScopeAgentPrefs.agentId,
          isolate: myrmidonScopeAgentPrefs.isolate,
          groupId: myrmidonScopeAgentPrefs.groupId,
          projectId: myrmidonScopeAgentPrefs.projectId,
        })
        .from(myrmidonScopeAgentPrefs)
        .where(eq(myrmidonScopeAgentPrefs.companyId, companyId));
      return rows.map((row) => ({
        agentId: row.agentId,
        isolate: row.isolate,
        groupId: row.groupId,
        projectId: row.projectId,
      }));
    },

    async listContainerSettings(companyId) {
      const rows = await db
        .select({
          kind: myrmidonContainerSettings.scopeKind,
          scopeId: myrmidonContainerSettings.scopeId,
          mode: myrmidonContainerSettings.containerMode,
        })
        .from(myrmidonContainerSettings)
        .where(eq(myrmidonContainerSettings.companyId, companyId));
      return rows
        .filter((row) => (SETTABLE_SCOPE_KINDS as readonly string[]).includes(row.kind) && isContainerMode(row.mode))
        .map((row) => ({ kind: row.kind as SettableScopeKind, scopeId: row.scopeId, mode: row.mode as ContainerMode }));
    },

    async listStates(companyId) {
      const rows = await db
        .select({
          agentId: myrmidonContainerStates.agentId,
          appliedContainerKey: myrmidonContainerStates.appliedContainerKey,
          restartRequiredAt: myrmidonContainerStates.restartRequiredAt,
          restartReason: myrmidonContainerStates.restartReason,
        })
        .from(myrmidonContainerStates)
        .where(eq(myrmidonContainerStates.companyId, companyId));
      return rows.map(stateOf);
    },

    async upsertContainerSetting(companyId, input) {
      const [row] = await db
        .insert(myrmidonContainerSettings)
        .values({
          companyId,
          scopeKind: input.kind,
          scopeId: input.scopeId,
          containerMode: input.mode,
        })
        .onConflictDoUpdate({
          target: [
            myrmidonContainerSettings.companyId,
            myrmidonContainerSettings.scopeKind,
            myrmidonContainerSettings.scopeId,
          ],
          set: { containerMode: input.mode, updatedAt: new Date() },
        })
        .returning();
      if (!row) return null;
      return { kind: row.scopeKind as SettableScopeKind, scopeId: row.scopeId, mode: row.containerMode as ContainerMode };
    },

    async deleteContainerSetting(companyId, kind, scopeId) {
      const rows = await db
        .delete(myrmidonContainerSettings)
        .where(
          and(
            eq(myrmidonContainerSettings.companyId, companyId),
            eq(myrmidonContainerSettings.scopeKind, kind),
            eq(myrmidonContainerSettings.scopeId, scopeId),
          ),
        )
        .returning({ id: myrmidonContainerSettings.id });
      return rows.length > 0;
    },

    async saveStates(companyId, rows) {
      if (rows.length === 0) return;
      const timestamp = new Date();
      for (const row of rows) {
        await db
          .insert(myrmidonContainerStates)
          .values({
            agentId: row.agentId,
            companyId,
            appliedContainerKey: row.appliedContainerKey,
            restartRequiredAt: row.restartRequiredAt,
            restartReason: row.restartReason,
            updatedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: myrmidonContainerStates.agentId,
            set: {
              appliedContainerKey: row.appliedContainerKey,
              restartRequiredAt: row.restartRequiredAt,
              restartReason: row.restartReason,
              updatedAt: timestamp,
            },
          });
      }
    },

    async markApplied(companyId, agentId, containerKey) {
      const [row] = await db
        .insert(myrmidonContainerStates)
        .values({
          agentId,
          companyId,
          appliedContainerKey: containerKey,
          restartRequiredAt: null,
          restartReason: null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: myrmidonContainerStates.agentId,
          set: {
            appliedContainerKey: containerKey,
            restartRequiredAt: null,
            restartReason: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row ? stateOf(row) : null;
    },

    async agentExists(companyId, agentId) {
      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
        .limit(1);
      return rows.length > 0;
    },

    async groupExists(companyId, groupId) {
      const rows = await db
        .select({ id: myrmidonScopeGroups.id })
        .from(myrmidonScopeGroups)
        .where(and(eq(myrmidonScopeGroups.companyId, companyId), eq(myrmidonScopeGroups.id, groupId)))
        .limit(1);
      return rows.length > 0;
    },

    async projectExists(companyId, projectId) {
      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
        .limit(1);
      return rows.length > 0;
    },
  };
}
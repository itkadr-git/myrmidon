// server/src/myrmidon/bot-containers/scope-wiring.ts
//
// myrmidon(BOT-DISK-F): the database behind scope-service.ts, the Express router
// for app.ts, and the two readers the bot driver and the profile compiler call on
// every pass (the layout the board keeps a bot's container on).

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  agents,
  myrmidonScopeAgentPrefs,
  myrmidonScopeGroupMembers,
  myrmidonScopeGroups,
  myrmidonScopeSettings,
  projectMemberships,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  ISOLATED_LAYOUT,
  isScopeInstanceDirName,
  ISOLATION_MODES,
  SETTABLE_SCOPE_KINDS,
  type IsolationMode,
  type ScopeLayout,
  type SettableScopeKind,
} from "@paperclipai/shared";
import { botScopeRoutes } from "./scope-routes.js";
import { botScopeService, type BotScopeService, type ScopeStore } from "./scope-service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function catalogIdOf(metadata: unknown): string | null {
  const paperclip = (metadata as { paperclip?: { catalogTeam?: { catalogId?: unknown } } } | null)?.paperclip;
  const id = paperclip?.catalogTeam?.catalogId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function layoutOf(kind: string, dir: string | null): ScopeLayout {
  return kind === "shared" && dir && isScopeInstanceDirName(dir) ? { kind: "shared", dirName: dir } : ISOLATED_LAYOUT;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export function botScopeStore(db: Db): ScopeStore {
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
      // An agent's projects: the ones it leads and the ones that list it as a joined member.
      const ids = rows.map((row) => row.id);
      const projectIds = new Map<string, Set<string>>();
      const add = (agentId: string, projectId: string) => projectIds.set(agentId, (projectIds.get(agentId) ?? new Set()).add(projectId));
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
      const byGroup = await members(groups.map((g) => g.id));
      return groups.map((g) => ({ id: g.id, name: g.name, memberIds: byGroup.get(g.id) ?? [] }));
    },

    async listSettings(companyId) {
      const rows = await db
        .select({ kind: myrmidonScopeSettings.scopeKind, id: myrmidonScopeSettings.scopeId, mode: myrmidonScopeSettings.mode })
        .from(myrmidonScopeSettings)
        .where(eq(myrmidonScopeSettings.companyId, companyId));
      return rows
        .filter(
          (row) =>
            (SETTABLE_SCOPE_KINDS as readonly string[]).includes(row.kind) && (ISOLATION_MODES as readonly string[]).includes(row.mode),
        )
        .map((row) => ({ kind: row.kind as SettableScopeKind, id: row.id, mode: row.mode as IsolationMode }));
    },

    async listPrefs(companyId) {
      const rows = await db.select().from(myrmidonScopeAgentPrefs).where(eq(myrmidonScopeAgentPrefs.companyId, companyId));
      return rows.map((row) => ({
        agentId: row.agentId,
        isolate: row.isolate,
        groupId: row.groupId,
        projectId: row.projectId,
        appliedLayout: layoutOf(row.appliedKind, row.appliedDir),
      }));
    },

    async agentsInCompany(companyId, agentIds) {
      if (agentIds.length === 0) return [];
      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
      return rows.map((row) => row.id);
    },

    async projectExists(companyId, projectId) {
      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
        .limit(1);
      return rows.length > 0;
    },

    async createGroup(companyId, name, memberIds) {
      try {
        return await db.transaction(async (tx) => {
          const [group] = await tx.insert(myrmidonScopeGroups).values({ companyId, name }).returning();
          if (memberIds.length > 0) {
            await tx.insert(myrmidonScopeGroupMembers).values(memberIds.map((agentId) => ({ groupId: group!.id, agentId })));
          }
          return { id: group!.id, name: group!.name, memberIds };
        });
      } catch (err) {
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },

    async patchGroup(companyId, groupId, patch) {
      try {
        return await db.transaction(async (tx) => {
          const found = await tx
            .select({ id: myrmidonScopeGroups.id })
            .from(myrmidonScopeGroups)
            .where(and(eq(myrmidonScopeGroups.companyId, companyId), eq(myrmidonScopeGroups.id, groupId)))
            .limit(1);
          if (found.length === 0) return null;
          if (patch.name !== undefined) {
            await tx
              .update(myrmidonScopeGroups)
              .set({ name: patch.name, updatedAt: new Date() })
              .where(eq(myrmidonScopeGroups.id, groupId));
          }
          if (patch.memberIds !== undefined) {
            await tx.delete(myrmidonScopeGroupMembers).where(eq(myrmidonScopeGroupMembers.groupId, groupId));
            if (patch.memberIds.length > 0) {
              await tx.insert(myrmidonScopeGroupMembers).values(patch.memberIds.map((agentId) => ({ groupId, agentId })));
            }
          }
          const [row] = await tx.select().from(myrmidonScopeGroups).where(eq(myrmidonScopeGroups.id, groupId));
          const memberRows = await tx
            .select({ agentId: myrmidonScopeGroupMembers.agentId })
            .from(myrmidonScopeGroupMembers)
            .where(eq(myrmidonScopeGroupMembers.groupId, groupId));
          return { id: row!.id, name: row!.name, memberIds: memberRows.map((m) => m.agentId) };
        });
      } catch (err) {
        if (isUniqueViolation(err)) return "name-taken";
        throw err;
      }
    },

    async deleteGroup(companyId, groupId) {
      return db.transaction(async (tx) => {
        const removed = await tx
          .delete(myrmidonScopeGroups)
          .where(and(eq(myrmidonScopeGroups.companyId, companyId), eq(myrmidonScopeGroups.id, groupId)))
          .returning({ id: myrmidonScopeGroups.id });
        if (removed.length === 0) return false;
        await tx
          .delete(myrmidonScopeSettings)
          .where(
            and(
              eq(myrmidonScopeSettings.companyId, companyId),
              eq(myrmidonScopeSettings.scopeKind, "group"),
              eq(myrmidonScopeSettings.scopeId, groupId),
            ),
          );
        // A choice that named the group no longer matches anything; clear it.
        await tx
          .update(myrmidonScopeAgentPrefs)
          .set({ groupId: null, updatedAt: new Date() })
          .where(and(eq(myrmidonScopeAgentPrefs.companyId, companyId), eq(myrmidonScopeAgentPrefs.groupId, groupId)));
        return true;
      });
    },

    async putSetting(companyId, kind, id, mode) {
      await db
        .insert(myrmidonScopeSettings)
        .values({ companyId, scopeKind: kind, scopeId: id, mode })
        .onConflictDoUpdate({
          target: [myrmidonScopeSettings.companyId, myrmidonScopeSettings.scopeKind, myrmidonScopeSettings.scopeId],
          set: { mode, updatedAt: new Date() },
        });
    },

    async deleteSetting(companyId, kind, id) {
      const removed = await db
        .delete(myrmidonScopeSettings)
        .where(
          and(
            eq(myrmidonScopeSettings.companyId, companyId),
            eq(myrmidonScopeSettings.scopeKind, kind),
            eq(myrmidonScopeSettings.scopeId, id),
          ),
        )
        .returning({ id: myrmidonScopeSettings.id });
      return removed.length > 0;
    },

    async putPref(companyId, agentId, pref) {
      await db
        .insert(myrmidonScopeAgentPrefs)
        .values({ agentId, companyId, ...pref })
        .onConflictDoUpdate({
          target: myrmidonScopeAgentPrefs.agentId,
          set: { ...pref, updatedAt: new Date() },
        });
    },

    async setApplied(companyId, agentId, layout) {
      const applied = { appliedKind: layout.kind, appliedDir: layout.kind === "shared" ? layout.dirName : null, appliedAt: new Date() };
      await db
        .insert(myrmidonScopeAgentPrefs)
        .values({ agentId, companyId, ...applied })
        .onConflictDoUpdate({ target: myrmidonScopeAgentPrefs.agentId, set: { ...applied, updatedAt: new Date() } });
    },
  };
}

export function botScopeServiceFor(db: Db, env: NodeJS.ProcessEnv = process.env): BotScopeService {
  const volumeRoot = env.MYRMIDON_BOT_VOLUME_ROOT?.trim();
  const scopeRoot = env.MYRMIDON_BOT_SCOPE_ROOT?.trim() || (volumeRoot ? `${volumeRoot}/.scopes` : null);
  return botScopeService(botScopeStore(db), { scopeRoot });
}

/** Router for app.ts, mounted under /api. */
export function myrmidonBotScopeRoutes(db: Db) {
  return botScopeRoutes(botScopeServiceFor(db));
}

/**
 * The layout the board keeps a bot's container on, or isolated: read by the bot
 * driver on every create, recreate and drift check, and by the profile compiler
 * (which has to write the matching pnpm store path). A bot key is its agent id.
 */
export async function readAppliedScopeLayout(db: Db, botKey: string): Promise<ScopeLayout> {
  if (!UUID_PATTERN.test(botKey)) return ISOLATED_LAYOUT; // a bot key that is not an agent id has no row
  const rows = await db
    .select({ kind: myrmidonScopeAgentPrefs.appliedKind, dir: myrmidonScopeAgentPrefs.appliedDir })
    .from(myrmidonScopeAgentPrefs)
    .where(eq(myrmidonScopeAgentPrefs.agentId, botKey))
    .limit(1);
  return rows[0] ? layoutOf(rows[0].kind, rows[0].dir) : ISOLATED_LAYOUT;
}

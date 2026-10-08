// myrmidon(1.6.5 BASE-SKILLS): the company base-skills registry.
//
// A base skill is a skill the company declares mandatory for every agent. The
// registry exists because per-agent assignment leaks: on 06.10 the
// `parallel-helpers` skill was attached to 52 of 82 agents by hand, the other
// 30 silently missed it, and a bot could not start the work it needed. The
// registry inverts the default — a skill joins the company base list once and
// every agent has it:
//
//   * a new agent gets the base skills inside `agentService.create`, before its
//     first run (the merge helper is in `./company-base-skill-keys.js`);
//   * adding a skill to the base list applies it to every existing agent at
//     once (`add`);
//   * the base-skills screen shows the agents that still lack a base skill
//     (`overview().gaps`) and applies the list again on demand
//     (`applyToCompanyAgents`).
//
// The registry writes into each agent's own `paperclipSkillSync` selection, so
// nothing downstream changes: delivery, the skill library counters and the
// agent screen keep reading one assignment. Removing a skill from the base list
// stops the automatic assignment; it does not take the skill away from the
// agents that already carry it.

import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyBaseSkills, companySkills } from "@paperclipai/db";
import type {
  CompanyBaseSkillAgent,
  CompanyBaseSkillApplyResult,
  CompanyBaseSkillEntry,
  CompanyBaseSkillGap,
  CompanyBaseSkillOverview,
} from "@paperclipai/shared";
import {
  mergeCompanyBaseSkillsIntoAgentConfig,
  readCompanyBaseSkillKeys,
} from "./company-base-skill-keys.js";
import { agentService } from "./agents.js";
import { logActivity } from "./activity-log.js";
import { findActiveServerAdapter } from "../adapters/registry.js";
import { badRequest, unprocessable } from "../errors.js";

/** Agent statuses the base list never touches: their config is closed. */
const BASE_SKILL_EXCLUDED_AGENT_STATUSES = ["terminated", "pending_approval"];

/** Who changed the registry; a subset of the route actor info. */
export interface CompanyBaseSkillActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
}

export type CompanyBaseSkillAddOutcome = {
  entries: CompanyBaseSkillEntry[];
  apply: CompanyBaseSkillApplyResult;
};

function normalizeBaseSkillKeys(keys: readonly string[]): string[] {
  const out = new Map<string, string>();
  for (const raw of keys) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key || out.has(key)) continue;
    out.set(key, key);
  }
  return Array.from(out.values());
}

function skillsSupportedByAdapter(adapterType: string): boolean {
  const adapter = findActiveServerAdapter(adapterType);
  return Boolean(adapter?.listSkills || adapter?.syncSkills);
}

export function companyBaseSkillService(db: Db) {
  const agentSvc = agentService(db);

  async function librarySelector(companyId: string) {
    return db
      .select({
        id: companySkills.id,
        key: companySkills.key,
        slug: companySkills.slug,
        name: companySkills.name,
        iconUrl: companySkills.iconUrl,
        color: companySkills.color,
      })
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId));
  }

  async function candidateAgentRows(companyId: string) {
    return db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          notInArray(agents.status, BASE_SKILL_EXCLUDED_AGENT_STATUSES),
        ),
      )
      .orderBy(asc(agents.name));
  }

  /**
   * The skill keys an agent's own selection stands for. Stored values are
   * canonical keys for anything written by the board, but a reference may also
   * be a slug or an id, so the library is used to resolve them, exactly as the
   * skill counters do.
   */
  function resolveSelectionKeys(
    config: Record<string, unknown>,
    library: Array<{ id: string; key: string; slug: string }>,
  ): Set<string> {
    const raw = config.paperclipSkillSync;
    const stored = typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).desiredSkills
      : null;
    const values = Array.isArray(stored) ? stored : [];
    const byReference = new Map<string, string>();
    for (const skill of library) {
      for (const reference of [skill.key, skill.slug, skill.id]) {
        const token = reference.trim().toLowerCase();
        if (token && !byReference.has(token)) byReference.set(token, skill.key);
      }
    }
    const out = new Set<string>();
    for (const value of values) {
      const reference = typeof value === "string"
        ? value
        : typeof value === "object" && value !== null && !Array.isArray(value)
          && typeof (value as { key?: unknown }).key === "string"
          ? (value as { key: string }).key
          : "";
      const token = reference.trim();
      if (!token) continue;
      out.add(byReference.get(token.toLowerCase()) ?? token);
    }
    return out;
  }

  async function listEntries(companyId: string): Promise<CompanyBaseSkillEntry[]> {
    const [baseRows, library, agentRows] = await Promise.all([
      db
        .select({
          key: companyBaseSkills.key,
          skillId: companyBaseSkills.skillId,
          createdAt: companyBaseSkills.createdAt,
        })
        .from(companyBaseSkills)
        .where(eq(companyBaseSkills.companyId, companyId))
        .orderBy(asc(companyBaseSkills.createdAt), asc(companyBaseSkills.key)),
      librarySelector(companyId),
      candidateAgentRows(companyId),
    ]);
    const libraryByKey = new Map(library.map((skill) => [skill.key, skill]));
    const selections = agentRows.map((agent) => resolveSelectionKeys(
      (agent.adapterConfig ?? {}) as Record<string, unknown>,
      library,
    ));
    return baseRows.map((row) => {
      const skill = libraryByKey.get(row.key) ?? null;
      const assignedAgentCount = selections.filter((selection) => selection.has(row.key)).length;
      return {
        key: row.key,
        skillId: skill?.id ?? null,
        name: skill?.name ?? null,
        slug: skill?.slug ?? null,
        iconUrl: skill?.iconUrl ?? null,
        color: skill?.color ?? null,
        missing: skill === null,
        assignedAgentCount,
        agentCount: agentRows.length,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  async function listAgentRows(companyId: string): Promise<CompanyBaseSkillAgent[]> {
    const rows = await candidateAgentRows(companyId);
    return rows.map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      adapterType: agent.adapterType,
      skillsSupported: skillsSupportedByAdapter(agent.adapterType),
    }));
  }

  /**
   * The company base list with the per-agent gaps: for every base skill the
   * library still has, the agents whose own selection does not carry it. A
   * terminated or pending-approval agent is not a candidate at all, and an
   * agent whose adapter cannot receive skills is reported as
   * `adapter_unsupported` rather than as a fixable gap.
   */
  async function overview(companyId: string): Promise<CompanyBaseSkillOverview> {
    const [entries, library, agentRows] = await Promise.all([
      listEntries(companyId),
      librarySelector(companyId),
      candidateAgentRows(companyId),
    ]);
    const gaps: CompanyBaseSkillGap[] = [];
    for (const entry of entries) {
      if (entry.missing) continue;
      for (const agent of agentRows) {
        const selection = resolveSelectionKeys(
          (agent.adapterConfig ?? {}) as Record<string, unknown>,
          library,
        );
        if (selection.has(entry.key)) continue;
        gaps.push({
          key: entry.key,
          agentId: agent.id,
          agentName: agent.name,
          agentStatus: agent.status,
          reason: skillsSupportedByAdapter(agent.adapterType) ? "not_assigned" : "adapter_unsupported",
        });
      }
    }
    return { entries, gaps, agents: await listAgentRows(companyId) };
  }

  async function logRegistryChange(
    companyId: string,
    action: string,
    entityId: string,
    details: Record<string, unknown>,
    actor: CompanyBaseSkillActor,
  ) {
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action,
      entityType: "company_base_skill",
      entityId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      agentApiKeyId: actor.agentApiKeyId ?? null,
      details,
    });
  }

  /**
   * Write the base skills into every candidate agent's own selection. An agent
   * that already carries them is left untouched, so a re-run costs nothing and
   * writes no config revision.
   */
  async function applyToCompanyAgents(
    companyId: string,
    actor: CompanyBaseSkillActor,
  ): Promise<CompanyBaseSkillApplyResult> {
    const keys = await readCompanyBaseSkillKeys(db, companyId);
    const agentRows = await candidateAgentRows(companyId);
    const result: CompanyBaseSkillApplyResult = {
      keys,
      agents: agentRows.length,
      changed: 0,
      unchanged: 0,
      failed: [],
    };
    if (keys.length === 0) return result;

    for (const agent of agentRows) {
      const adapterConfig = (agent.adapterConfig ?? {}) as Record<string, unknown>;
      const merged = mergeCompanyBaseSkillsIntoAgentConfig(adapterConfig, keys);
      if (merged === adapterConfig) {
        result.unchanged += 1;
        continue;
      }
      try {
        const updated = await agentSvc.update(
          agent.id,
          { adapterConfig: merged },
          {
            recordRevision: {
              createdByAgentId: actor.agentId ?? null,
              createdByUserId: actor.actorType === "user" ? actor.actorId : null,
              source: "base-skills",
            },
          },
        );
        if (!updated) throw new Error("agent no longer exists");
        result.changed += 1;
      } catch (error) {
        result.failed.push({
          agentId: agent.id,
          agentName: agent.name,
          reason: error instanceof Error ? error.message : "unknown error",
        });
      }
    }

    await logRegistryChange(
      companyId,
      "company.base_skills_applied",
      companyId,
      {
        keys,
        agents: result.agents,
        changed: result.changed,
        unchanged: result.unchanged,
        failed: result.failed.length,
      },
      actor,
    );
    return result;
  }

  /** Add library skills to the company base list and apply them to all agents. */
  async function add(
    companyId: string,
    keys: readonly string[],
    actor: CompanyBaseSkillActor,
  ): Promise<CompanyBaseSkillAddOutcome> {
    const requested = normalizeBaseSkillKeys(keys);
    if (requested.length === 0) {
      throw badRequest("At least one skill key is required.");
    }
    const library = await librarySelector(companyId);
    const libraryByKey = new Map(library.map((skill) => [skill.key, skill]));
    const unknown = requested.filter((key) => !libraryByKey.has(key));
    if (unknown.length > 0) {
      throw unprocessable(
        `Unknown company skill(s): ${unknown.join(", ")}. Install the skill in the library first.`,
      );
    }

    const existing = await db
      .select({ key: companyBaseSkills.key })
      .from(companyBaseSkills)
      .where(and(eq(companyBaseSkills.companyId, companyId), inArray(companyBaseSkills.key, requested)))
      .then((rows) => new Set(rows.map((row) => row.key)));
    const added = requested.filter((key) => !existing.has(key));
    if (added.length > 0) {
      await db
        .insert(companyBaseSkills)
        .values(
          added.map((key) => ({
            companyId,
            skillId: libraryByKey.get(key)!.id,
            key,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          })),
        )
        .onConflictDoNothing();
      await logRegistryChange(
        companyId,
        "company.base_skills_added",
        added.join(","),
        { keys: added },
        actor,
      );
    }

    const apply = await applyToCompanyAgents(companyId, actor);
    return { entries: await listEntries(companyId), apply };
  }

  /** Remove one skill from the company base list. Owned assignments stay. */
  async function remove(companyId: string, key: string, actor: CompanyBaseSkillActor) {
    const trimmed = key.trim();
    if (!trimmed) throw badRequest("A skill key is required.");
    const deleted = await db
      .delete(companyBaseSkills)
      .where(and(eq(companyBaseSkills.companyId, companyId), eq(companyBaseSkills.key, trimmed)))
      .returning({ key: companyBaseSkills.key });
    if (deleted.length === 0) return null;
    await logRegistryChange(companyId, "company.base_skills_removed", trimmed, { key: trimmed }, actor);
    return { key: trimmed, entries: await listEntries(companyId) };
  }

  return {
    listEntries,
    listAgentRows,
    overview,
    add,
    remove,
    applyToCompanyAgents,
  };
}
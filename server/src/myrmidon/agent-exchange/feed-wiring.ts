// server/src/myrmidon/agent-exchange/feed-wiring.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-B): the database side of the feed and of the
// «to skill» action.
//
// The stores below read only what they need:
//
//   - the rooms of one company (`agent_exchange_rooms`, part A's table) —
//     nothing is written back to the room, so the feed can never disturb a
//     live room;
//   - the task labels from `issues`;
//   - the candidate of a room: the key is derived from the room id, so the
//     lookup is one indexed read over `company_skills`, plus the real state
//     from `company_skill_lifecycle` — the feed shows what the lifecycle says,
//     not what the button once created (a promoted candidate reads as
//     `verified`, not as a candidate);
//   - the outcome text from the issue document part A wrote.
//
// The «to skill» port creates the skill in the company library and registers
// it as a candidate. It has no promote method: promotion belongs to the
// approvals pipeline (SKILL-LIFECYCLE), and nothing in this path can reach it.

import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  agentExchangeRooms,
  companySkillLifecycle,
  companySkills,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  agentExchangeCompanySkillKey,
  agentExchangeRoomSkillKey,
  DEFAULT_AGENT_EXCHANGE_FEED_SETTINGS,
  type AgentExchangeParticipantSpec,
  type AgentExchangeFeedSettingsPatch,
} from "@paperclipai/shared";
import { companySkillService, documentService } from "../../services/index.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { skillLifecycleService } from "../skill-lifecycle/index.js";
import { agentExchangeFeedRoutes } from "./feed-routes.js";
import type { AgentExchangeFeedIssueRef, AgentExchangeFeedRoomRow, AgentExchangeFeedStore } from "./feed.js";
import { mergeAgentExchangeFeedSettingsPatch } from "./feed-settings.js";
import type {
  AgentExchangeSkillCandidatePort,
  AgentExchangeSkillCandidateStore,
} from "./skill-candidate.js";

/** Two-phase row → feed row mapping, shared by the list and the single read. */
function toFeedRoomRow(row: typeof agentExchangeRooms.$inferSelect): AgentExchangeFeedRoomRow {
  const participants = Array.isArray(row.participants)
    ? (row.participants as AgentExchangeParticipantSpec[])
    : [];
  return {
    id: row.id,
    issueId: row.issueId,
    status: row.status,
    participants: participants.map((participant) => ({
      label: participant.label,
      model: participant.model,
    })),
    currentRound: row.currentRound,
    maxRounds: row.maxRounds,
    tokensUsed: row.tokensUsed,
    costCents: row.costCents,
    stopReason: row.stopReason,
    summaryDocumentKey: row.summaryDocumentKey,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
  };
}

async function issueRefsById(db: Db, issueIds: string[]): Promise<Map<string, AgentExchangeFeedIssueRef>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db
    .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  return new Map(
    rows.map((row) => [row.id, { identifier: row.identifier ?? null, title: row.title ?? null }]),
  );
}

export function agentExchangeFeedStore(db: Db): AgentExchangeFeedStore {
  return {
    async listRooms(companyId, limit) {
      const rows = await db
        .select()
        .from(agentExchangeRooms)
        .where(eq(agentExchangeRooms.companyId, companyId))
        .orderBy(desc(agentExchangeRooms.createdAt))
        .limit(limit);
      const total = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agentExchangeRooms)
        .where(eq(agentExchangeRooms.companyId, companyId))
        .then((counted) => counted[0]?.count ?? 0);
      return { rows: rows.map(toFeedRoomRow), total };
    },

    getIssueRefs: (issueIds) => issueRefsById(db, issueIds),

    async findSkillCandidates(companyId, roomIds) {
      const found = new Map<string, { skillId: string; key: string; name: string; state: string }>();
      if (roomIds.length === 0) return found;

      const keyByRoom = new Map(roomIds.map((roomId) => [roomId, agentExchangeRoomSkillKey(companyId, roomId)]));
      const skills = await db
        .select({ id: companySkills.id, key: companySkills.key, name: companySkills.name })
        .from(companySkills)
        .where(
          and(eq(companySkills.companyId, companyId), inArray(companySkills.key, [...keyByRoom.values()])),
        );
      if (skills.length === 0) return found;

      // The state comes from the lifecycle table, so a promoted skill is not
      // still reported as a candidate.
      const lifecycleRows = await db
        .select({ skillId: companySkillLifecycle.skillId, state: companySkillLifecycle.state })
        .from(companySkillLifecycle)
        .where(
          and(
            eq(companySkillLifecycle.companyId, companyId),
            inArray(
              companySkillLifecycle.skillId,
              skills.map((skill) => skill.id),
            ),
          ),
        );
      const stateBySkill = new Map(lifecycleRows.map((row) => [row.skillId, row.state]));
      const skillByKey = new Map(skills.map((skill) => [skill.key, skill]));

      for (const [roomId, key] of keyByRoom) {
        const skill = skillByKey.get(key);
        if (!skill) continue;
        found.set(roomId, {
          skillId: skill.id,
          key: skill.key,
          name: skill.name,
          state: stateBySkill.get(skill.id) ?? "candidate",
        });
      }
      return found;
    },
  };
}

export function agentExchangeSkillCandidateStore(db: Db): AgentExchangeSkillCandidateStore {
  const documents = documentService(db);
  return {
    async getRoom(companyId, roomId) {
      const row = await db
        .select()
        .from(agentExchangeRooms)
        .where(and(eq(agentExchangeRooms.companyId, companyId), eq(agentExchangeRooms.id, roomId)))
        .then((rows) => rows[0] ?? null);
      return row ? toFeedRoomRow(row) : null;
    },
    async getIssueRef(issueId) {
      const rows = await issueRefsById(db, [issueId]);
      return rows.get(issueId) ?? null;
    },
    async getSummaryDocument(issueId, key) {
      const document = await documents.getIssueDocumentByKey(issueId, key);
      if (!document) return null;
      return { title: document.title ?? null, body: document.body ?? "" };
    },
  };
}

/**
 * The company-skill side: create the skill from the room outcome, then
 * register it as a candidate. Idempotent by key — a second press finds the
 * skill, re-asserts the candidate state (harmless when it already is one) and
 * answers `created: false`.
 */
export function agentExchangeSkillCandidatePort(db: Db): AgentExchangeSkillCandidatePort {
  const skills = companySkillService(db);
  const lifecycle = skillLifecycleService(db);

  const lifecycleActor = (actor: { actorType: "user" | "agent"; actorId: string }) =>
    actor.actorType === "agent"
      ? { actorType: "agent" as const, actorId: actor.actorId }
      : { actorType: "user" as const, actorId: actor.actorId };
  const skillActor = (actor: { actorType: "user" | "agent"; actorId: string }) =>
    actor.actorType === "agent"
      ? { type: "agent" as const, agentId: actor.actorId }
      : { type: "user" as const, userId: actor.actorId };

  const registered = async (
    companyId: string,
    skill: { id: string; key: string; name: string },
    created: boolean,
    actor: { actorType: "user" | "agent"; actorId: string },
  ) => {
    await lifecycle.setCandidate(companyId, skill.id, lifecycleActor(actor));
    return { skillId: skill.id, key: skill.key, name: skill.name, state: "candidate", created };
  };

  return {
    available: () => true,
    async createOrGet(input) {
      const key = agentExchangeCompanySkillKey(input.companyId, input.slug);
      const existing = await skills.getByKey(input.companyId, key);
      if (existing) return registered(input.companyId, existing, false, input.actor);

      let created: { id: string; key: string; name: string };
      try {
        created = await skills.createLocalSkill(
          input.companyId,
          {
            name: input.name,
            slug: input.slug,
            description: input.description,
            markdown: input.markdown,
            sharingScope: "company",
          },
          skillActor(input.actor),
        );
      } catch (error) {
        // A second press in flight created the skill first: answer with it,
        // so the button stays idempotent under a double click.
        const raced = await skills.getByKey(input.companyId, key);
        if (!raced) throw error;
        return registered(input.companyId, raced, false, input.actor);
      }
      return registered(input.companyId, created, true, input.actor);
    },
  };
}

export function myrmidonAgentExchangeFeedRoutes(db: Db): Router {
  return agentExchangeFeedRoutes({
    db,
    store: agentExchangeFeedStore(db),
    skillCandidateStore: agentExchangeSkillCandidateStore(db),
    skillCandidatePort: agentExchangeSkillCandidatePort(db),
    updateSettings: async (patch: AgentExchangeFeedSettingsPatch) => {
      const svc = instanceSettingsService(db);
      // The stored blob is the full settings object (or absent) and the PATCH
      // is partial: merge over what the screen showed, then write it back.
      const stored = (await svc.getGeneral()).agentExchangeFeed;
      const base = stored ?? { ...DEFAULT_AGENT_EXCHANGE_FEED_SETTINGS };
      await svc.updateGeneral({
        agentExchangeFeed: mergeAgentExchangeFeedSettingsPatch(
          base as typeof DEFAULT_AGENT_EXCHANGE_FEED_SETTINGS,
          patch,
        ),
      });
    },
  });
}
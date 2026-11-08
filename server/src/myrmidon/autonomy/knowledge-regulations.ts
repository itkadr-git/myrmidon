// server/src/myrmidon/autonomy/knowledge-regulations.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-3): compatibility projection and CRUD
// backend for autonomy regulations. Rules are held only by knowledge_items
// and knowledge_revisions (kind="rule"), never by second tables or JSON docs.

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  knowledgeItems,
  knowledgeRevisions,
  type Db,
} from "@myrmidon/db";
import {
  type AutonomyActorRef,
  type AutonomyRegulation,
  type AutonomyRegulationRevision,
} from "@myrmidon/shared";
import { approverKindSatisfies } from "../knowledge/domain.js";
import { resolveCasteSensitivity } from "../caste-sensitivity.js";
import { ruleApproverKind } from "../knowledge/rules.js";
import {
  AUTONOMY_ACTIVITY_SOURCE,
  type AutonomyFailure,
  type AutonomyResult,
} from "./service.js";

export type AutonomyLogActivityFn = (input: {
  companyId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
}) => Promise<void>;

function ok<T>(value: T): AutonomyResult<T> {
  return { ok: true, value };
}

function fail<T>(failure: AutonomyFailure): AutonomyResult<T> {
  return { ok: false, failure };
}

function slugify(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "rule";
}

function actorOf(agentId: string | null | undefined, userId: string | null | undefined): AutonomyActorRef {
  if (agentId) return { type: "agent", id: agentId };
  if (userId) return { type: "board", id: userId };
  return { type: "system", id: "system" };
}

function mapToAutonomyRegulation(
  item: typeof knowledgeItems.$inferSelect,
  revisions: (typeof knowledgeRevisions.$inferSelect)[],
): AutonomyRegulation {
  const mappedRevs: AutonomyRegulationRevision[] = revisions.map((rev) => ({
    revision: rev.revisionNumber,
    title: item.title,
    bodyMarkdown: rev.content,
    status: rev.status === "approved" ? "approved" : "draft",
    author: actorOf(rev.createdByAgentId, rev.createdByUserId),
    at: rev.createdAt instanceof Date ? rev.createdAt.toISOString() : String(rev.createdAt),
  }));
  const current =
    mappedRevs.find((r) => r.revision === item.currentRevisionNumber) ?? mappedRevs.at(-1);
  return {
    id: item.id,
    role: (item.roles as string[])?.[0] ?? "*",
    title: item.title,
    bodyMarkdown: current?.bodyMarkdown ?? "",
    status: current?.status === "approved" ? "approved" : "draft",
    revision: item.currentRevisionNumber || (current?.revision ?? 1),
    revisions: mappedRevs,
    createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : String(item.createdAt),
    createdBy: actorOf(item.createdByAgentId, item.createdByUserId),
    updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : String(item.updatedAt),
    updatedBy: current?.author ?? actorOf(item.createdByAgentId, item.createdByUserId),
    supersededBy: item.supersededByItemId,
    wikiPageId: item.slug,
  };
}

/** Return rule items in the established autonomy-regulation response shape. */
export async function listKnowledgeAutonomyRegulations(db: Db, companyId: string): Promise<AutonomyRegulation[]> {
  const items = await db
    .select()
    .from(knowledgeItems)
    .where(and(eq(knowledgeItems.nestId, companyId), eq(knowledgeItems.kind, "rule")));
  if (items.length === 0) return [];
  const itemIds = items.map((i) => i.id);
  const revs = await db
    .select()
    .from(knowledgeRevisions)
    .where(inArray(knowledgeRevisions.itemId, itemIds))
    .orderBy(knowledgeRevisions.revisionNumber);
  const revMap = new Map<string, (typeof knowledgeRevisions.$inferSelect)[]>();
  for (const rev of revs) {
    const list = revMap.get(rev.itemId) ?? [];
    list.push(rev);
    revMap.set(rev.itemId, list);
  }
  return items.map((item) => mapToAutonomyRegulation(item, revMap.get(item.id) ?? []));
}

export async function createKnowledgeAutonomyRegulation(
  db: Db,
  companyId: string,
  actor: AutonomyActorRef,
  input: { role: string; title: string; bodyMarkdown: string },
  logActivity?: AutonomyLogActivityFn,
): Promise<AutonomyResult<AutonomyRegulation>> {
  const sensitivity = await resolveCasteSensitivity(db, companyId);
  const approverKind = ruleApproverKind([input.role], sensitivity);

  const baseSlug = `rules/${slugify(input.role)}/${slugify(input.title)}`;
  let slug = baseSlug;
  let counter = 1;
  while (true) {
    const existing = await db
      .select({ id: knowledgeItems.id })
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.nestId, companyId), eq(knowledgeItems.slug, slug)))
      .limit(1);
    if (existing.length === 0) break;
    counter++;
    slug = `${baseSlug}-${counter}`;
  }

  const itemId = randomUUID();
  const revId = randomUUID();
  const at = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(knowledgeItems).values({
      id: itemId,
      companyId,
      nestId: companyId,
      kind: "rule",
      slug,
      title: input.title,
      summary: null,
      status: "draft",
      folderPath: slug.includes("/") ? slug.replace(/\/[^/]*$/, "") : "",
      tags: [],
      roles: [input.role],
      approvalRequired: true,
      approverKind,
      deliveredRevisionId: null,
      currentRevisionNumber: 1,
      createdByAgentId: actor.type === "agent" ? actor.id : null,
      createdByUserId: actor.type === "board" ? actor.id : null,
      createdAt: at,
      updatedAt: at,
    });

    await tx.insert(knowledgeRevisions).values({
      id: revId,
      companyId,
      nestId: companyId,
      itemId,
      revisionNumber: 1,
      status: "draft",
      content: input.bodyMarkdown,
      changeSummary: "created",
      createdByAgentId: actor.type === "agent" ? actor.id : null,
      createdByUserId: actor.type === "board" ? actor.id : null,
      createdAt: at,
    });
  });

  const regulation: AutonomyRegulation = {
    id: itemId,
    role: input.role,
    title: input.title,
    bodyMarkdown: input.bodyMarkdown,
    status: "draft",
    revision: 1,
    revisions: [
      {
        revision: 1,
        title: input.title,
        bodyMarkdown: input.bodyMarkdown,
        status: "draft",
        author: actor,
        at: at.toISOString(),
      },
    ],
    createdAt: at.toISOString(),
    createdBy: actor,
    updatedAt: at.toISOString(),
    updatedBy: actor,
    supersededBy: null,
    wikiPageId: slug,
  };

  await logActivity?.({
    companyId,
    actorType: actor.type === "agent" ? "agent" : actor.type === "system" ? "system" : "user",
    actorId: actor.id,
    action: `${AUTONOMY_ACTIVITY_SOURCE}.regulation_created`,
    entityType: "autonomy_regulation",
    entityId: itemId,
    details: {
      summary: `Regulation created for role ${input.role} (draft, revision 1).`,
      action: "regulation_created",
      regulationId: itemId,
    },
  });

  return ok(regulation);
}

export async function updateKnowledgeAutonomyRegulation(
  db: Db,
  companyId: string,
  actor: AutonomyActorRef,
  input: { id: string; title?: string; bodyMarkdown?: string },
  logActivity?: AutonomyLogActivityFn,
): Promise<AutonomyResult<AutonomyRegulation>> {
  const at = new Date();
  const res = await db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.nestId, companyId), eq(knowledgeItems.id, input.id), eq(knowledgeItems.kind, "rule")))
      .for("update");
    if (!item) return null;

    const revs = await tx
      .select()
      .from(knowledgeRevisions)
      .where(eq(knowledgeRevisions.itemId, item.id))
      .orderBy(knowledgeRevisions.revisionNumber);

    const latest = revs.find((r) => r.revisionNumber === item.currentRevisionNumber) ?? revs.at(-1);
    const title = input.title ?? item.title;
    const content = input.bodyMarkdown ?? latest?.content ?? "";
    const nextRevision = (item.currentRevisionNumber || (latest?.revisionNumber ?? 0)) + 1;

    const [newRev] = await tx
      .insert(knowledgeRevisions)
      .values({
        id: randomUUID(),
        companyId,
        nestId: companyId,
        itemId: item.id,
        revisionNumber: nextRevision,
        status: "draft",
        content,
        changeSummary: "edited",
        createdByAgentId: actor.type === "agent" ? actor.id : null,
        createdByUserId: actor.type === "board" ? actor.id : null,
        createdAt: at,
      })
      .returning();

    const [updatedItem] = await tx
      .update(knowledgeItems)
      .set({
        title,
        currentRevisionNumber: nextRevision,
        updatedAt: at,
      })
      .where(eq(knowledgeItems.id, item.id))
      .returning();

    return mapToAutonomyRegulation(updatedItem!, [...revs, newRev!]);
  });

  if (!res) {
    return fail({ kind: "regulation_not_found", regulationId: input.id });
  }

  await logActivity?.({
    companyId,
    actorType: actor.type === "agent" ? "agent" : actor.type === "system" ? "system" : "user",
    actorId: actor.id,
    action: `${AUTONOMY_ACTIVITY_SOURCE}.regulation_edited`,
    entityType: "autonomy_regulation",
    entityId: input.id,
    details: {
      summary: `Regulation revised to revision ${res.revision} (draft).`,
      action: "regulation_edited",
      regulationId: input.id,
    },
  });

  return ok(res);
}

/**
 * The same gate the knowledge store applies on approve (S4), for the autonomy
 * facade: the grade is recomputed from the rule's roles and the live caste
 * directory (the stored `approver_kind` is not trusted), and the approver must
 * present at least that grade. A refusal is `approver_kind_mismatch` (403).
 */
function checkApproverGate(
  sensitivity: { sensitive: ReadonlySet<string> },
  item: { id: string; roles: string[] | null },
  presented: string | null,
): AutonomyFailure | null {
  const required = ruleApproverKind(item.roles ?? [], sensitivity);
  if (approverKindSatisfies(required, presented)) return null;
  return { kind: "approver_kind_mismatch", regulationId: item.id, required, presented };
}

export async function approveKnowledgeAutonomyRegulation(
  db: Db,
  companyId: string,
  actor: AutonomyActorRef,
  regulationId: string,
  approverKind: string | null,
  logActivity?: AutonomyLogActivityFn,
): Promise<AutonomyResult<AutonomyRegulation>> {
  const at = new Date();
  const sensitivity = await resolveCasteSensitivity(db, companyId);
  const txResult = await db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.nestId, companyId), eq(knowledgeItems.id, regulationId), eq(knowledgeItems.kind, "rule")))
      .for("update");
    if (!item) return { notFound: true } as const;
    const refusal = checkApproverGate(sensitivity, item, approverKind);
    if (refusal) return { refusal } as const;

    const revs = await tx
      .select()
      .from(knowledgeRevisions)
      .where(eq(knowledgeRevisions.itemId, item.id))
      .orderBy(knowledgeRevisions.revisionNumber);

    const currentRev = revs.find((r) => r.revisionNumber === item.currentRevisionNumber);
    if (!currentRev) return { notFound: true } as const;
    if (currentRev.status === "approved") return { alreadyApproved: true } as const;

    const [approvedRev] = await tx
      .update(knowledgeRevisions)
      .set({
        status: "approved",
        approvedAt: at,
        approvedBy: actor.id,
      })
      .where(eq(knowledgeRevisions.id, currentRev.id))
      .returning();

    const [updatedItem] = await tx
      .update(knowledgeItems)
      .set({
        deliveredRevisionId: approvedRev!.id,
        status: "published",
        updatedAt: at,
      })
      .where(eq(knowledgeItems.id, item.id))
      .returning();

    const allRevs = revs.map((r) => (r.id === approvedRev!.id ? approvedRev! : r));
    return { regulation: mapToAutonomyRegulation(updatedItem!, allRevs) } as const;
  });

  if ("notFound" in txResult) {
    return fail({ kind: "regulation_not_found", regulationId });
  }
  if ("refusal" in txResult && txResult.refusal) {
    return fail(txResult.refusal);
  }
  if ("alreadyApproved" in txResult) {
    return fail({ kind: "already_approved", regulationId });
  }

  const regulation = txResult.regulation;
  await logActivity?.({
    companyId,
    actorType: actor.type === "agent" ? "agent" : actor.type === "system" ? "system" : "user",
    actorId: actor.id,
    action: `${AUTONOMY_ACTIVITY_SOURCE}.regulation_approved`,
    entityType: "autonomy_regulation",
    entityId: regulationId,
    details: {
      summary: `Regulation approved for role ${regulation.role} at revision ${regulation.revision}.`,
      action: "regulation_approved",
      regulationId,
    },
  });

  return ok(regulation);
}

export async function restoreKnowledgeAutonomyRegulation(
  db: Db,
  companyId: string,
  actor: AutonomyActorRef,
  input: { id: string; toRevision: number },
  approverKind: string | null,
  logActivity?: AutonomyLogActivityFn,
): Promise<AutonomyResult<AutonomyRegulation>> {
  const at = new Date();
  const sensitivity = await resolveCasteSensitivity(db, companyId);
  const txResult = await db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.nestId, companyId), eq(knowledgeItems.id, input.id), eq(knowledgeItems.kind, "rule")))
      .for("update");
    if (!item) return { notFound: true } as const;
    // A rollback publishes an approved copy at once, so it passes the approval gate.
    const refusal = checkApproverGate(sensitivity, item, approverKind);
    if (refusal) return { refusal } as const;

    const revs = await tx
      .select()
      .from(knowledgeRevisions)
      .where(eq(knowledgeRevisions.itemId, item.id))
      .orderBy(knowledgeRevisions.revisionNumber);

    const source = revs.find((r) => r.revisionNumber === input.toRevision);
    if (!source) return { revisionNotFound: true } as const;

    const nextRevision = (item.currentRevisionNumber || revs.length) + 1;
    const [restoredRev] = await tx
      .insert(knowledgeRevisions)
      .values({
        id: randomUUID(),
        companyId,
        nestId: companyId,
        itemId: item.id,
        revisionNumber: nextRevision,
        status: "approved",
        content: source.content,
        changeSummary: `rolled back to revision ${source.revisionNumber}`,
        rolledBackFromRevisionId: source.id,
        approvedAt: at,
        approvedBy: actor.id,
        createdByAgentId: actor.type === "agent" ? actor.id : null,
        createdByUserId: actor.type === "board" ? actor.id : null,
        createdAt: at,
      })
      .returning();

    const [updatedItem] = await tx
      .update(knowledgeItems)
      .set({
        currentRevisionNumber: nextRevision,
        deliveredRevisionId: restoredRev!.id,
        status: "published",
        updatedAt: at,
      })
      .where(eq(knowledgeItems.id, item.id))
      .returning();

    return { regulation: mapToAutonomyRegulation(updatedItem!, [...revs, restoredRev!]) } as const;
  });

  if ("notFound" in txResult) {
    return fail({ kind: "regulation_not_found", regulationId: input.id });
  }
  if ("refusal" in txResult && txResult.refusal) {
    return fail(txResult.refusal);
  }
  if ("revisionNotFound" in txResult) {
    return fail({ kind: "revision_not_found", regulationId: input.id, revision: input.toRevision });
  }

  const regulation = txResult.regulation;
  await logActivity?.({
    companyId,
    actorType: actor.type === "agent" ? "agent" : actor.type === "system" ? "system" : "user",
    actorId: actor.id,
    action: `${AUTONOMY_ACTIVITY_SOURCE}.regulation_rolled_back`,
    entityType: "autonomy_regulation",
    entityId: input.id,
    details: {
      summary: `Regulation rolled back to revision ${input.toRevision} (now revision ${regulation.revision}).`,
      action: "regulation_rolled_back",
      regulationId: input.id,
    },
  });

  return ok(regulation);
}

export async function deleteKnowledgeAutonomyRegulation(
  db: Db,
  companyId: string,
  actor: AutonomyActorRef,
  regulationId: string,
  approverKind: string | null,
  logActivity?: AutonomyLogActivityFn,
): Promise<AutonomyResult<{ id: string }>> {
  const sensitivity = await resolveCasteSensitivity(db, companyId);
  const outcome = await db.transaction(async (tx) => {
    const [item] = await tx
      .select({
        id: knowledgeItems.id,
        roles: knowledgeItems.roles,
        status: knowledgeItems.status,
        deliveredRevisionId: knowledgeItems.deliveredRevisionId,
      })
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.nestId, companyId), eq(knowledgeItems.id, regulationId), eq(knowledgeItems.kind, "rule")))
      .for("update");
    if (!item) return { notFound: true } as const;
    // Deleting a delivered rule withdraws it from the fleet: it needs the same
    // grade as approving it. A draft that was never delivered is free to delete.
    if (item.deliveredRevisionId !== null || item.status === "published") {
      const refusal = checkApproverGate(sensitivity, item, approverKind);
      if (refusal) return { refusal } as const;
    }

    await tx.delete(knowledgeItems).where(eq(knowledgeItems.id, item.id));
    return { deleted: true } as const;
  });

  if ("refusal" in outcome && outcome.refusal) {
    return fail(outcome.refusal);
  }
  if ("notFound" in outcome) {
    return fail({ kind: "regulation_not_found", regulationId });
  }

  await logActivity?.({
    companyId,
    actorType: actor.type === "agent" ? "agent" : actor.type === "system" ? "system" : "user",
    actorId: actor.id,
    action: `${AUTONOMY_ACTIVITY_SOURCE}.regulation_deleted`,
    entityType: "autonomy_regulation",
    entityId: regulationId,
    details: { summary: "Regulation deleted.", action: "regulation_deleted", regulationId },
  });

  return ok({ id: regulationId });
}

export interface AutonomyRegulationsBackend {
  list(companyId: string): Promise<AutonomyRegulation[]>;
  create(companyId: string, actor: AutonomyActorRef, input: { role: string; title: string; bodyMarkdown: string }): Promise<AutonomyResult<AutonomyRegulation>>;
  update(companyId: string, actor: AutonomyActorRef, input: { id: string; title?: string; bodyMarkdown?: string }): Promise<AutonomyResult<AutonomyRegulation>>;
  approve(companyId: string, actor: AutonomyActorRef, regulationId: string, approverKind: string | null): Promise<AutonomyResult<AutonomyRegulation>>;
  restore(companyId: string, actor: AutonomyActorRef, input: { id: string; toRevision: number }, approverKind: string | null): Promise<AutonomyResult<AutonomyRegulation>>;
  delete(companyId: string, actor: AutonomyActorRef, regulationId: string, approverKind: string | null): Promise<AutonomyResult<{ id: string }>>;
}

export function createKnowledgeAutonomyRegulationsBackend(
  db: Db,
  logActivity?: AutonomyLogActivityFn,
): AutonomyRegulationsBackend {
  return {
    list: (companyId: string) => listKnowledgeAutonomyRegulations(db, companyId),
    create: (companyId: string, actor: AutonomyActorRef, input: { role: string; title: string; bodyMarkdown: string }) =>
      createKnowledgeAutonomyRegulation(db, companyId, actor, input, logActivity),
    update: (companyId: string, actor: AutonomyActorRef, input: { id: string; title?: string; bodyMarkdown?: string }) =>
      updateKnowledgeAutonomyRegulation(db, companyId, actor, input, logActivity),
    approve: (companyId: string, actor: AutonomyActorRef, regulationId: string, approverKind: string | null) =>
      approveKnowledgeAutonomyRegulation(db, companyId, actor, regulationId, approverKind, logActivity),
    restore: (companyId: string, actor: AutonomyActorRef, input: { id: string; toRevision: number }, approverKind: string | null) =>
      restoreKnowledgeAutonomyRegulation(db, companyId, actor, input, approverKind, logActivity),
    delete: (companyId: string, actor: AutonomyActorRef, regulationId: string, approverKind: string | null) =>
      deleteKnowledgeAutonomyRegulation(db, companyId, actor, regulationId, approverKind, logActivity),
  };
}

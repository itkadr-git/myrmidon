// server/src/myrmidon/knowledge/store.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-1): the storage side of the knowledge module.
//
// `createKnowledgeService(db, opts)` sits on the domain from ./domain.js:
// every mutation runs the state machine and the invariants first, then writes
// rows in one transaction, then appends the `knowledge.*` event and mirrors it
// into company activity (S9). Nothing here spells dialect SQL: the module
// keeps the "0 triggers, 0 `sql\`` with dialect operators" guarantee — full
// text search is the `SearchIndex` PORT (domain.ts), implemented for pg in
// `@paperclipai/db` (tsvector + pg_trgm + unaccent) and injected by wiring.
//
// The pointer discipline (the acceptance criteria):
//   - `draft()` writes a revision and NEVER touches `delivered_revision_id`;
//   - `approve()` refuses (403) an approval-required item without
//     `approver_kind`, and refuses an approver of the wrong kind;
//   - `rollback()` copies an approved revision into ONE MORE revision and
//     moves the delivery pointer onto the copy — history is append-only;
//   - `publish()` moves the pointer to the approved/head revision when the
//     item does not require approval, or requires an approved revision when
//     it does;
//   - `exportTree()/importTree()` are canonical: export → import → export is
//     byte-for-byte identical.

import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  knowledgeDeliveries,
  knowledgeEvents,
  knowledgeItems,
  knowledgeLinks,
  knowledgeRevisions,
  knowledgeSources,
  knowledgeSuggestions,
} from "@paperclipai/db";
import { logActivity } from "../../services/activity-log.js";
import {
  KnowledgeDomainError,
  assertApprovable,
  assertItemTransition,
  assertRevisionTransition,
  assertRuleFields,
  assertSingleLine,
  assertValidSlug,
  assertValidTags,
  draftPointerFields,
  extractLinkTargets,
  parseKnowledgeTree,
  planRollback,
  serializeKnowledgeTree,
  type KnowledgeActorType,
  type KnowledgeApprovalGateItem,
  type KnowledgeApprover,
  type KnowledgeItemStatus,
  type KnowledgeKind,
  type KnowledgeRevisionStatus,
  type KnowledgeSourceKind,
  type KnowledgeTreePage,
  type SearchIndex,
} from "./domain.js";

export interface KnowledgeActor {
  actorType: KnowledgeActorType;
  actorId: string | null;
  /** The role/caste/authority kind the actor presents at approve time. */
  kind?: string | null;
}

export interface KnowledgeItemDto {
  id: string;
  companyId: string;
  nestId: string;
  kind: KnowledgeKind;
  slug: string;
  title: string;
  summary: string | null;
  status: KnowledgeItemStatus;
  folderPath: string;
  tags: string[];
  approvalRequired: boolean;
  approverKind: string | null;
  /**
   * myrmidon(1.7 KNOWLEDGE-2.0 L-3, §3.7): castes the page is delivered to in
   * `KNOWLEDGE_INDEX.md` (`["*"]` = every caste; empty = not delivered).
   */
  deliverToCastes: string[];
  deliveredRevisionId: string | null;
  currentRevisionNumber: number;
  supersededByItemId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeRevisionDto {
  id: string;
  itemId: string;
  revisionNumber: number;
  status: KnowledgeRevisionStatus;
  content: string;
  changeSummary: string | null;
  rolledBackFromRevisionId: string | null;
  approvedByKind: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  sources: Array<{ kind: KnowledgeSourceKind; ref: string; note: string | null }>;
}

export interface KnowledgeEventDto {
  id: string;
  itemId: string | null;
  revisionId: string | null;
  event: string;
  payload: Record<string, unknown>;
  actorType: string;
  actorId: string | null;
  createdAt: string;
}

export interface KnowledgeBacklinkDto {
  sourceItemId: string;
  sourceSlug: string;
  sourceTitle: string;
  targetSlug: string;
  resolved: boolean;
}

export interface CreateKnowledgeInput {
  companyId: string;
  /** Today one nest per company; the field is explicit so K-4 can split. */
  nestId: string;
  slug: string;
  title: string;
  content: string;
  kind?: KnowledgeKind;
  summary?: string | null;
  folderPath?: string;
  tags?: string[];
  approvalRequired?: boolean;
  approverKind?: string | null;
  /**
   * myrmidon(1.7 KNOWLEDGE-2.0 L-3, §3.7): castes the page is delivered to in
   * `KNOWLEDGE_INDEX.md` (`["*"]` = every caste; empty/omitted = not delivered).
   */
  deliverToCastes?: string[];
  sources?: Array<{ kind: KnowledgeSourceKind; ref: string; note?: string | null }>;
}

export interface DraftKnowledgeInput {
  content: string;
  changeSummary?: string | null;
  sources?: Array<{ kind: KnowledgeSourceKind; ref: string; note?: string | null }>;
  /** Submit straight to review instead of leaving the revision as draft. */
  submit?: boolean;
}

export interface ApproveKnowledgeInput {
  revisionId?: string;
  approvalId?: string | null;
  /** Optional pointer/publish in the same call (approve then deliver). */
  publish?: boolean;
}

export interface RollbackKnowledgeInput {
  targetRevisionId: string;
  publish?: boolean;
  changeSummary?: string | null;
}

export interface SupersedeKnowledgeInput {
  bySlug: string;
}

export interface ImportTreeResult {
  created: number;
  updated: number;
  pages: number;
}

export interface KnowledgeServiceOptions {
  searchIndex?: SearchIndex;
  /** When false (default) activity mirroring is skipped if logActivity fails. */
  now?: () => Date;
}

type ItemRow = typeof knowledgeItems.$inferSelect;
type RevisionRow = typeof knowledgeRevisions.$inferSelect;

function toItemDto(row: ItemRow): KnowledgeItemDto {
  return {
    id: row.id,
    companyId: row.companyId,
    nestId: row.nestId,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    status: row.status,
    folderPath: row.folderPath,
    tags: row.tags ?? [],
    approvalRequired: row.approvalRequired,
    approverKind: row.approverKind,
    deliverToCastes: row.deliverToCastes ?? [],
    deliveredRevisionId: row.deliveredRevisionId,
    currentRevisionNumber: row.currentRevisionNumber,
    supersededByItemId: row.supersededByItemId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRevisionDto(
  row: RevisionRow,
  sources: Array<{ kind: KnowledgeSourceKind; ref: string; note: string | null }>,
): KnowledgeRevisionDto {
  return {
    id: row.id,
    itemId: row.itemId,
    revisionNumber: row.revisionNumber,
    status: row.status,
    content: row.content,
    changeSummary: row.changeSummary,
    rolledBackFromRevisionId: row.rolledBackFromRevisionId,
    approvedByKind: row.approvedByKind,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    sources,
  };
}

export function createKnowledgeService(db: Db, options: KnowledgeServiceOptions = {}) {
  const now = options.now ?? (() => new Date());
  const search = options.searchIndex ?? null;

  async function loadItem(nestId: string, idOrSlug: string): Promise<ItemRow> {
    const byId = idOrSlug.length >= 20 && !idOrSlug.includes("/") && /^[0-9a-f-]{36}$/i.test(idOrSlug);
    const rows = byId
      ? await db.select().from(knowledgeItems).where(and(eq(knowledgeItems.nestId, nestId), eq(knowledgeItems.id, idOrSlug))).limit(2)
      : await db.select().from(knowledgeItems).where(and(eq(knowledgeItems.nestId, nestId), eq(knowledgeItems.slug, idOrSlug))).limit(2);
    if (rows.length === 0) throw new KnowledgeDomainError("knowledge_not_found", 404, `No knowledge item "${idOrSlug}" in this nest.`);
    return rows[0]!;
  }

  async function appendEvent(
    tx: Db | Parameters<Parameters<Db["transaction"]>[0]>[0],
    input: {
      companyId: string;
      nestId: string;
      itemId: string | null;
      revisionId?: string | null;
      event: string;
      payload: Record<string, unknown>;
      actor: KnowledgeActor;
    },
  ): Promise<void> {
    await tx.insert(knowledgeEvents).values({
      companyId: input.companyId,
      nestId: input.nestId,
      itemId: input.itemId,
      revisionId: input.revisionId ?? null,
      event: input.event,
      payload: input.payload,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      createdAt: now(),
    });
  }

  async function mirrorActivity(input: {
    companyId: string;
    itemId: string;
    slug: string;
    event: string;
    actor: KnowledgeActor;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.actor.actorType === "agent" ? "agent" : input.actor.actorType === "user" ? "user" : "system",
      actorId: input.actor.actorId ?? input.actor.actorType,
      action: input.event,
      entityType: "knowledge_item",
      entityId: input.itemId,
      agentId: input.actor.actorType === "agent" ? (input.actor.actorId ?? null) : null,
      details: { slug: input.slug, ...input.payload },
    });
  }

  async function reindex(nestId: string, itemId: string): Promise<void> {
    if (!search) return;
    const [item] = await db
      .select()
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.nestId, nestId), eq(knowledgeItems.id, itemId)))
      .limit(1);
    if (!item) return;
    let content = "";
    if (item.deliveredRevisionId) {
      const [rev] = await db
        .select({ content: knowledgeRevisions.content })
        .from(knowledgeRevisions)
        .where(eq(knowledgeRevisions.id, item.deliveredRevisionId))
        .limit(1);
      content = rev?.content ?? "";
    }
    await search.upsert({ itemId: item.id, nestId, slug: item.slug, title: item.title, summary: item.summary, content });
  }

  async function syncLinks(tx: Db | Parameters<Parameters<Db["transaction"]>[0]>[0], item: { companyId: string; nestId: string; id: string; slug: string }, content: string): Promise<void> {
    const targets = extractLinkTargets(content);
    await tx.delete(knowledgeLinks).where(eq(knowledgeLinks.sourceItemId, item.id));
    const resolved = targets.length
      ? await tx
          .select({ slug: knowledgeItems.slug, id: knowledgeItems.id })
          .from(knowledgeItems)
          .where(and(eq(knowledgeItems.nestId, item.nestId), inArray(knowledgeItems.slug, targets)))
      : [];
    const bySlug = new Map(resolved.map((row) => [row.slug, row.id]));
    for (const target of targets) {
      await tx.insert(knowledgeLinks).values({
        companyId: item.companyId,
        nestId: item.nestId,
        sourceItemId: item.id,
        targetSlug: target,
        resolvedItemId: bySlug.get(target) ?? null,
      });
    }
    // S7: an unresolved `[[slug]]` written before its page must start
    // pointing at it once the page appears — resolve rows that target this
    // very item, not just the item's own targets.
    const backfillTargets = [...new Set([item.slug, ...targets.filter((t) => bySlug.has(t))])];
    for (const target of backfillTargets) {
      const resolvedId = target === item.slug ? item.id : bySlug.get(target)!;
      await tx
        .update(knowledgeLinks)
        .set({ resolvedItemId: resolvedId })
        .where(and(eq(knowledgeLinks.targetSlug, target), isNull(knowledgeLinks.resolvedItemId), eq(knowledgeLinks.nestId, item.nestId)));
    }
  }

  // ---------------------------------------------------------------- create

  async function create(input: CreateKnowledgeInput, actor: KnowledgeActor): Promise<KnowledgeItemDto> {
    assertValidSlug(input.slug);
    assertSingleLine(input.title, "Title");
    if (input.summary != null) assertSingleLine(input.summary, "Summary");
    assertValidTags(input.tags ?? []);
    const kind = input.kind ?? "note";
    const approvalRequired = kind === "rule" ? true : (input.approvalRequired ?? false);
    assertRuleFields(kind, approvalRequired, input.approverKind ?? null);
    const deliverToCastes = input.deliverToCastes ?? [];

    const createdAt = now();
    const row = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: knowledgeItems.id })
        .from(knowledgeItems)
        .where(and(eq(knowledgeItems.nestId, input.nestId), eq(knowledgeItems.slug, input.slug)))
        .limit(1);
      if (existing.length > 0) {
        throw new KnowledgeDomainError("slug_conflict", 409, `Knowledge slug "${input.slug}" already exists in this nest.`);
      }
      const [item] = await tx
        .insert(knowledgeItems)
        .values({
          companyId: input.companyId,
          nestId: input.nestId,
          kind,
          slug: input.slug,
          title: input.title,
          summary: input.summary ?? null,
          status: "draft",
          folderPath: input.folderPath ?? "",
          tags: input.tags ?? [],
          approvalRequired,
          approverKind: input.approverKind ?? null,
          deliverToCastes,
          deliveredRevisionId: null,
          currentRevisionNumber: 1,
          createdByAgentId: actor.actorType === "agent" ? (actor.actorId ?? null) : null,
          createdByUserId: actor.actorType === "user" ? (actor.actorId ?? null) : null,
          createdAt,
          updatedAt: createdAt,
        })
        .returning();

      const [revision] = await tx
        .insert(knowledgeRevisions)
        .values({
          companyId: input.companyId,
          nestId: input.nestId,
          itemId: item!.id,
          revisionNumber: 1,
          status: "draft",
          content: input.content,
          changeSummary: "created",
          createdByAgentId: actor.actorType === "agent" ? (actor.actorId ?? null) : null,
          createdByUserId: actor.actorType === "user" ? (actor.actorId ?? null) : null,
          createdAt,
        })
        .returning();

      for (const source of input.sources ?? []) {
        await tx.insert(knowledgeSources).values({
          companyId: input.companyId,
          nestId: input.nestId,
          revisionId: revision!.id,
          kind: source.kind,
          ref: source.ref,
          note: source.note ?? null,
        });
      }

      await syncLinks(tx, item!, input.content);
      await appendEvent(tx, {
        companyId: input.companyId,
        nestId: input.nestId,
        itemId: item!.id,
        revisionId: revision!.id,
        event: "knowledge.created",
        payload: { slug: input.slug, kind },
        actor,
      });
      return item!;
    });

    await mirrorActivity({ companyId: row.companyId, itemId: row.id, slug: row.slug, event: "knowledge.created", actor, payload: { kind: row.kind } });
    await reindex(row.nestId, row.id);
    return toItemDto(row);
  }

  // ----------------------------------------------------------------- draft

  async function draft(nestId: string, idOrSlug: string, input: DraftKnowledgeInput, actor: KnowledgeActor): Promise<KnowledgeItemDto> {
    const current = await loadItem(nestId, idOrSlug);
    if (current.status === "superseded") {
      throw new KnowledgeDomainError("superseded_read_only", 409, "A superseded item takes no new revisions.");
    }
    if (input.changeSummary != null) assertSingleLine(input.changeSummary, "Change summary");
    const timestamp = now();

    const row = await db.transaction(async (tx) => {
      // Lock the item row so concurrent drafts serialize on the revision
      // number (the unique (item_id, revision_number) is the backstop).
      const [locked] = await tx
        .select()
        .from(knowledgeItems)
        .where(and(eq(knowledgeItems.nestId, nestId), eq(knowledgeItems.id, current.id)))
        .for("update");
      const nextNumber = locked!.currentRevisionNumber + 1;
      const [revision] = await tx
        .insert(knowledgeRevisions)
        .values({
          companyId: locked!.companyId,
          nestId,
          itemId: locked!.id,
          revisionNumber: nextNumber,
          status: input.submit ? "submitted" : "draft",
          content: input.content,
          changeSummary: input.changeSummary ?? null,
          createdByAgentId: actor.actorType === "agent" ? (actor.actorId ?? null) : null,
          createdByUserId: actor.actorType === "user" ? (actor.actorId ?? null) : null,
          createdAt: timestamp,
        })
        .returning();

      for (const source of input.sources ?? []) {
        await tx.insert(knowledgeSources).values({
          companyId: locked!.companyId,
          nestId,
          revisionId: revision!.id,
          kind: source.kind,
          ref: source.ref,
          note: source.note ?? null,
        });
      }

      // S3: a draft NEVER moves the delivery pointer — the update below
      // writes only the fields that are not pointer fields, and
      // `draftPointerFields()` documents that the pointer set stays untouched.
      void draftPointerFields();
      const [updated] = await tx
        .update(knowledgeItems)
        .set({
          currentRevisionNumber: nextNumber,
          status: input.submit && locked!.status === "draft" ? "in_review" : locked!.status,
          updatedAt: timestamp,
        })
        .where(and(eq(knowledgeItems.nestId, nestId), eq(knowledgeItems.id, locked!.id)))
        .returning();

      await syncLinks(tx, updated!, input.content);
      await appendEvent(tx, {
        companyId: locked!.companyId,
        nestId,
        itemId: locked!.id,
        revisionId: revision!.id,
        event: "knowledge.draft",
        payload: { slug: locked!.slug, revisionNumber: nextNumber, deliveredRevisionIdUnchanged: true },
        actor,
      });
      return updated!;
    });

    await mirrorActivity({ companyId: row.companyId, itemId: row.id, slug: row.slug, event: "knowledge.draft", actor, payload: {} });
    return toItemDto(row);
  }

  // ---------------------------------------------------------------- submit

  async function submit(nestId: string, idOrSlug: string, actor: KnowledgeActor, revisionId?: string): Promise<KnowledgeItemDto> {
    const current = await loadItem(nestId, idOrSlug);
    assertItemTransition(current.status, "in_review");

    const row = await db.transaction(async (tx) => {
      const [target] = revisionId
        ? await tx
            .select()
            .from(knowledgeRevisions)
            .where(and(eq(knowledgeRevisions.itemId, current.id), eq(knowledgeRevisions.id, revisionId)))
        : await tx
            .select()
            .from(knowledgeRevisions)
            .where(and(eq(knowledgeRevisions.itemId, current.id), eq(knowledgeRevisions.revisionNumber, current.currentRevisionNumber)));
      if (!target) throw new KnowledgeDomainError("revision_not_found", 404, "The revision to submit does not exist.");
      assertRevisionTransition(target.status, "submitted");

      await tx
        .update(knowledgeRevisions)
        .set({ status: "submitted" })
        .where(eq(knowledgeRevisions.id, target.id));
      const [updated] = await tx
        .update(knowledgeItems)
        .set({ status: "in_review", updatedAt: now() })
        .where(and(eq(knowledgeItems.nestId, nestId), eq(knowledgeItems.id, current.id)))
        .returning();
      await appendEvent(tx, {
        companyId: current.companyId,
        nestId,
        itemId: current.id,
        revisionId: target.id,
        event: "knowledge.submitted",
        payload: { slug: current.slug, revisionNumber: target.revisionNumber },
        actor,
      });
      return updated!;
    });

    await mirrorActivity({ companyId: row.companyId, itemId: row.id, slug: row.slug, event: "knowledge.submitted", actor, payload: {} });
    return toItemDto(row);
  }

  // ---------------------------------------------------------------- publish

  /**
   * Move the delivery pointer onto a revision. Without approval-required
   * rules any head revision delivers; with them the revision must already be
   * approved (an unapproved publish is 409, not a silent pass).
   */
  async function publish(nestId: string, idOrSlug: string, actor: KnowledgeActor, revisionId?: string): Promise<KnowledgeItemDto> {
    const current = await loadItem(nestId, idOrSlug);
    // Re-publishing an already-published item onto another revision is a
    // delivery (pointer move), not a status change — §2.4 has no
    // published→published edge, so only assert when the status actually moves.
    if (current.status !== "published") assertItemTransition(current.status, "published");

    const row = await db.transaction(async (tx) => {
      let revision: RevisionRow | undefined;
      if (revisionId) {
        [revision] = await tx.select().from(knowledgeRevisions).where(and(eq(knowledgeRevisions.itemId, current.id), eq(knowledgeRevisions.id, revisionId)));
      } else {
        [revision] = await tx
          .select()
          .from(knowledgeRevisions)
          .where(and(eq(knowledgeRevisions.itemId, current.id), eq(knowledgeRevisions.revisionNumber, current.currentRevisionNumber)));
      }
      if (!revision) throw new KnowledgeDomainError("revision_not_found", 404, "Nothing to publish: the revision does not exist.");
      if (current.approvalRequired && revision.status !== "approved") {
        throw new KnowledgeDomainError(
          "publish_requires_approval",
          409,
          "This item requires approval; publish needs an approved revision (approve first).",
        );
      }
      // S3: the delivered pointer must be an approved revision. Delivering a
      // note (no approval gate) approves it by the act of publishing; a rule
      // reaches here only after `approve` already flipped it.
      if (revision.status !== "approved") {
        await tx
          .update(knowledgeRevisions)
          .set({ status: "approved", approvedAt: now() })
          .where(eq(knowledgeRevisions.id, revision.id));
      }
      const [updated] = await tx
        .update(knowledgeItems)
        .set({ status: "published", deliveredRevisionId: revision.id, updatedAt: now() })
        .where(and(eq(knowledgeItems.nestId, nestId), eq(knowledgeItems.id, current.id)))
        .returning();
      await appendEvent(tx, {
        companyId: current.companyId,
        nestId,
        itemId: current.id,
        revisionId: revision.id,
        event: "knowledge.published",
        payload: { slug: current.slug, revisionNumber: revision.revisionNumber },
        actor,
      });
      return updated!;
    });

    await mirrorActivity({ companyId: row.companyId, itemId: row.id, slug: row.slug, event: "knowledge.published", actor, payload: {} });
    await reindex(row.nestId, row.id);
    return toItemDto(row);
  }

  // ---------------------------------------------------------------- approve

  /**
   * S4: the approval gate. The domain refuses a rule without `approver_kind`
   * with 403 (the acceptance criterion) and refuses the wrong kind; a
   * non-approval-required item approves any identified actor.
   */
  async function approve(nestId: string, idOrSlug: string, actor: KnowledgeActor, input: ApproveKnowledgeInput = {}): Promise<KnowledgeItemDto> {
    const current = await loadItem(nestId, idOrSlug);
    const gateItem: KnowledgeApprovalGateItem = {
      kind: current.kind,
      approvalRequired: current.approvalRequired,
      approverKind: current.approverKind,
    };
    const approver: KnowledgeApprover = { actorType: actor.actorType, actorId: actor.actorId, kind: actor.kind ?? null };
    assertApprovable(gateItem, approver);

    const row = await db.transaction(async (tx) => {
      const [revision] = input.revisionId
        ? await tx.select().from(knowledgeRevisions).where(and(eq(knowledgeRevisions.itemId, current.id), eq(knowledgeRevisions.id, input.revisionId)))
        : await tx
            .select()
            .from(knowledgeRevisions)
            .where(and(eq(knowledgeRevisions.itemId, current.id), eq(knowledgeRevisions.revisionNumber, current.currentRevisionNumber)));
      if (!revision) throw new KnowledgeDomainError("revision_not_found", 404, "The revision to approve does not exist.");
      assertRevisionTransition(revision.status, "approved");

      await tx
        .update(knowledgeRevisions)
        .set({
          status: "approved",
          approvalId: input.approvalId ?? null,
          approvedByKind: approver.kind,
          approvedBy: `${actor.actorType}:${actor.actorId ?? "unknown"}`,
          approvedAt: now(),
        })
        .where(eq(knowledgeRevisions.id, revision.id));

      const set: Partial<ItemRow> = { updatedAt: now() };
      if (input.publish) {
        assertItemTransition(current.status, "published");
        set.status = "published";
        set.deliveredRevisionId = revision.id;
      } else if (current.status === "in_review") {
        set.status = "in_review";
      }
      const [updated] = await tx
        .update(knowledgeItems)
        .set(set)
        .where(and(eq(knowledgeItems.nestId, nestId), eq(knowledgeItems.id, current.id)))
        .returning();
      await appendEvent(tx, {
        companyId: current.companyId,
        nestId,
        itemId: current.id,
        revisionId: revision.id,
        event: "knowledge.approved",
        payload: { slug: current.slug, revisionNumber: revision.revisionNumber, published: Boolean(input.publish) },
        actor,
      });
      return updated!;
    });

    await mirrorActivity({ companyId: row.companyId, itemId: row.id, slug: row.slug, event: "knowledge.approved", actor, payload: {} });
    if (input.publish) await reindex(row.nestId, row.id);
    return toItemDto(row);
  }

  // ---------------------------------------------------------------- rollback

  /** S5: a rollback is ONE MORE revision (a copy of an approved target) plus a pointer move. */
  async function rollback(nestId: string, idOrSlug: string, actor: KnowledgeActor, input: RollbackKnowledgeInput): Promise<KnowledgeItemDto> {
    const current = await loadItem(nestId, idOrSlug);
    const [target] = await db
      .select()
      .from(knowledgeRevisions)
      .where(and(eq(knowledgeRevisions.itemId, current.id), eq(knowledgeRevisions.id, input.targetRevisionId)));
    if (!target) throw new KnowledgeDomainError("revision_not_found", 404, "The rollback target revision does not exist.");

    const plan = planRollback(
      { deliveredRevisionId: current.deliveredRevisionId, currentRevisionNumber: current.currentRevisionNumber },
      { revisionId: target.id, revisionNumber: target.revisionNumber, status: target.status },
    );

    const row = await db.transaction(async (tx) => {
      const [copy] = await tx
        .insert(knowledgeRevisions)
        .values({
          companyId: current.companyId,
          nestId,
          itemId: current.id,
          revisionNumber: plan.newRevisionNumber,
          status: "approved",
          content: target.content,
          changeSummary: input.changeSummary ?? `rollback to revision ${target.revisionNumber}`,
          rolledBackFromRevisionId: target.id,
          createdAt: now(),
          createdByAgentId: actor.actorType === "agent" ? (actor.actorId ?? null) : null,
          createdByUserId: actor.actorType === "user" ? (actor.actorId ?? null) : null,
        })
        .returning();

      // Mirror the sources of the copied revision onto the copy (provenance
      // travels with the rollback).
      const mirrored = await tx
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.revisionId, target.id));
      for (const source of mirrored) {
        await tx.insert(knowledgeSources).values({
          companyId: current.companyId,
          nestId,
          revisionId: copy!.id,
          kind: source.kind,
          ref: source.ref,
          note: source.note,
        });
      }

      const statusToDeliver = input.publish && current.status !== "published" ? "published" : current.status;
      const [updated] = await tx
        .update(knowledgeItems)
        .set({
          currentRevisionNumber: plan.newRevisionNumber,
          deliveredRevisionId: copy!.id,
          status: statusToDeliver,
          updatedAt: now(),
        })
        .where(and(eq(knowledgeItems.nestId, nestId), eq(knowledgeItems.id, current.id)))
        .returning();

      await appendEvent(tx, {
        companyId: current.companyId,
        nestId,
        itemId: current.id,
        revisionId: copy!.id,
        event: "knowledge.rollback",
        payload: { slug: current.slug, newRevisionNumber: plan.newRevisionNumber, rolledBackFromRevisionId: target.id },
        actor,
      });
      return updated!;
    });

    await mirrorActivity({ companyId: row.companyId, itemId: row.id, slug: row.slug, event: "knowledge.rollback", actor, payload: { revisionNumber: row.currentRevisionNumber } });
    await reindex(row.nestId, row.id);
    return toItemDto(row);
  }

  // ---------------------------------------------------------------- archive

  async function archive(nestId: string, idOrSlug: string, actor: KnowledgeActor): Promise<KnowledgeItemDto> {
    const current = await loadItem(nestId, idOrSlug);
    assertItemTransition(current.status, "archived");

    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(knowledgeItems)
        .set({ status: "archived", deliveredRevisionId: null, updatedAt: now() })
        .where(and(eq(knowledgeItems.nestId, nestId), eq(knowledgeItems.id, current.id)))
        .returning();
      await appendEvent(tx, {
        companyId: current.companyId,
        nestId,
        itemId: current.id,
        event: "knowledge.archived",
        payload: { slug: current.slug },
        actor,
      });
      return updated!;
    });

    await mirrorActivity({ companyId: row.companyId, itemId: row.id, slug: row.slug, event: "knowledge.archived", actor, payload: {} });
    if (search) await search.remove(row.id);
    return toItemDto(row);
  }

  // -------------------------------------------------------------- supersede

  /** S6: an item retired in favour of another one; terminal, pointer cleared. */
  async function supersede(nestId: string, idOrSlug: string, actor: KnowledgeActor, input: SupersedeKnowledgeInput): Promise<KnowledgeItemDto> {
    assertValidSlug(input.bySlug);
    const current = await loadItem(nestId, idOrSlug);
    assertItemTransition(current.status, "superseded");
    const replacement = await loadItem(nestId, input.bySlug);
    if (replacement.id === current.id) {
      throw new KnowledgeDomainError("supersede_self", 400, "An item cannot supersede itself.");
    }

    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(knowledgeItems)
        .set({ status: "superseded", supersededByItemId: replacement.id, deliveredRevisionId: null, updatedAt: now() })
        .where(and(eq(knowledgeItems.nestId, nestId), eq(knowledgeItems.id, current.id)))
        .returning();
      await appendEvent(tx, {
        companyId: current.companyId,
        nestId,
        itemId: current.id,
        event: "knowledge.superseded",
        payload: { slug: current.slug, bySlug: replacement.slug },
        actor,
      });
      return updated!;
    });

    await mirrorActivity({ companyId: row.companyId, itemId: row.id, slug: row.slug, event: "knowledge.superseded", actor, payload: { bySlug: replacement.slug } });
    if (search) await search.remove(row.id);
    return toItemDto(row);
  }

  // ------------------------------------------------------------------ read

  async function get(nestId: string, idOrSlug: string): Promise<(KnowledgeItemDto & { deliveredContent: string | null }) | null> {
    try {
      const item = await loadItem(nestId, idOrSlug);
      let deliveredContent: string | null = null;
      if (item.deliveredRevisionId) {
        const [rev] = await db
          .select({ content: knowledgeRevisions.content })
          .from(knowledgeRevisions)
          .where(eq(knowledgeRevisions.id, item.deliveredRevisionId));
        deliveredContent = rev?.content ?? null;
      }
      return { ...toItemDto(item), deliveredContent };
    } catch (error) {
      if (error instanceof KnowledgeDomainError && error.status === 404) return null;
      throw error;
    }
  }

  async function getRevision(nestId: string, idOrSlug: string, revisionId: string): Promise<KnowledgeRevisionDto | null> {
    const item = await loadItem(nestId, idOrSlug);
    const [rev] = await db
      .select()
      .from(knowledgeRevisions)
      .where(and(eq(knowledgeRevisions.itemId, item.id), eq(knowledgeRevisions.id, revisionId)));
    if (!rev) return null;
    const sources = await db
      .select({ kind: knowledgeSources.kind, ref: knowledgeSources.ref, note: knowledgeSources.note })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.revisionId, rev.id));
    return toRevisionDto(rev, sources);
  }

  async function listRevisions(nestId: string, idOrSlug: string): Promise<KnowledgeRevisionDto[]> {
    const item = await loadItem(nestId, idOrSlug);
    const rows = await db
      .select()
      .from(knowledgeRevisions)
      .where(eq(knowledgeRevisions.itemId, item.id))
      .orderBy(asc(knowledgeRevisions.revisionNumber));
    const sourceRows = rows.length
      ? await db
          .select({ revisionId: knowledgeSources.revisionId, kind: knowledgeSources.kind, ref: knowledgeSources.ref, note: knowledgeSources.note })
          .from(knowledgeSources)
          .where(inArray(knowledgeSources.revisionId, rows.map((r) => r.id)))
      : [];
    return rows.map((row) =>
      toRevisionDto(
        row,
        sourceRows.filter((s) => s.revisionId === row.id).map((s) => ({ kind: s.kind, ref: s.ref, note: s.note })),
      ),
    );
  }

  async function listItems(
    nestId: string,
    filter: { status?: KnowledgeItemStatus; kind?: KnowledgeKind; folderPrefix?: string } = {},
  ): Promise<KnowledgeItemDto[]> {
    const conditions = [eq(knowledgeItems.nestId, nestId)];
    if (filter.status) conditions.push(eq(knowledgeItems.status, filter.status));
    if (filter.kind) conditions.push(eq(knowledgeItems.kind, filter.kind));
    const rows = await db.select().from(knowledgeItems).where(and(...conditions)).orderBy(asc(knowledgeItems.slug));
    let dtos = rows.map(toItemDto);
    if (filter.folderPrefix != null) {
      const prefix = filter.folderPrefix === "" ? "" : `${filter.folderPrefix.replace(/\/+$/, "")}/`;
      dtos = dtos.filter((dto) => dto.folderPath === filter.folderPrefix || dto.folderPath.startsWith(prefix));
    }
    return dtos;
  }

  /** Backlinks: which items link to this one (§3.2: links are rows, not scans). */
  async function backlinks(nestId: string, idOrSlug: string): Promise<KnowledgeBacklinkDto[]> {
    const item = await loadItem(nestId, idOrSlug);
    const rows = await db
      .select({
        sourceSlug: knowledgeItems.slug,
        sourceTitle: knowledgeItems.title,
        sourceItemId: knowledgeLinks.sourceItemId,
        targetSlug: knowledgeLinks.targetSlug,
        resolvedItemId: knowledgeLinks.resolvedItemId,
      })
      .from(knowledgeLinks)
      .innerJoin(knowledgeItems, eq(knowledgeItems.id, knowledgeLinks.sourceItemId))
      .where(and(eq(knowledgeLinks.nestId, nestId), or(eq(knowledgeLinks.targetSlug, item.slug), eq(knowledgeLinks.resolvedItemId, item.id))));
    return rows
      .filter((row) => row.sourceItemId !== item.id)
      .map((row) => ({
        sourceItemId: row.sourceItemId,
        sourceSlug: row.sourceSlug,
        sourceTitle: row.sourceTitle,
        targetSlug: row.targetSlug,
        resolved: row.resolvedItemId === item.id,
      }));
  }

  async function listEvents(nestId: string, itemId?: string, limit = 100): Promise<KnowledgeEventDto[]> {
    const conditions = [eq(knowledgeEvents.nestId, nestId)];
    if (itemId) conditions.push(eq(knowledgeEvents.itemId, itemId));
    const rows = await db
      .select()
      .from(knowledgeEvents)
      .where(and(...conditions))
      .orderBy(asc(knowledgeEvents.createdAt))
      .limit(Math.max(1, Math.min(limit, 1000)));
    return rows.map((row) => ({
      id: row.id,
      itemId: row.itemId,
      revisionId: row.revisionId,
      event: row.event,
      payload: row.payload as Record<string, unknown>,
      actorType: row.actorType,
      actorId: row.actorId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async function searchNest(nestId: string, query: string, limit = 20): Promise<Array<{ itemId: string; slug: string; title: string }>> {
    if (!search) throw new KnowledgeDomainError("search_unavailable", 501, "No SearchIndex is attached to this knowledge service.");
    return search.search(nestId, query, limit);
  }

  // ------------------------------------------------------- suggestions S8

  async function suggest(
    nestId: string,
    actor: KnowledgeActor,
    input: {
      companyId: string;
      body: string;
      rationale?: string | null;
      targetSlug?: string | null;
      sourceKind?: KnowledgeSourceKind;
      sourceRef?: string | null;
    },
  ): Promise<{ id: string; targetItemId: string | null; status: string; createdAt: string }> {
    assertSingleLine(input.body, "Suggestion body");
    let targetId: string | null = null;
    if (input.targetSlug) {
      const target = await loadItem(nestId, input.targetSlug);
      targetId = target.id;
    }
    const [row] = await db
      .insert(knowledgeSuggestions)
      .values({
        companyId: input.companyId,
        nestId,
        targetItemId: targetId,
        body: input.body,
        rationale: input.rationale ?? null,
        sourceKind: input.sourceKind ?? null,
        sourceRef: input.sourceRef ?? null,
        status: "pending",
        createdByAgentId: actor.actorType === "agent" ? (actor.actorId ?? null) : null,
        createdByUserId: actor.actorType === "user" ? (actor.actorId ?? null) : null,
        createdAt: now(),
      })
      .returning();
    await appendEvent(db, {
      companyId: input.companyId,
      nestId,
      itemId: targetId,
      event: "knowledge.suggested",
      payload: { body: input.body },
      actor,
    });
    return { id: row!.id, targetItemId: row!.targetItemId, status: row!.status, createdAt: row!.createdAt.toISOString() };
  }

  async function decideSuggestion(
    nestId: string,
    actor: KnowledgeActor,
    input: { suggestionId: string; companyId: string; decision: "accepted" | "declined" },
  ): Promise<{ id: string; status: string }> {
    const [row] = await db
      .select()
      .from(knowledgeSuggestions)
      .where(and(eq(knowledgeSuggestions.nestId, nestId), eq(knowledgeSuggestions.id, input.suggestionId)))
      .limit(1);
    if (!row) throw new KnowledgeDomainError("suggestion_not_found", 404, "No such suggestion.");
    if (row.status !== "pending") {
      throw new KnowledgeDomainError("suggestion_decided", 409, `Suggestion is already ${row.status}.`);
    }
    await db
      .update(knowledgeSuggestions)
      .set({ status: input.decision, decidedBy: `${actor.actorType}:${actor.actorId ?? "unknown"}`, decidedAt: now() })
      .where(eq(knowledgeSuggestions.id, row.id));
    await appendEvent(db, {
      companyId: input.companyId,
      nestId,
      itemId: row.targetItemId,
      event: input.decision === "accepted" ? "knowledge.suggestion.accepted" : "knowledge.suggestion.declined",
      payload: { suggestionId: row.id },
      actor,
    });
    return { id: row.id, status: input.decision };
  }

  async function listSuggestions(nestId: string, status: "pending" | "accepted" | "declined" | "all" = "pending"): Promise<Array<{ id: string; targetItemId: string | null; body: string; status: string; createdAt: string }>> {
    const conditions = [eq(knowledgeSuggestions.nestId, nestId)];
    if (status !== "all") conditions.push(eq(knowledgeSuggestions.status, status));
    const rows = await db.select().from(knowledgeSuggestions).where(and(...conditions)).orderBy(asc(knowledgeSuggestions.createdAt));
    return rows.map((row) => ({
      id: row.id,
      targetItemId: row.targetItemId,
      body: row.body,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // ------------------------------------------------------- export / import

  /** Canonical byte-for-byte export of the whole nest tree (§3.2). */
  async function exportTree(nestId: string): Promise<Buffer> {
    const items = await db.select().from(knowledgeItems).where(eq(knowledgeItems.nestId, nestId)).orderBy(asc(knowledgeItems.slug));
    const deliveredIds = items.map((item) => item.deliveredRevisionId).filter((id): id is string => id !== null);
    const revisions = deliveredIds.length
      ? await db
          .select({ id: knowledgeRevisions.id, content: knowledgeRevisions.content })
          .from(knowledgeRevisions)
          .where(inArray(knowledgeRevisions.id, deliveredIds))
      : [];
    const contentById = new Map(revisions.map((row) => [row.id, row.content]));
    const pages: KnowledgeTreePage[] = items.map((item) => ({
      slug: item.slug,
      kind: item.kind,
      title: item.title,
      summary: item.summary,
      folder: item.folderPath,
      tags: item.tags ?? [],
      status: item.status,
      approvalRequired: item.approvalRequired,
      approverKind: item.approverKind,
      deliverToCastes: item.deliverToCastes ?? [],
      content: item.deliveredRevisionId ? (contentById.get(item.deliveredRevisionId) ?? "") : "",
    }));
    return serializeKnowledgeTree({ nestId, pages });
  }

  /**
   * Import a canonical tree. Idempotent against the same export: an existing
   * slug keeps its id, gets a new draft revision when content differs (the
   * pointer is left alone here — delivery stays an explicit publish) and the
   * metadata fields are synced. Returns counters for the caller.
   */
  async function importTree(
    companyId: string,
    nestId: string,
    buf: Buffer,
    actor: KnowledgeActor,
    options: { publishOnImport?: boolean } = {},
  ): Promise<ImportTreeResult> {
    const doc = parseKnowledgeTree(buf);
    if (doc.nestId !== nestId) {
      throw new KnowledgeDomainError("nest_mismatch", 400, `Tree was exported for nest ${doc.nestId}, not ${nestId}.`);
    }
    let created = 0;
    let updated = 0;

    for (const page of doc.pages) {
      assertValidSlug(page.slug);
      assertRuleFields(page.kind, page.approvalRequired, page.approverKind);
      const existing = await loadItem(nestId, page.slug).catch(() => null);
      const timestamp = now();

      if (!existing) {
        await db.transaction(async (tx) => {
          const [item] = await tx
            .insert(knowledgeItems)
            .values({
              companyId,
              nestId,
              kind: page.kind,
              slug: page.slug,
              title: page.title,
              summary: page.summary,
              status: page.status,
              folderPath: page.folder,
              tags: page.tags,
              approvalRequired: page.approvalRequired,
              approverKind: page.approverKind,
              deliverToCastes: page.deliverToCastes ?? [],
              deliveredRevisionId: null,
              currentRevisionNumber: 1,
              createdByAgentId: actor.actorType === "agent" ? (actor.actorId ?? null) : null,
              createdByUserId: actor.actorType === "user" ? (actor.actorId ?? null) : null,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning();
          const [revision] = await tx
            .insert(knowledgeRevisions)
            .values({
              companyId,
              nestId,
              itemId: item!.id,
              revisionNumber: 1,
              status: page.status === "published" ? "approved" : "draft",
              content: page.content,
              changeSummary: "import",
              createdAt: timestamp,
            })
            .returning();
          if (page.status === "published" && options.publishOnImport !== false) {
            await tx
              .update(knowledgeItems)
              .set({ deliveredRevisionId: revision!.id })
              .where(eq(knowledgeItems.id, item!.id));
          }
          await syncLinks(tx, item!, page.content);
          await appendEvent(tx, {
            companyId,
            nestId,
            itemId: item!.id,
            revisionId: revision!.id,
            event: "knowledge.imported",
            payload: { slug: page.slug, mode: "created" },
            actor,
          });
        });
        created += 1;
      } else {
        const currentContent = existing.deliveredRevisionId
          ? (
              await db
                .select({ content: knowledgeRevisions.content })
                .from(knowledgeRevisions)
                .where(eq(knowledgeRevisions.id, existing.deliveredRevisionId))
                .limit(1)
            )[0]?.content ?? ""
          : "";
        const changed = currentContent !== page.content;
        await db.transaction(async (tx) => {
          const set: Partial<ItemRow> = {
            title: page.title,
            summary: page.summary,
            folderPath: page.folder,
            tags: page.tags,
            approvalRequired: page.approvalRequired,
            approverKind: page.approverKind,
            deliverToCastes: page.deliverToCastes ?? [],
            kind: page.kind,
            updatedAt: timestamp,
          };
          if (changed) {
            const [revision] = await tx
              .insert(knowledgeRevisions)
              .values({
                companyId,
                nestId,
                itemId: existing.id,
                revisionNumber: existing.currentRevisionNumber + 1,
                status: "draft",
                content: page.content,
                changeSummary: "import",
                createdAt: timestamp,
              })
              .returning();
            set.currentRevisionNumber = existing.currentRevisionNumber + 1;
            // S3 holds here too: an import never silently moves the pointer;
            // a published page gets the new revision delivered explicitly.
            if (page.status === "published" && options.publishOnImport !== false) {
              set.deliveredRevisionId = revision!.id;
            }
            await syncLinks(tx, { ...existing, ...set } as ItemRow, page.content);
          } else {
            await syncLinks(tx, existing, existing.deliveredRevisionId ? currentContent : "");
          }
          await tx.update(knowledgeItems).set(set).where(eq(knowledgeItems.id, existing.id));
          await appendEvent(tx, {
            companyId,
            nestId,
            itemId: existing.id,
            event: "knowledge.imported",
            payload: { slug: page.slug, mode: changed ? "updated" : "metadata" },
            actor,
          });
        });
        updated += 1;
      }
    }

    return { created, updated, pages: doc.pages.length };
  }

  /**
   * myrmidon(1.6.6 KNOWLEDGE-2.0 K-9): the evals gate appends exactly one
   * journal line per judged publication — the judge run, the measured `delta`
   * and the verdict — so the knowledge journal can answer "which eval_run
   * gated this item, and with what delta" (§4.2 step 7). Written for both
   * outcomes (kept and rolled back); it never changes the item status.
   */
  async function recordGateJournal(
    nestId: string,
    idOrSlug: string,
    actor: KnowledgeActor,
    input: {
      subjectKind: string;
      subjectRef: string;
      evalRunId: string;
      delta: number | null;
      verdict: "keep" | "rollback";
      lifecycleEvent?: string | null;
      reason?: string | null;
      ownerNotice?: boolean;
    },
  ): Promise<void> {
    const item = await loadItem(nestId, idOrSlug);
    await appendEvent(db, {
      companyId: item.companyId,
      nestId,
      itemId: item.id,
      revisionId: item.deliveredRevisionId,
      event: "knowledge.eval_gate",
      payload: {
        eval_run_id: input.evalRunId,
        delta: input.delta,
        verdict: input.verdict,
        subject_kind: input.subjectKind,
        subject_ref: input.subjectRef,
        lifecycle_event: input.lifecycleEvent ?? null,
        reason: input.reason ?? null,
        owner_notice: input.ownerNotice === true,
      },
      actor,
    });
  }

  // ------------------------------------------------------------- deliveries
  // myrmidon(1.7 KNOWLEDGE-2.0 L-3, §3.7): what an agent's package carried at
  // its last compile. Idempotent: the same bundle hash writes nothing (the
  // compile is deterministic — the same approved rules + index pages render
  // byte-for-byte the same files, so a re-compile must not bump compiled_at
  // and hide a real change).

  async function recordKnowledgeDelivery(input: {
    companyId: string;
    nestId: string;
    agentId: string;
    bundleHash: string;
    rulesRevisionIds: string[];
    indexItemIds: string[];
  }): Promise<void> {
    const existing = await db
      .select({ id: knowledgeDeliveries.id, bundleHash: knowledgeDeliveries.bundleHash })
      .from(knowledgeDeliveries)
      .where(eq(knowledgeDeliveries.agentId, input.agentId))
      .limit(1);
    if (existing[0]?.bundleHash === input.bundleHash) return;
    await db
      .insert(knowledgeDeliveries)
      .values({
        companyId: input.companyId,
        nestId: input.nestId,
        agentId: input.agentId,
        bundleHash: input.bundleHash,
        rulesRevisionIds: input.rulesRevisionIds,
        indexItemIds: input.indexItemIds,
        compiledAt: new Date(),
      })
      .onConflictDoUpdate({
        target: knowledgeDeliveries.agentId,
        set: {
          companyId: input.companyId,
          nestId: input.nestId,
          bundleHash: input.bundleHash,
          rulesRevisionIds: input.rulesRevisionIds,
          indexItemIds: input.indexItemIds,
          compiledAt: new Date(),
        },
      });
  }

  async function getKnowledgeDelivery(agentId: string): Promise<{
    bundleHash: string;
    rulesRevisionIds: string[];
    indexItemIds: string[];
    compiledAt: string;
  } | null> {
    const [row] = await db
      .select()
      .from(knowledgeDeliveries)
      .where(eq(knowledgeDeliveries.agentId, agentId))
      .limit(1);
    if (!row) return null;
    return {
      bundleHash: row.bundleHash,
      rulesRevisionIds: row.rulesRevisionIds ?? [],
      indexItemIds: row.indexItemIds ?? [],
      compiledAt: row.compiledAt.toISOString(),
    };
  }

  /** The published rules today — the card's "approved now" side (L-3 §3.7). */
  async function listPublishedRules(nestId: string): Promise<
    Array<{ itemId: string; slug: string; title: string; revisionId: string | null; revisionNumber: number }>
  > {
    const items = await db
      .select()
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.nestId, nestId), eq(knowledgeItems.kind, "rule"), eq(knowledgeItems.status, "published")));
    return items.map((item: ItemRow) => ({
      itemId: item.id,
      slug: item.slug,
      title: item.title,
      revisionId: item.deliveredRevisionId,
      revisionNumber: item.currentRevisionNumber,
    }));
  }

  return {
    create,
    draft,
    submit,
    publish,
    approve,
    rollback,
    archive,
    supersede,
    get,
    getRevision,
    listRevisions,
    listItems,
    backlinks,
    listEvents,
    recordGateJournal,
    search: searchNest,
    suggest,
    decideSuggestion,
    listSuggestions,
    exportTree,
    importTree,
    recordKnowledgeDelivery,
    getKnowledgeDelivery,
    listPublishedRules,
  };
}

export type KnowledgeService = ReturnType<typeof createKnowledgeService>;

// packages/db/src/schema/knowledge.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-1): the knowledge module — one entity for
// everything the company knows, with revisions, a delivery pointer, links,
// sources and suggestions.
//
// The model (architecture doc §3.2, the decision registry: the wiki is
// ours, the plugin is a bridge until the transfer in K-6):
//
//   - `knowledge_items`  — the single entity. `kind` distinguishes note, wiki,
//     answer, task_outcome and rule; a rule is a normal item with
//     `approval_required` and an `approver_kind` (S4: a rule without an
//     approver kind can never be approved — the gate refuses, it does not
//     default).
//   - `knowledge_revisions` — append-only history (S2): an edit is always a
//     new revision, never an UPDATE of an old one. A rollback is one more
//     revision copied from the target plus a pointer move (S5).
//   - `delivered_revision_id` on the item is the delivery pointer: what the
//     fleet reads. Writing a draft never touches it (S3, acceptance criterion
//     "новый черновик не меняет delivered_revision_id").
//   - `knowledge_links` — resolved `[[slug]]` edges. Resolution lives in the
//     database as rows, not as triggers or generated columns: module code has
//     0 triggers and 0 dialect-specific `sql\`` (acceptance criterion).
//   - `knowledge_sources` — every claim carries its provenance (task, PR,
//     run, document, url).
//   - `knowledge_suggestions` — proposals from agents and people waiting for
//     a human decision; a suggestion is never delivered content.
//   - `knowledge_events` — append-only `knowledge.*` audit trail mirrored
//     into company activity (S9).
//
// `nest_id` is the knowledge container; today one nest per company
// (nest_id = company_id), so every query is already nest-scoped and a real
// nest split later is a data change, not a schema change.
//
// Additive migration only: new tables with their indexes, no vendor table is
// touched and nothing existing is altered.

import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** The knowledge kinds of the 2.0 model (§3.2). */
export const KNOWLEDGE_KINDS = ["note", "wiki", "answer", "task_outcome", "rule"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/** Item workflow statuses (§2.4): draft → in_review → published → archived/superseded. */
export const KNOWLEDGE_ITEM_STATUSES = ["draft", "in_review", "published", "archived", "superseded"] as const;
export type KnowledgeItemStatus = (typeof KNOWLEDGE_ITEM_STATUSES)[number];

/** Revision statuses: a revision is drafted, submitted for approval, approved, or rejected. */
export const KNOWLEDGE_REVISION_STATUSES = ["draft", "submitted", "approved", "rejected"] as const;
export type KnowledgeRevisionStatus = (typeof KNOWLEDGE_REVISION_STATUSES)[number];

/** Source kinds a claim may cite. */
export const KNOWLEDGE_SOURCE_KINDS = ["task", "pr", "issue", "run", "document", "decision", "url"] as const;
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number];

export const knowledgeItems = pgTable(
  "knowledge_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Knowledge container. Today one nest per company: nest_id = company_id. */
    nestId: uuid("nest_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").$type<KnowledgeKind>().notNull().default("note"),
    /** Stable page key inside the nest; unique per (nest, slug). */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    status: text("status").$type<KnowledgeItemStatus>().notNull().default("draft"),
    /** Folder path of the tree without the slug segments ("" = nest root). */
    folderPath: text("folder_path").notNull().default(""),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    /**
     * myrmidon(1.6.6 KNOWLEDGE-2.0 K-3): the castes a `kind=rule` item governs,
     * as caste keys; `["*"]` means every caste of the company (the port of the
     * wiki model's `roles`). Empty on every other kind. The rules resolver
     * (`knowledge.rules.resolved(nest, caste)`) reads exactly this column, and
     * `approver_kind` is derived from it (sensitive caste → owner).
     */
    roles: jsonb("roles").$type<string[]>().notNull().default([]),
    /** True for rules (kind "rule" is seeded with this true): publish needs approve. */
    approvalRequired: boolean("approval_required").notNull().default(false),
    /**
     * Which kind of approver the rule needs (caste key, owner's decision
     * K-3/§3.1). Null on an approval-required item means nobody can approve
     * it — `approve` answers 403 (S4).
     */
    approverKind: text("approver_kind"),
    /**
     * The revision the fleet reads. No foreign key on purpose: items and
     * revisions reference each other, and the invariant "the pointer is an
     * approved revision of this item" (S3) is enforced in the module's domain
     * layer, not with a trigger.
     */
    deliveredRevisionId: uuid("delivered_revision_id"),
    /** Number of the newest revision (0 before the first is written). */
    currentRevisionNumber: integer("current_revision_number").notNull().default(0),
    /** Set when this item was replaced by another one (status superseded). */
    supersededByItemId: uuid("superseded_by_item_id"),
    createdByAgentId: text("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nestSlugUq: uniqueIndex("knowledge_items_nest_slug_uq").on(table.nestId, table.slug),
    nestStatusIdx: index("knowledge_items_nest_status_idx").on(table.nestId, table.status),
    nestKindStatusIdx: index("knowledge_items_nest_kind_status_idx").on(table.nestId, table.kind, table.status),
    rolesIdx: index("knowledge_items_roles_idx").using("gin", table.roles),
    nestFolderIdx: index("knowledge_items_nest_folder_idx").on(table.nestId, table.folderPath),
    companyIdx: index("knowledge_items_company_idx").on(table.companyId),
  }),
);

export const knowledgeRevisions = pgTable(
  "knowledge_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    nestId: uuid("nest_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: "cascade" }),
    /** 1-based, strictly increasing within the item (S2). */
    revisionNumber: integer("revision_number").notNull(),
    status: text("status").$type<KnowledgeRevisionStatus>().notNull().default("draft"),
    content: text("content").notNull(),
    /** What changed, free text — shown in the revision diff (K-4 UI). */
    changeSummary: text("change_summary"),
    /** True when this revision was produced by a rollback copy (S5). */
    rolledBackFromRevisionId: uuid("rolled_back_from_revision_id"),
    /** The approvals-pipeline card this approval came through, when any. */
    approvalId: uuid("approval_id"),
    approvedByKind: text("approved_by_kind"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdByAgentId: text("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    itemRevisionUq: uniqueIndex("knowledge_revisions_item_revision_uq").on(table.itemId, table.revisionNumber),
    nestIdx: index("knowledge_revisions_nest_idx").on(table.nestId),
    companyIdx: index("knowledge_revisions_company_idx").on(table.companyId),
  }),
);

export const knowledgeLinks = pgTable(
  "knowledge_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    nestId: uuid("nest_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: "cascade" }),
    /** The slug as written in `[[...]]`, kept verbatim for backfill. */
    targetSlug: text("target_slug").notNull(),
    /** Null while the target does not exist yet; a resolve pass repairs it. */
    resolvedItemId: uuid("resolved_item_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceTargetUq: uniqueIndex("knowledge_links_source_target_uq").on(table.sourceItemId, table.targetSlug),
    nestTargetIdx: index("knowledge_links_nest_target_idx").on(table.nestId, table.resolvedItemId),
    companyIdx: index("knowledge_links_company_idx").on(table.companyId),
  }),
);

export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    nestId: uuid("nest_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => knowledgeRevisions.id, { onDelete: "cascade" }),
    kind: text("kind").$type<KnowledgeSourceKind>().notNull(),
    /** Stable reference: issue id / PR url / run id / document id / url. */
    ref: text("ref").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    revisionSourceUq: uniqueIndex("knowledge_sources_revision_source_uq").on(
      table.revisionId,
      table.kind,
      table.ref,
    ),
    nestIdx: index("knowledge_sources_nest_idx").on(table.nestId),
    companyIdx: index("knowledge_sources_company_idx").on(table.companyId),
  }),
);

export const KNOWLEDGE_SUGGESTION_STATUSES = ["pending", "accepted", "declined"] as const;
export type KnowledgeSuggestionStatus = (typeof KNOWLEDGE_SUGGESTION_STATUSES)[number];

export const knowledgeSuggestions = pgTable(
  "knowledge_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    nestId: uuid("nest_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Null when the suggestion proposes a brand-new page. */
    targetItemId: uuid("target_item_id"),
    body: text("body").notNull(),
    rationale: text("rationale"),
    sourceKind: text("source_kind").$type<KnowledgeSourceKind>(),
    sourceRef: text("source_ref"),
    status: text("status").$type<KnowledgeSuggestionStatus>().notNull().default("pending"),
    createdByAgentId: text("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nestStatusIdx: index("knowledge_suggestions_nest_status_idx").on(table.nestId, table.status),
    companyIdx: index("knowledge_suggestions_company_idx").on(table.companyId),
  }),
);

export const knowledgeEvents = pgTable(
  "knowledge_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    nestId: uuid("nest_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").references(() => knowledgeItems.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id"),
    /** Dot-separated event name: knowledge.created, knowledge.approved, ... */
    event: text("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    actorType: text("actor_type").notNull().default("system"),
    actorId: text("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nestCreatedIdx: index("knowledge_events_nest_created_idx").on(table.nestId, table.createdAt),
    itemCreatedIdx: index("knowledge_events_item_created_idx").on(table.itemId, table.createdAt),
    companyIdx: index("knowledge_events_company_idx").on(table.companyId),
  }),
);

/**
 * myrmidon(1.6.6 KNOWLEDGE-2.0 K-1): the delivery read model for full-text
 * search. `knowledge_search` mirrors the DELIVERED revision of each item —
 * the row exists only while the item is delivered, which keeps the state
 * machine in the module and the text matching in pg. `search_vector` is a
 * stored generated column (unaccent + to_tsvector over title/summary/body);
 * `body_trgm` carries the pg_trgm GIN for `%` similarity; `slug_trgm` powers
 * fuzzy slug completion. The module NEVER reads or writes this table with
 * dialect SQL: it is reached only through the `SearchIndex` port, whose pg
 * implementation lives in `packages/db/src/knowledge-search.ts`.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const knowledgeSearch = pgTable(
  "knowledge_search",
  (table) => ({
    itemId: uuid("item_id").primaryKey().references(() => knowledgeItems.id, { onDelete: "cascade" }),
    nestId: uuid("nest_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    body: text("body").notNull().default(""),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('simple'::regconfig, knowledge_unaccent(coalesce("title", '') || ' ' || coalesce("summary", '') || ' ' || coalesce("body", '')))`,
    ),
    bodyTrgm: text("body_trgm")
      .notNull()
      .generatedAlwaysAs(sql`lower(coalesce("body", '') || ' ' || coalesce("title", ''))`),
  }),
  (table) => ({
    vectorIdx: index("knowledge_search_vector_idx").using("gin", table.searchVector),
    trgmIdx: index("knowledge_search_trgm_idx").using("gin", table.bodyTrgm.op("gin_trgm_ops")),
    slugTrgmIdx: index("knowledge_search_slug_trgm_idx").using("gin", table.slug.op("gin_trgm_ops")),
    nestIdx: index("knowledge_search_nest_idx").on(table.nestId),
  }),
);

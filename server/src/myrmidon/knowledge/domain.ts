// server/src/myrmidon/knowledge/domain.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-1): the pure part of the knowledge module.
//
// One entity for everything the company knows (note / wiki / answer /
// task_outcome / rule), its append-only revisions, the delivery pointer, the
// `[[...]]` link graph, sources and suggestions. This file has no database,
// no Express and no ORM types: the state machine (§2.4), the invariants (§3.2)
// and the canonical markdown-tree serialization live here as plain
// functions, and the store-bound service sits on top of them.
//
// The invariants the acceptance criteria name:
//   - a new draft never moves `deliveredRevisionId` (S3);
//   - an approval-required item without `approverKind` cannot be approved —
//     the gate answers 403, it never defaults to "anyone may" (S4);
//   - a rollback writes ONE MORE revision (a copy of the target) and moves
//     the pointer onto it — history stays append-only (S5);
//   - export → import → export is byte-for-byte identical (the tree format
//     below is canonical: fixed key order, content length-prefixed).
//
// Full-text search is a PORT (`SearchIndex`), never SQL in this module: the
// pg-backed index (tsvector + pg_trgm + unaccent) is attached by the wiring
// layer, so the module code keeps the "0 dialect-specific sql\` strings"
// guarantee.

/** The knowledge kinds (§3.2). */
export const KNOWLEDGE_KINDS = ["note", "wiki", "answer", "task_outcome", "rule"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/** Item workflow statuses (§2.4). */
export const KNOWLEDGE_ITEM_STATUSES = ["draft", "in_review", "published", "archived", "superseded"] as const;
export type KnowledgeItemStatus = (typeof KNOWLEDGE_ITEM_STATUSES)[number];

/** Revision statuses: written, submitted for approval, approved, rejected. */
export const KNOWLEDGE_REVISION_STATUSES = ["draft", "submitted", "approved", "rejected"] as const;
export type KnowledgeRevisionStatus = (typeof KNOWLEDGE_REVISION_STATUSES)[number];

export const KNOWLEDGE_SOURCE_KINDS = ["task", "pr", "issue", "run", "document", "decision", "url"] as const;
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number];

export const KNOWLEDGE_SUGGESTION_STATUSES = ["pending", "accepted", "declined"] as const;
export type KnowledgeSuggestionStatus = (typeof KNOWLEDGE_SUGGESTION_STATUSES)[number];

/** Actor kinds an event / approval can carry. */
export const KNOWLEDGE_ACTOR_TYPES = ["agent", "user", "system"] as const;
export type KnowledgeActorType = (typeof KNOWLEDGE_ACTOR_TYPES)[number];

/**
 * The §2.4 state machine as an edge list. Anything not listed here is a
 * refusal, never a silent transition. `superseded` is terminal; an archived
 * item can be republished (a restore) or superseded.
 */
export const KNOWLEDGE_ITEM_TRANSITIONS: Readonly<Record<KnowledgeItemStatus, readonly KnowledgeItemStatus[]>> = {
  draft: ["in_review", "published", "archived"],
  in_review: ["published", "draft", "archived"],
  published: ["archived", "superseded"],
  archived: ["draft", "in_review", "published", "superseded"],
  superseded: [],
};

export function isKnowledgeKind(value: unknown): value is KnowledgeKind {
  return typeof value === "string" && (KNOWLEDGE_KINDS as readonly string[]).includes(value);
}

export function isKnowledgeItemStatus(value: unknown): value is KnowledgeItemStatus {
  return typeof value === "string" && (KNOWLEDGE_ITEM_STATUSES as readonly string[]).includes(value);
}

export function isKnowledgeRevisionStatus(value: unknown): value is KnowledgeRevisionStatus {
  return typeof value === "string" && (KNOWLEDGE_REVISION_STATUSES as readonly string[]).includes(value);
}

/** Thrown for any domain refusal. `status` maps straight onto the HTTP code. */
export class KnowledgeDomainError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "KnowledgeDomainError";
    this.code = code;
    this.status = status;
  }
}

/** Slug grammar: lowercase segments of letters/digits/dash/underscore, `/`-joined. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;

export function assertValidSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new KnowledgeDomainError(
      "invalid_slug",
      400,
      `Slug "${slug}" must be slash-separated lowercase segments of [a-z0-9_-], starting with a letter or digit.`,
    );
  }
}

/**
 * A single-line metadata field: titles, summaries and tags must survive the
 * canonical tree format (one `key: value` line each) and must never contain
 * a newline or a `--- item ---`-like line.
 */
export function assertSingleLine(value: string, label: string): void {
  if (value.length === 0) {
    throw new KnowledgeDomainError("invalid_metadata", 400, `${label} must not be empty.`);
  }
  if (/[\r\n]/.test(value)) {
    throw new KnowledgeDomainError("invalid_metadata", 400, `${label} must be a single line.`);
  }
}

export function assertValidTags(tags: readonly string[]): void {
  for (const tag of tags) {
    if (tag.length === 0 || /[,;\r\n]/.test(tag)) {
      throw new KnowledgeDomainError("invalid_metadata", 400, `Tag "${tag}" must be non-empty and comma-free.`);
    }
  }
}

/**
 * `[[...]]` link syntax: `[[slug]]`, `[[slug|alias]]`, `[[slug#anchor]]`.
 * A target is invalid if empty or contains a nested bracket.
 */
const LINK_RE = /\[\[([^\[\]\n]+)\]\]/g;

/** Extracts the normalized link targets (alias and anchor stripped) from markdown. */
export function extractLinkTargets(content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(LINK_RE)) {
    const normalized = normalizeLinkTarget(match[1]!);
    if (normalized !== null && !found.includes(normalized)) found.push(normalized);
  }
  return found;
}

/** Strips `|alias` and `#anchor`, trims; null for an empty target. */
export function normalizeLinkTarget(raw: string): string | null {
  const withoutAlias = raw.split("|")[0]!;
  const withoutAnchor = withoutAlias.split("#")[0]!;
  const trimmed = withoutAnchor.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** True when `to` is a legal next status of `from` (§2.4). */
export function canTransitionItem(from: KnowledgeItemStatus, to: KnowledgeItemStatus): boolean {
  return KNOWLEDGE_ITEM_TRANSITIONS[from].includes(to);
}

export function assertItemTransition(from: KnowledgeItemStatus, to: KnowledgeItemStatus): void {
  if (!canTransitionItem(from, to)) {
    throw new KnowledgeDomainError("invalid_status_transition", 409, `Knowledge item cannot move from "${from}" to "${to}".`);
  }
}

/** Revision lifecycle: draft → submitted → approved|rejected; draft → rejected. */
export function assertRevisionTransition(from: KnowledgeRevisionStatus, to: KnowledgeRevisionStatus): void {
  const allowed: Record<KnowledgeRevisionStatus, readonly KnowledgeRevisionStatus[]> = {
    draft: ["submitted", "rejected", "approved"],
    submitted: ["approved", "rejected", "draft"],
    approved: [],
    rejected: ["draft"],
  };
  if (!allowed[from].includes(to)) {
    throw new KnowledgeDomainError("invalid_revision_transition", 409, `Revision cannot move from "${from}" to "${to}".`);
  }
}

/** The item facts the approval gate reads. */
export interface KnowledgeApprovalGateItem {
  kind: KnowledgeKind;
  approvalRequired: boolean;
  approverKind: string | null;
}

/** The actor asking to approve. */
export interface KnowledgeApprover {
  actorType: KnowledgeActorType;
  actorId: string | null;
  /** The role/caste/authority kind the actor presents; compared with approverKind. */
  kind: string | null;
}

/**
 * S4, the approval gate, pure:
 *   - an approval-required item without `approverKind` can never be approved
 *     (403 — the acceptance criterion "approve rules без approver_kind → 403");
 *   - an approver must present the kind the item asks for (403 otherwise),
 *     so "SMM operator approves the owner's rule" is refused by the code;
 *   - items that do not require approval (a plain note in an auto section)
 *     approve on any identified actor.
 */
export function assertApprovable(item: KnowledgeApprovalGateItem, approver: KnowledgeApprover): void {
  if (!item.approvalRequired) return;
  if (!item.approverKind) {
    throw new KnowledgeDomainError(
      "rule_requires_approver_kind",
      403,
      `This item requires approval but has no approver_kind; it cannot be approved until one is set.`,
    );
  }
  if (approver.kind !== item.approverKind) {
    throw new KnowledgeDomainError(
      "approver_kind_mismatch",
      403,
      `Approval requires kind "${item.approverKind}", the approver presents "${approver.kind ?? "none"}".`,
    );
  }
}

/** A rule (kind "rule") always requires approval and an approver kind (S4). */
export function assertRuleFields(kind: KnowledgeKind, approvalRequired: boolean, approverKind: string | null): void {
  if (kind !== "rule") return;
  if (!approvalRequired) {
    throw new KnowledgeDomainError("rule_requires_approval", 400, "A rule must require approval.");
  }
  if (!approverKind) {
    throw new KnowledgeDomainError("rule_requires_approver_kind", 400, "A rule must name an approver_kind up front.");
  }
}

/** The facts a rollback needs: the item pointer fields and the target revision. */
export interface KnowledgeRollbackInput {
  deliveredRevisionId: string | null;
  currentRevisionNumber: number;
}

/**
 * S5, the rollback rule, pure: a rollback is NOT a pointer move backwards —
 * it writes one more revision (number = current + 1) copied from the target
 * revision, and the pointer moves onto that new revision. History stays
 * append-only and the rollback itself is undoable (one more rollback).
 */
export function planRollback(
  item: KnowledgeRollbackInput,
  target: { revisionId: string; revisionNumber: number; status: KnowledgeRevisionStatus },
): { newRevisionNumber: number; rolledBackFromRevisionId: string } {
  if (!target.revisionId) {
    throw new KnowledgeDomainError("rollback_no_target", 400, "Rollback needs a target revision.");
  }
  if (target.status !== "approved") {
    throw new KnowledgeDomainError("rollback_target_not_approved", 409, "A rollback target must be an approved revision.");
  }
  if (item.deliveredRevisionId === target.revisionId) {
    throw new KnowledgeDomainError("rollback_noop", 409, "The rollback target is already the delivered revision.");
  }
  return {
    newRevisionNumber: item.currentRevisionNumber + 1,
    rolledBackFromRevisionId: target.revisionId,
  };
}

/**
 * S3, the draft rule, pure: writing a draft revision returns the pointer
 * fields UNCHANGED. The store has no other path that touches
 * `deliveredRevisionId` — publish and rollback do, this one refuses to.
 */
export function draftPointerFields(): { deliveredRevisionId?: undefined } {
  return {};
}

/** One page of the canonical markdown tree. */
export interface KnowledgeTreePage {
  slug: string;
  kind: KnowledgeKind;
  title: string;
  summary: string | null;
  /** Folder path without the slug segment ("" = nest root). */
  folder: string;
  tags: string[];
  status: KnowledgeItemStatus;
  approvalRequired: boolean;
  approverKind: string | null;
  content: string;
}

export interface KnowledgeTreeDoc {
  nestId: string;
  pages: KnowledgeTreePage[];
}

const TREE_MAGIC = "=== myrmidon knowledge tree v1 ===";
const PAGE_HEADER = "--- item ---";
const PAGE_META_END = "---";

/**
 * The canonical export format. Determinism rules: pages sorted by slug,
 * fixed key order, boolean as "true"/"false", empty optional as empty value,
 * content length-prefixed in bytes so it may contain ANY bytes (even a line
 * that looks like a header) without breaking the roundtrip.
 */
export function serializeKnowledgeTree(doc: KnowledgeTreeDoc): Buffer {
  const pages = [...doc.pages].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const chunks: Buffer[] = [];
  chunks.push(Buffer.from(`${TREE_MAGIC}\nnest_id: ${doc.nestId}\n`, "utf8"));
  for (const page of pages) {
    assertValidSlug(page.slug);
    assertSingleLine(page.title, "Title");
    if (page.summary !== null) assertSingleLine(page.summary, "Summary");
    assertValidTags(page.tags);
    const meta = [
      PAGE_HEADER,
      `slug: ${page.slug}`,
      `kind: ${page.kind}`,
      `title: ${page.title}`,
      `summary: ${page.summary ?? ""}`,
      `folder: ${page.folder}`,
      `tags: ${page.tags.join(",")}`,
      `status: ${page.status}`,
      `approval_required: ${page.approvalRequired ? "true" : "false"}`,
      `approver_kind: ${page.approverKind ?? ""}`,
      `content_bytes: ${Buffer.byteLength(page.content, "utf8")}`,
      PAGE_META_END,
    ].join("\n");
    chunks.push(Buffer.from(`\n${meta}\n`, "utf8"));
    chunks.push(Buffer.from(page.content, "utf8"));
  }
  return Buffer.concat(chunks);
}

/** Parses what `serializeKnowledgeTree` wrote. Strict: any drift is an error. */
export function parseKnowledgeTree(buf: Buffer): KnowledgeTreeDoc {
  const magic = `${TREE_MAGIC}\n`;
  if (!buf.subarray(0, Buffer.byteLength(magic, "utf8")).equals(Buffer.from(magic, "utf8"))) {
    throw new KnowledgeDomainError("invalid_tree", 400, "Not a knowledge tree export (bad magic).");
  }
  let offset = Buffer.byteLength(magic, "utf8");
  const nestLineEnd = buf.indexOf(0x0a, offset); // \n
  const nestLine = buf.subarray(offset, nestLineEnd).toString("utf8");
  if (!nestLine.startsWith("nest_id: ")) {
    throw new KnowledgeDomainError("invalid_tree", 400, "Knowledge tree header has no nest_id line.");
  }
  const nestId = nestLine.slice("nest_id: ".length);
  offset = nestLineEnd + 1;

  const pages: KnowledgeTreePage[] = [];
  while (offset < buf.length) {
    const header = `\n${PAGE_HEADER}\n`;
    const headerBytes = Buffer.from(header, "utf8");
    if (!buf.subarray(offset, offset + headerBytes.length).equals(headerBytes)) {
      throw new KnowledgeDomainError("invalid_tree", 400, "Expected a page separator at byte offset " + offset + ".");
    }
    offset += headerBytes.length;

    const meta: Record<string, string> = {};
    let contentBytes = -1;
    for (;;) {
      const lineEnd = buf.indexOf(0x0a, offset);
      if (lineEnd === -1) throw new KnowledgeDomainError("invalid_tree", 400, "Truncated page metadata.");
      const line = buf.subarray(offset, lineEnd).toString("utf8");
      offset = lineEnd + 1;
      if (line === PAGE_META_END) break;
      const colon = line.indexOf(": ");
      if (colon === -1) throw new KnowledgeDomainError("invalid_tree", 400, `Bad metadata line "${line}".`);
      const key = line.slice(0, colon);
      const value = line.slice(colon + 2);
      if (key === "content_bytes") contentBytes = Number.parseInt(value, 10);
      else meta[key] = value;
    }
    if (!Number.isInteger(contentBytes) || contentBytes < 0 || offset + contentBytes > buf.length) {
      throw new KnowledgeDomainError("invalid_tree", 400, "Bad or truncated content_bytes in page.");
    }
    const content = buf.subarray(offset, offset + contentBytes).toString("utf8");
    offset += contentBytes;

    if (!isKnowledgeKind(meta.kind)) {
      throw new KnowledgeDomainError("invalid_tree", 400, `Unknown kind "${meta.kind}" for page ${meta.slug}.`);
    }
    if (!isKnowledgeItemStatus(meta.status)) {
      throw new KnowledgeDomainError("invalid_tree", 400, `Unknown status "${meta.status}" for page ${meta.slug}.`);
    }
    pages.push({
      slug: meta.slug ?? "",
      kind: meta.kind,
      title: meta.title ?? "",
      summary: meta.summary ? meta.summary : null,
      folder: meta.folder ?? "",
      tags: meta.tags && meta.tags.length > 0 ? meta.tags.split(",") : [],
      status: meta.status,
      approvalRequired: meta.approval_required === "true",
      approverKind: meta.approver_kind ? meta.approver_kind : null,
      content,
    });
  }

  return { nestId, pages };
}

/**
 * The search port. The module never spells dialect SQL: the pg-backed
 * implementation (tsvector + pg_trgm + unaccent) is attached in wiring, and
 * this in-memory fallback keeps the domain honest and testable.
 */
export interface SearchIndex {
  upsert(page: { itemId: string; nestId: string; slug: string; title: string; summary: string | null; content: string }): Promise<void>;
  remove(itemId: string): Promise<void>;
  search(nestId: string, query: string, limit: number): Promise<Array<{ itemId: string; slug: string; title: string }>>;
}

/** Naive ranked in-memory index: whole-word matches on title (×3) and body. */
export function createMemorySearchIndex(): SearchIndex & { clear(): void } {
  const docs = new Map<string, { itemId: string; slug: string; title: string; haystack: string }>();
  return {
    async upsert(page) {
      docs.set(page.itemId, {
        itemId: page.itemId,
        slug: page.slug,
        title: page.title,
        haystack: `${page.title}\n${page.summary ?? ""}\n${page.content}`.toLowerCase(),
      });
    },
    async remove(itemId) {
      docs.delete(itemId);
    },
    async search(_nestId, query, limit) {
      const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
      const scored: Array<{ score: number; itemId: string; slug: string; title: string }> = [];
      for (const doc of docs.values()) {
        let score = 0;
        for (const term of terms) {
          if (doc.title.toLowerCase().includes(term)) score += 3;
          if (doc.haystack.includes(term)) score += 1;
        }
        if (score > 0) scored.push({ score, itemId: doc.itemId, slug: doc.slug, title: doc.title });
      }
      scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
      return scored.slice(0, limit).map(({ itemId, slug, title }) => ({ itemId, slug, title }));
    },
    clear() {
      docs.clear();
    },
  };
}

/**
 * myrmidon(1.6.6 KNOWLEDGE-2.0 K-3, §3.1 `rules` / §6 K-3): the one carrier of
 * rules. A rule is a `kind=rule` item of the knowledge module — never a second
 * table — and the castes it governs live in its `roles`. Everything a rule
 * needs from a caste (who must approve it) is *derived here, in code*, from the
 * caste directory: nobody types `approver_kind` by hand.
 *
 * The owner's matrix (29.09, DECISIONS): "Регламенты (Draft → Approved)
 * одобряются по кастам: разработка — оператор доски (ADM), площадки и SMM —
 * Alex." A sensitive caste (SMM, the platforms) is Alex's; every other caste's
 * rules are the board operator's. Expected crisis: `approve правила SMM
 * оператором → 403, владельцем → ok`.
 */
import { RULE_ROLE_ANY, approverKindSatisfies, type KnowledgeApprover } from "./domain.js";
import type { KnowledgeItemDto, KnowledgeRevisionDto } from "./store.js";

/** The two human grades a rule can ask for (see APPROVER_KIND_RANK). */
export const RULE_APPROVER_OWNER = "owner";
export const RULE_APPROVER_OPERATOR = "operator";
export type RuleApproverKind = typeof RULE_APPROVER_OWNER | typeof RULE_APPROVER_OPERATOR;

/** The slice of the caste directory this module needs. */
export interface CasteSensitivity {
  /** Caste keys marked sensitive in the directory (owner-approved rules). */
  sensitive: ReadonlySet<string>;
}

/**
 * `approver_kind` of a rule, derived from its roles and the directory:
 * a rule that governs *any* sensitive caste is the owner's, every other rule
 * is the board operator's. `["*"]` (every caste) is the operator's: it names no
 * sensitive caste, and the operator is the company-wide authority for rules the
 * company writes for itself. Empty roles never reach here —
 * `assertValidRoles`/the store reject a rule without roles.
 */
export function ruleApproverKind(roles: readonly string[], castes: CasteSensitivity): RuleApproverKind {
  for (const role of roles) {
    if (role === RULE_ROLE_ANY) continue;
    if (castes.sensitive.has(role)) return RULE_APPROVER_OWNER;
  }
  return RULE_APPROVER_OPERATOR;
}

/** True when the rule's stored `approver_kind` is the one the code derives. */
export function isRuleApproverKindDerivable(roles: readonly string[], approverKind: string | null, castes: CasteSensitivity): boolean {
  return approverKind === ruleApproverKind(roles, castes);
}

/** The castes a rule governs, wildcard expanded to the company's castes. */
export function rolesMatchCaste(roles: readonly string[], caste: string): boolean {
  return roles.includes(caste) || roles.includes(RULE_ROLE_ANY);
}

/** What the fleet reads for one caste: the approved revision of each rule. */
export interface ResolvedRule {
  /** The knowledge item the text came from (`wikiPageId` of the old carrier). */
  pageId: string;
  slug: string;
  title: string;
  /** The castes the rule governs, as recorded on the item. */
  roles: string[];
  revisionNumber: number;
  /** Provenance of the delivered revision, in the order it was recorded. */
  sources: Array<{ kind: string; ref: string; note: string | null }>;
  content: string;
}

/**
 * The read half of the knowledge module (one nest), so the resolver is testable
 * without a database and delivery never grows a second query of its own.
 */
export interface RulesReadPort {
  listItems(filter?: { status?: string; kind?: string }): Promise<KnowledgeItemDto[]>;
  listRevisions(idOrSlug: string): Promise<KnowledgeRevisionDto[]>;
}

/** The §3.1 resolver the delivery path asks: `knowledge.rules.resolved(nest, caste)`. */
export async function resolvedRules(read: RulesReadPort, caste: string): Promise<ResolvedRule[]> {
  const items = await read.listItems({ kind: "rule", status: "published" });
  const mine = items.filter((item) => rolesMatchCaste(item.roles, caste));
  const resolved: ResolvedRule[] = [];
  for (const item of mine) {
    const delivered = await deliveredRevision(read, item);
    if (delivered === null) continue; // published without a delivered revision: nothing to read
    resolved.push({
      pageId: item.id,
      slug: item.slug,
      title: item.title,
      roles: item.roles ?? [],
      revisionNumber: delivered.revisionNumber,
      sources: delivered.sources.map((source) => ({ kind: source.kind, ref: source.ref, note: source.note ?? null })),
      content: delivered.content,
    });
  }
  return resolved;
}

/** The revision the pointer names, or null when the item delivers nothing. */
async function deliveredRevision(read: RulesReadPort, item: KnowledgeItemDto): Promise<KnowledgeRevisionDto | null> {
  if (!item.deliveredRevisionId) return null;
  const revisions = await read.listRevisions(item.id);
  return revisions.find((revision) => revision.id === item.deliveredRevisionId) ?? null;
}

/**
 * May `approver` approve a rule that asks for `approverKind`? The gate is the
 * same one the store applies (S4) — exported so an API/UI layer can answer
 * "who must approve this" without restating the grades.
 */
export function canApproveRule(approverKind: string | null, approver: KnowledgeApprover): boolean {
  return approverKindSatisfies(approverKind, approver.kind);
}
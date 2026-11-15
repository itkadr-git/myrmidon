// Stack registry (SUA, STACK-UPDATES-B): draft backlog decisions.
//
// Pure step 1 of OPE-12066: from a checked stack document return one backlog
// draft per component that needs a follow-up task — upstream lag at or above
// the configured threshold, or a critical security note — except components
// that already carry an open task (deduplication is injected by the caller).
// The title/summary borrow the attention card so the draft and the "needs me"
// feed stay consistent; a security-only component (no lag) has no attention
// card, so its title/summary are composed here in the same shape.
// No I/O: the caller (step 2 in check.ts) supplies the open-component list and
// persists the drafts as `todo` issues.

import { buildStackAttentionCards, type StackAttentionCard } from "./attention.js";
import type { StackDocument } from "./domain.js";

export interface StackBacklogDraft {
  /** Component name from the stack document; the dedup key on the task side. */
  component: string;
  title: string;
  summary: string;
}

export interface ExistingStackTask {
  title: string;
  originId: string | null;
}

export interface StackBacklogDraftOptions {
  /** Minimum upstream lag in releases; defaults to 2. */
  lagThreshold?: number;
  /** Components that already have an open task — skipped (deduplication). */
  openComponents?: readonly string[];
  /** Existing stack-update task identities, including closed tasks, for release deduplication. */
  existingDrafts?: readonly ExistingStackTask[];
}

/** Default upstream lag (in releases) that warrants a backlog draft. */
export const STACK_BACKLOG_LAG_DEFAULT = 2;

function summaryFor(card: StackAttentionCard | undefined, whyNow: string): string {
  const excerpt = card?.summaryExcerpt;
  return excerpt ? `${whyNow} ${excerpt}` : whyNow;
}

/**
 * Decide the backlog drafts for one cached stack document, ordered by
 * component name (the same order as the attention cards).
 */
export function decideStackBacklogDrafts(
  doc: StackDocument,
  options: StackBacklogDraftOptions = {},
): StackBacklogDraft[] {
  const lagThreshold = options.lagThreshold ?? STACK_BACKLOG_LAG_DEFAULT;
  // Dedup keys cover open AND closed tasks of the same release: a task the
  // team already reviewed and closed (done/cancelled) must not reappear on
  // the next sweep just because it left the "open" query.
  const knownTitles = new Set(
    (options.existingDrafts ?? []).map((existing) => existing.title.toLowerCase()),
  );
  const knownOrigins = new Set(
    (options.existingDrafts ?? []).map((existing) => existing.originId).filter((v): v is string => Boolean(v)),
  );
  const openComponentSet = new Set(options.openComponents ?? []);
  const cards = new Map(buildStackAttentionCards(doc).map((card) => [card.component, card]));
  const drafts: StackBacklogDraft[] = [];
  for (const component of doc.components) {
    if (openComponentSet.has(component.name)) continue;
    const upstream = component.upstreamState;
    if (!upstream || !upstream.latest) continue;
    const behindBy = upstream.behindBy ?? null;
    const lagging = behindBy != null && behindBy >= lagThreshold;
    const hasSecurity = upstream.notes?.hasSecurity === true;
    if (!lagging && !hasSecurity) continue;
    const card = cards.get(component.name);
    const ourVersion = component.local.version ?? component.local.commit;
    const whyNow = lagging
      ? `Upstream release ${upstream.latest} is ${behindBy} release(s) ahead of the running version (${ourVersion ?? "unknown"}).`
      : `Upstream release ${upstream.latest} carries a security note; our version is ${ourVersion ?? "unknown"}.`;
    const title = card?.title ?? `${component.name} ${upstream.latest}`;
    if (knownTitles.has(title.toLowerCase())) continue;
    if (knownOrigins.has(`${component.name}:${upstream.latest}`)) continue;
    drafts.push({
      component: component.name,
      title,
      summary: summaryFor(card, whyNow),
    });
  }
  return drafts.sort((left, right) => left.component.localeCompare(right.component));
}

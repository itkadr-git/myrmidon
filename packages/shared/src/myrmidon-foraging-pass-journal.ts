/**
 * Foraging pass journal (myrmidon 1.6.3 FORAGING-IDLE-GATE, UI half).
 *
 * The idle gate decides per role whether a pass may read that role's sources
 * (see `myrmidon-foraging-idle-gate.ts`). A skipped role is invisible after
 * the fact: the counters of the pass say nothing about WHY a source was left
 * alone. The pass journal keeps the last passes of a company so the
 * "Foraging" page can show, pass by pass, what ran and what was skipped and
 * with which reason.
 *
 * It follows the journal convention of 1.6.1 SWARM-SETTINGS-UI: the entries
 * live under their own `instance_settings.general` key, newest first, capped;
 * the service re-reads them defensively, so a hand-edited row loses the
 * journal and nothing else. The journal is a read-only view — the audit trail
 * of a pass stays in the activity log.
 */

/** Why a pass left a role's sources alone; kept in sync with domain.ts. */
export type ForagingSkipReason = "queue_not_empty" | "no_idle_agent";

/** Stored-settings key of the pass journal inside `general`. */
export const FORAGING_PASS_JOURNAL_KEY = "foragingPassJournal";

/** Entries kept PER COMPANY; older passes of that company fall off the end. */
export const FORAGING_PASS_JOURNAL_LIMIT = 50;

/** Roles a pass left alone, and why. */
export interface ForagingPassSkip {
  role: string;
  reason: ForagingSkipReason;
}

/** One pass of one company: what it read and what it skipped. */
export interface ForagingPassJournalEntry {
  /** When the pass finished, ISO-8601. */
  at: string;
  /** The company the pass belongs to; the journal is instance-wide. */
  companyId: string;
  sourcesRead: number;
  findings: number;
  candidates: number;
  errors: number;
  stoppedByBudget: boolean;
  /** The first reason a role was skipped, or null when the pass skipped none. */
  skippedReason: ForagingSkipReason | null;
  /** Every skipped role of the pass, in the order the pass walked the sources. */
  skipped: ForagingPassSkip[];
}

const SKIP_REASONS: readonly string[] = ["queue_not_empty", "no_idle_agent"];

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readSkipped(value: unknown): ForagingPassSkip[] {
  if (!Array.isArray(value)) return [];
  const skipped: ForagingPassSkip[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const role = (item as { role?: unknown }).role;
    const reason = (item as { reason?: unknown }).reason;
    if (typeof role !== "string" || role.length === 0) continue;
    if (typeof reason !== "string" || !SKIP_REASONS.includes(reason)) continue;
    if (skipped.some((entry) => entry.role === role)) continue;
    skipped.push({ role, reason: reason as ForagingSkipReason });
  }
  return skipped;
}

/**
 * Reads the journal back from its stored value. Anything unreadable is
 * dropped entry by entry, so a truncated row costs one entry, not the view.
 * `companyId` filters the instance-wide list to one company's passes.
 */
export function readForagingPassJournal(
  stored: unknown,
  options: { companyId?: string; limit?: number } = {},
): ForagingPassJournalEntry[] {
  if (!Array.isArray(stored)) return [];
  const limit = options.limit ?? FORAGING_PASS_JOURNAL_LIMIT;
  const entries: ForagingPassJournalEntry[] = [];
  for (const raw of stored) {
    if (typeof raw !== "object" || raw === null) continue;
    const candidate = raw as Record<string, unknown>;
    const at = candidate.at;
    const companyId = candidate.companyId;
    if (typeof at !== "string" || at.length === 0) continue;
    if (typeof companyId !== "string" || companyId.length === 0) continue;
    if (options.companyId && companyId !== options.companyId) continue;
    const skipped = readSkipped(candidate.skipped);
    const rawReason = candidate.skippedReason;
    const skippedReason =
      typeof rawReason === "string" && SKIP_REASONS.includes(rawReason)
        ? (rawReason as ForagingSkipReason)
        : (skipped[0]?.reason ?? null);
    entries.push({
      at,
      companyId,
      sourcesRead: readNumber(candidate.sourcesRead),
      findings: readNumber(candidate.findings),
      candidates: readNumber(candidate.candidates),
      errors: readNumber(candidate.errors),
      stoppedByBudget: candidate.stoppedByBudget === true,
      skippedReason,
      skipped,
    });
    if (entries.length >= limit) break;
  }
  return entries;
}

/**
 * Puts one pass at the head of the journal and drops the tail beyond the cap
 * OF THAT COMPANY. The cap is per company on purpose: the stored list is
 * instance-wide, and an instance-wide cap would let the busiest company eat
 * the whole row — recording a pass of one company must never forget the
 * history of another. The new entry counts against its own company's cap, so
 * one company keeps `limit` passes, not `limit + 1`.
 */
export function appendForagingPassJournal(
  stored: unknown,
  entry: ForagingPassJournalEntry,
  limit = FORAGING_PASS_JOURNAL_LIMIT,
): ForagingPassJournalEntry[] {
  const cap = Math.max(1, limit);
  const all = readForagingPassJournal(stored, { limit: Number.MAX_SAFE_INTEGER });
  const kept: ForagingPassJournalEntry[] = [];
  let mine = 1;
  for (const item of all) {
    if (item.companyId === entry.companyId) {
      if (mine >= cap) continue;
      mine += 1;
    }
    kept.push(item);
  }
  return [entry, ...kept];
}
// server/src/myrmidon/prompt-budget/signal.ts
//
// myrmidon(1.6.5 PROMPT-BUDGET-SIGNAL): the recorded prompt-budget signal.
//
// The signal is not a comment. The 1.6.3 part wrote a system notice into the
// agent's most recent in_progress task and deduped it through the comment
// metadata — a port that dropped the metadata, so the check never matched and
// the notice repeated on every sweep (17 copies in two hours on the live
// board) while queueing as new messages for the very agent whose prompt was
// over budget. The signal is now a record the attention feed renders: one per
// agent per UTC day, the dedup key `prompt-budget:<agentId>:<utc day>` stored
// and found in the registry below, which the feed reads on every list. No
// comment is written into any task.
//
// The registry is per company, like the model-fallback signal the feed reads
// the same way: the sweep refreshes it on the heartbeat tick, an agent back
// under the threshold loses its record, and the card is the only surface the
// owner and the operator see.

import { promptBudgetSignalKey } from "@paperclipai/shared";
import type { PromptBudgetAttentionCard } from "./attention.js";

/** One recorded signal: the card plus the day-key it was first seen under. */
export interface PromptBudgetSignal {
  /** `prompt-budget:<agentId>:<utc day>` — the dedup key the record is stored under. */
  key: string;
  /** The UTC day (`YYYY-MM-DD`) the signal was first recorded for this agent. */
  day: string;
  agentId: string;
  /** When the agent first crossed a threshold in this window. */
  recordedAt: string;
  /** The card as of the latest pass: numbers refresh, the signal does not repeat. */
  card: PromptBudgetAttentionCard;
}

/** What one refresh did: how many cards, how many of them were new. */
export interface PromptBudgetSignalRefresh {
  cards: number;
  /** Cards that had no signal for this UTC day yet — new signals, one at most per day. */
  recorded: number;
  /** Cards whose signal for this UTC day was already recorded — dedup hits. */
  held: number;
}

/** companyId -> agentId -> the agent's signal of the day. */
const signalByCompany = new Map<string, Map<string, PromptBudgetSignal>>();

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The UTC midnight that opens the signal window of `now`. */
export function promptBudgetSignalWindowStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** True when this agent's signal for the window is already recorded. */
export function hasPromptBudgetSignal(
  companyId: string,
  agentId: string,
  windowStart: Date,
): boolean {
  const key = promptBudgetSignalKey(agentId, windowStart);
  return signalByCompany.get(companyId)?.get(agentId)?.key === key;
}

/**
 * Replace a company's recorded signals with this pass's cards.
 *
 * A card whose agent already has today's signal keeps its record — same key,
 * same `recordedAt` — and only refreshes the numbers, so two passes in the
 * same UTC day record one signal. A card on a new day, or an agent crossing
 * for the first time, records a new signal. Agents no longer over a threshold
 * lose their record: the card leaves the feed on the next list.
 */
export function refreshPromptBudgetSignals(
  companyId: string,
  cards: readonly PromptBudgetAttentionCard[],
  now: Date,
): PromptBudgetSignalRefresh {
  const day = utcDay(now);
  const windowStart = promptBudgetSignalWindowStart(now);
  const previous = signalByCompany.get(companyId);
  const next = new Map<string, PromptBudgetSignal>();
  let recorded = 0;
  let held = 0;
  for (const card of cards) {
    const existing = previous?.get(card.agentId);
    if (existing && existing.day === day) {
      held += 1;
      next.set(card.agentId, { ...existing, card });
      continue;
    }
    recorded += 1;
    next.set(card.agentId, {
      key: promptBudgetSignalKey(card.agentId, windowStart),
      day,
      agentId: card.agentId,
      recordedAt: now.toISOString(),
      card,
    });
  }
  if (next.size > 0) signalByCompany.set(companyId, next);
  else signalByCompany.delete(companyId);
  return { cards: cards.length, recorded, held };
}

/** The company's recorded signals, in a stable agent order. */
export function readPromptBudgetSignals(companyId: string): PromptBudgetSignal[] {
  const recorded = signalByCompany.get(companyId);
  if (!recorded) return [];
  return [...recorded.values()].sort((left, right) =>
    left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0,
  );
}

/** Forget every recorded signal: the feature went off, and tests. */
export function resetPromptBudgetSignals(): void {
  signalByCompany.clear();
}

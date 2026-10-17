// server/src/myrmidon/lesson-distill/raw.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-4): raw material — the lessons hindsight banks
// retained. The pass enumerates a company's agents, resolves each agent's
// memory bank with the SAME rule the memory card applies
// (agent-memory/service.ts: adapterConfig bank, else plugin config), lists
// the bank through the memory client and keeps only lesson units inside the
// window. One bank never fills the pass: the per-bank cap spreads the raw
// material across agents.

import { eq } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import type { MemoryHindsightClient } from "../agent-memory/hindsight-client.js";
import { resolveAgentMemoryBank } from "../agent-memory/service.js";
import {
  isLessonUnit,
  occurrenceInWindow,
  type LessonOccurrence,
  type LessonWindow,
} from "./domain.js";

/** Lessons kept per bank; the rest of the bank waits for the next pass. */
export const MAX_LESSONS_PER_BANK = 200;

export interface LessonCollectorDeps {
  db: Db;
  /** Client factory, overridable in tests (the real one ignores per-company keys here). */
  client: (bankId: string) => MemoryHindsightClient;
  maxLessons?: number;
}

/** Agents of the company, in a stable order (names first, then ids). Every
 * status counts: a busy agent's bank still carries this morning's lessons. */
export async function listCompanyAgentIds(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.companyId, companyId))
    .orderBy(agents.name);
  return rows.map((row) => row.id);
}

/** Companies the sweep passes over (the foraging/distill sweep's rule). */
export async function listCompanyIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, "active"));
  return rows.map((row) => row.id);
}

/**
 * Collect lesson occurrences for one company within the window. A bank that
 * fails to resolve or answer is skipped (logged by the caller's sweep) — one
 * broken memory service must not take the pass down.
 */
export async function collectLessons(
  deps: LessonCollectorDeps,
  companyId: string,
  window: LessonWindow,
): Promise<LessonOccurrence[]> {
  const maxLessons = deps.maxLessons ?? 500;
  const agentIds = await listCompanyAgentIds(deps.db, companyId);
  const resolved = new Map<string, string>(); // bankId -> first agent that uses it
  for (const agentId of agentIds) {
    const bank = await resolveAgentMemoryBank(deps.db, { agentId, companyId });
    if (!bank) continue;
    if (!resolved.has(bank.bankId)) resolved.set(bank.bankId, agentId);
  }

  const occurrences: LessonOccurrence[] = [];
  for (const [bankId] of resolved) {
    const client = deps.client(bankId);
    let offset = 0;
    let perBank = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total && perBank < MAX_LESSONS_PER_BANK && occurrences.length < maxLessons) {
      const page = await client.list(bankId, { limit: 100, offset });
      total = page.total;
      for (const item of page.items) {
        const occurrence: LessonOccurrence = {
          bankId,
          memoryId: item.id,
          text: item.text,
          factType: item.factType,
          at: item.occurredAt ?? item.createdAt ?? "",
        };
        if (!isLessonUnit(occurrence, item.tags)) continue;
        if (!occurrenceInWindow(occurrence, window)) continue;
        occurrences.push(occurrence);
        perBank += 1;
        if (perBank >= MAX_LESSONS_PER_BANK || occurrences.length >= maxLessons) break;
      }
      offset += page.limit;
      if (page.items.length === 0) break;
    }
  }
  return occurrences;
}

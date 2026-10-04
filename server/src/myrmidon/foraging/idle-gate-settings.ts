// server/src/myrmidon/foraging/idle-gate-settings.ts
//
// myrmidon(1.6.2-FORAGING-IDLE-GATE): the database half of the "только в
// простое" rule. Read and write `instance_settings.general.foragingIdleGate`
// (the per-company switch) and `...general.foragingPassJournal` (the pass
// history), the shape the wip-limit and swarm-claim settings already use.
//
// No new table and no vendor column: the switch is a policy the board edits on
// the "Фуражирование" screen, the journal is telemetry the sweep writes, and
// both ride in the one instance settings row. The stored value is the single
// truth of the interface: the pass reads it on every tick, so flipping the
// switch changes the NEXT pass and needs no restart.

import {
  appendForagingPassRecord,
  FORAGING_IDLE_GATE_SETTINGS_KEY,
  FORAGING_PASS_JOURNAL_KEY,
  foragingPassHistory,
  normalizeForagingIdleGateSettings,
  normalizeForagingPassJournal,
  storedForagingIdleOnly,
  type ForagingIdleGateSettings,
  type ForagingPassJournal,
  type ForagingPassRecord,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

export type ForagingGateSettingsService = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral" | "updateGeneral"
>;

/** The stored switch of every company (empty when nothing was ever stored). */
export async function readForagingIdleGateSettings(
  settings: ForagingGateSettingsService,
): Promise<ForagingIdleGateSettings> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  return normalizeForagingIdleGateSettings(general[FORAGING_IDLE_GATE_SETTINGS_KEY]);
}

/** The stored switch of one company, or null when the company has no row. */
export async function readStoredForagingIdleOnly(
  settings: ForagingGateSettingsService,
  companyId: string,
): Promise<boolean | null> {
  return storedForagingIdleOnly(await readForagingIdleGateSettings(settings), companyId);
}

/**
 * Stores one company's switch (PUT semantics for that company; the other
 * companies' rows are carried over untouched).
 */
export async function writeForagingIdleOnly(
  settings: ForagingGateSettingsService,
  companyId: string,
  idleOnly: boolean,
  at: Date = new Date(),
): Promise<ForagingIdleGateSettings> {
  const current = await readForagingIdleGateSettings(settings);
  const next: ForagingIdleGateSettings = {
    companies: {
      ...current.companies,
      [companyId]: { idleOnly, updatedAt: at.toISOString() },
    },
  };
  await settings.updateGeneral({ [FORAGING_IDLE_GATE_SETTINGS_KEY]: next });
  return next;
}

/** The stored pass history of every company (empty when nothing was recorded). */
export async function readForagingPassJournal(
  settings: ForagingGateSettingsService,
): Promise<ForagingPassJournal> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  return normalizeForagingPassJournal(general[FORAGING_PASS_JOURNAL_KEY]);
}

/** The stored pass history of one company, newest first. */
export async function readForagingPassHistory(
  settings: ForagingGateSettingsService,
  companyId: string,
  limit?: number,
): Promise<ForagingPassRecord[]> {
  return foragingPassHistory(await readForagingPassJournal(settings), companyId, limit);
}

/**
 * Records one finished pass. A reader must never be stopped by a write that
 * failed: the caller logs and continues, because the history is evidence, not
 * the work itself.
 */
export async function appendForagingPass(
  settings: ForagingGateSettingsService,
  companyId: string,
  record: ForagingPassRecord,
): Promise<void> {
  const current = await readForagingPassJournal(settings);
  const next = appendForagingPassRecord(current, companyId, record);
  await settings.updateGeneral({ [FORAGING_PASS_JOURNAL_KEY]: next });
}

/**
 * Keeps both keys across vendor writes of `instance_settings.general` — the
 * contract every other myrmidon general key follows (see instance-settings.ts).
 */
export function preserveForagingGeneralKeys(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const source = storedGeneral as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  if (source[FORAGING_IDLE_GATE_SETTINGS_KEY] !== undefined) {
    kept[FORAGING_IDLE_GATE_SETTINGS_KEY] = source[FORAGING_IDLE_GATE_SETTINGS_KEY];
  }
  if (source[FORAGING_PASS_JOURNAL_KEY] !== undefined) {
    kept[FORAGING_PASS_JOURNAL_KEY] = source[FORAGING_PASS_JOURNAL_KEY];
  }
  return kept;
}
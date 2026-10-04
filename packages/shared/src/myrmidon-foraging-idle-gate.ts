// packages/shared/src/myrmidon-foraging-idle-gate.ts
//
// myrmidon(1.6.2-FORAGING-IDLE-GATE): the shared contract of "обучение — только
// в простое": the per-company idle-only switch of the FORAGING pass and the
// journal of what the last passes did.
//
// Two settings keys live in `instance_settings.general`, the same shape the
// swarm-claim pilot uses (settings + journal as two keys):
//
//   - `foragingIdleGate`  — per-company policy: when a company has the switch
//     on, a pass only reads the sources of roles that are idle. Work tasks
//     always come first: a role that has an agent with a queued or running run
//     is skipped, and the pass records why.
//   - `foragingPassJournal` — the pass history behind the "Фуражирование"
//     screen: newest first, capped, with the skip reason of every pass. It is
//     telemetry, not policy, so it lives beside the switch and never blocks it.
//
// The precedence rule is a product rule, not a deployment knob: the instance
// variable can only FORCE the switch (an operator override), the stored value
// is what the board edits on the screen without a restart, and an absent value
// is the default (off — a pass runs on its schedule regardless of load). The
// screen shows which of the three answered, so the panel never pretends the
// interface is in charge when the environment is.
//
// No new tables and no vendor file: both values ride in `instance_settings`.

import { z } from "zod";

// --- keys -----------------------------------------------------------------

/** The `instance_settings.general` key carrying the per-company switch. */
export const FORAGING_IDLE_GATE_SETTINGS_KEY = "foragingIdleGate";
/** The `instance_settings.general` key carrying the pass history. */
export const FORAGING_PASS_JOURNAL_KEY = "foragingPassJournal";

// --- vocabulary -----------------------------------------------------------

/** Why a pass did not read everything it could; kept in sync with the UI. */
export const FORAGING_SKIP_REASONS = ["agents_busy_for_role"] as const;
export type ForagingSkipReason = (typeof FORAGING_SKIP_REASONS)[number];

/** Where the effective switch value came from, so the screen can say it. */
export const FORAGING_IDLE_GATE_SOURCES = ["interface", "env", "default"] as const;
export type ForagingIdleGateSource = (typeof FORAGING_IDLE_GATE_SOURCES)[number];

/** How many passes of one company the journal keeps. */
export const FORAGING_PASS_JOURNAL_LIMIT = 20;

// --- the switch -----------------------------------------------------------

/** One company's stored switch. */
export const foragingCompanyIdleGateSchema = z
  .object({
    idleOnly: z.boolean(),
    /** When the board last changed it (ISO); absent on a hand-written row. */
    updatedAt: z.string().optional(),
  })
  .strict();

export const foragingIdleGateSettingsSchema = z
  .object({
    /** Company id → stored switch. An absent company is the default (off). */
    companies: z.record(z.string(), foragingCompanyIdleGateSchema).default({}),
  })
  .strict();

export type ForagingIdleGateSettings = z.infer<typeof foragingIdleGateSettingsSchema>;

/**
 * The settings as stored, or the empty default when absent. A hand-edited row
 * cannot half-apply: an unreadable object is "no company has the switch", which
 * is the same behaviour as the feature never being configured.
 */
export function normalizeForagingIdleGateSettings(raw: unknown): ForagingIdleGateSettings {
  const parsed = foragingIdleGateSettingsSchema.safeParse(raw);
  if (parsed.success) return { companies: { ...parsed.data.companies } };
  return { companies: {} };
}

/** Read one company's stored switch; `null` when the company has no stored row. */
export function storedForagingIdleOnly(
  settings: ForagingIdleGateSettings,
  companyId: string,
): boolean | null {
  const entry = settings.companies[companyId];
  return entry ? entry.idleOnly : null;
}

/**
 * The effective switch and where it came from. The environment forces the
 * value when the instance variable is set (an operator override); otherwise the
 * stored per-company value answers; otherwise the default (off) does.
 */
export function resolveForagingIdleGate(input: {
  storedIdleOnly: boolean | null;
  envOverride: boolean | null;
}): { idleOnly: boolean; source: ForagingIdleGateSource } {
  if (input.envOverride !== null) return { idleOnly: input.envOverride, source: "env" };
  if (input.storedIdleOnly !== null) return { idleOnly: input.storedIdleOnly, source: "interface" };
  return { idleOnly: false, source: "default" };
}

// --- the pass journal -----------------------------------------------------

/** One finished pass, as the history table shows it. */
export const foragingPassRecordSchema = z
  .object({
    /** When the pass finished (ISO). */
    at: z.string(),
    /** Set when the gate held the pass back; null when the pass ran. */
    skipReason: z.enum(FORAGING_SKIP_REASONS).nullable(),
    /** Roles the gate kept out of this pass (empty when the gate did not act). */
    skippedRoles: z.array(z.string()).default([]),
    sourcesRead: z.number().int().min(0),
    findings: z.number().int().min(0),
    candidates: z.number().int().min(0),
    spentCents: z.number().int().min(0),
    stoppedByBudget: z.boolean(),
    errors: z.number().int().min(0),
  })
  .strict();

export type ForagingPassRecord = z.infer<typeof foragingPassRecordSchema>;

export const foragingPassJournalSchema = z
  .object({
    /** Company id → newest-first pass records. */
    companies: z.record(z.string(), z.array(foragingPassRecordSchema)).default({}),
  })
  .strict();

export type ForagingPassJournal = z.infer<typeof foragingPassJournalSchema>;

/** The journal as stored, or empty when absent or unreadable. */
export function normalizeForagingPassJournal(raw: unknown): ForagingPassJournal {
  const parsed = foragingPassJournalSchema.safeParse(raw);
  if (parsed.success) return { companies: { ...parsed.data.companies } };
  return { companies: {} };
}

/**
 * The journal with one record prepended for a company, capped at `limit`.
 * Pure, so the "the newest pass is first and the history cannot grow without a
 * bound" rule is pinned without a database.
 */
export function appendForagingPassRecord(
  journal: ForagingPassJournal,
  companyId: string,
  record: ForagingPassRecord,
  limit = FORAGING_PASS_JOURNAL_LIMIT,
): ForagingPassJournal {
  const existing = journal.companies[companyId] ?? [];
  const capped = Math.max(1, limit);
  return {
    companies: {
      ...journal.companies,
      [companyId]: [record, ...existing].slice(0, capped),
    },
  };
}

/** The stored history of one company, newest first (empty when none). */
export function foragingPassHistory(
  journal: ForagingPassJournal,
  companyId: string,
  limit?: number,
): ForagingPassRecord[] {
  const rows = journal.companies[companyId] ?? [];
  return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : [...rows];
}
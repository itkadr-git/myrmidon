// server/src/myrmidon/foraging/pass-journal.ts
//
// myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half): the pass journal.
//
// The idle gate (PR #526, OPE-4142) filters a pass per role and reports a
// single `skippedReason` in the pass result — enough for the caller that ran
// the pass, not enough for the "Foraging" page: once the pass is over, a role
// that was left alone leaves no trace, and the operator cannot tell why a
// source was not read. This journal keeps the last passes of every company
// under `instance_settings.general.foragingPassJournal` (newest first, capped)
// so GET /api/myrmidon/companies/:id/foraging/passes can answer.
//
// Conventions of 1.6.1 SWARM-SETTINGS-UI are followed on purpose: the entries
// live under their own general key, one atomic write records the pass, and the
// stored value is re-read defensively (an unreadable entry costs that entry,
// not the view). Recording a pass is best effort — a journal failure must not
// fail a pass that already read its sources.

import type { Db } from "@paperclipai/db";
import {
  appendForagingPassJournal,
  readForagingPassJournal,
  FORAGING_PASS_JOURNAL_KEY,
  FORAGING_PASS_JOURNAL_LIMIT,
  type ForagingPassJournalEntry,
  type ForagingPassSkip,
  type ForagingSkipReason,
} from "@paperclipai/shared";
import { instanceSettingsService } from "../../services/instance-settings.js";

export { FORAGING_PASS_JOURNAL_KEY, FORAGING_PASS_JOURNAL_LIMIT };

/** What a finished pass reports; the journal stamps the time and the company. */
export interface ForagingPassSummary {
  sourcesRead: number;
  findings: number;
  candidates: number;
  errors: number;
  stoppedByBudget: boolean;
  /** The reason reported in the pass result; null when no role was skipped. */
  skippedReason: ForagingSkipReason | null;
  /** Every skipped role of the pass, so the screen can name the roles too. */
  skipped: ForagingPassSkip[];
}

/** Everything the service needs, so tests can run it without a database. */
export interface ForagingPassJournalServiceDeps {
  getGeneral(): Promise<{ foragingPassJournal?: unknown }>;
  updateGeneral(patch: { foragingPassJournal: unknown[] }): Promise<unknown>;
  now?(): Date;
}

export interface ForagingPassJournalService {
  /** The passes of one company, newest first. */
  read(companyId: string, limit?: number): Promise<ForagingPassJournalEntry[]>;
  /** Appends one finished pass; never throws. */
  record(companyId: string, pass: ForagingPassSummary): Promise<void>;
}

export function foragingPassJournalService(
  db: Db,
  overrides: Partial<ForagingPassJournalServiceDeps> = {},
): ForagingPassJournalService {
  const settings = instanceSettingsService(db);
  const deps: ForagingPassJournalServiceDeps = {
    getGeneral: () => settings.getGeneral(),
    updateGeneral: (patch) => settings.updateGeneral(patch),
    ...overrides,
  };
  const now = () => deps.now?.() ?? new Date();

  return {
    read: async (companyId, limit) => {
      let stored: unknown;
      try {
        const general = await deps.getGeneral();
        stored = general?.[FORAGING_PASS_JOURNAL_KEY];
      } catch {
        // A failed read is an empty history, not a failed request.
        return [];
      }
      return readForagingPassJournal(stored, { companyId, limit });
    },

    record: async (companyId, pass) => {
      const entry: ForagingPassJournalEntry = {
        at: now().toISOString(),
        companyId,
        sourcesRead: pass.sourcesRead,
        findings: pass.findings,
        candidates: pass.candidates,
        errors: pass.errors,
        stoppedByBudget: pass.stoppedByBudget,
        skippedReason: pass.skippedReason ?? pass.skipped[0]?.reason ?? null,
        skipped: pass.skipped,
      };
      try {
        const general = await deps.getGeneral();
        const next = appendForagingPassJournal(
          general?.[FORAGING_PASS_JOURNAL_KEY],
          entry,
          FORAGING_PASS_JOURNAL_LIMIT,
        );
        await deps.updateGeneral({ foragingPassJournal: next });
      } catch {
        // The pass already happened; the history is a convenience view.
      }
    },
  };
}
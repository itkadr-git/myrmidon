// server/src/myrmidon/bot-containers/bot-disk-report-store.ts
//
// myrmidon(1.6.5-BOT-DISK-H4b): where the board keeps the last disk report each
// bot sent over `POST /api/myrmidon/bots/me/disk-report` (contract C4 of
// OPE-5306, docs/myrmidon/bot-disk-contract).
//
// STORAGE CHOICE. The same one clone-hygiene.ts made for the clone signals: a
// module-level Map keyed by `botKey`, no table, no `instance_settings` row. A
// report is a snapshot of a running container; it is meaningless after the
// board restarts (every bot reports again within `nextReportSec`, and the
// snapshot ages out of the attention window long before that), so persisting it
// would buy nothing but a migration in a part of the system this epic is
// replacing. The route writes here; the attention cards, the bot card and the
// disk panel (H4c/H4d) read through `readBotDiskReports()`.
//
// The map is the whole authorisation boundary of "two bots never see each
// other": a report is filed under the bot key the API key resolves to, and a
// reader asks for a key (or for all keys) explicitly.

import type { WsDiskReport } from "@paperclipai/shared";

/** One accepted report, as the cards and the panel read it. */
export interface BotDiskReportRecord {
  /** The bot the report is filed under (`botKeyForAgent` of the calling agent). */
  botKey: string;
  /** When the board accepted the report, ms since epoch. */
  receivedAtMs: number;
  /** The bot's own `at`, as the schema parsed it, ms since epoch. */
  reportedAtMs: number;
  /** The report itself, exactly as validated. */
  report: WsDiskReport;
}

const reports = new Map<string, BotDiskReportRecord>();

function toEpochMs(at: string): number {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Remember one accepted report, replacing the bot's previous one. Only the last
 * report per bot is kept: the route keeps the report a snapshot, and the cards
 * ask "what does the disk look like now", never "what did it look like".
 */
export function storeBotDiskReport(
  botKey: string,
  report: WsDiskReport,
  receivedAtMs: number = Date.now(),
): BotDiskReportRecord {
  const record: BotDiskReportRecord = {
    botKey,
    receivedAtMs,
    reportedAtMs: toEpochMs(report.at),
    report,
  };
  reports.set(botKey, record);
  return record;
}

/** The last report of one bot, or null when it has not reported yet. */
export function readBotDiskReport(botKey: string): BotDiskReportRecord | null {
  return reports.get(botKey) ?? null;
}

/**
 * The last report of every bot that has reported since the board started, in a
 * stable order (oldest report first) so cards and the panel do not reshuffle
 * between passes.
 */
export function readBotDiskReports(): BotDiskReportRecord[] {
  return [...reports.values()].sort(
    (left, right) => left.receivedAtMs - right.receivedAtMs || left.botKey.localeCompare(right.botKey),
  );
}

/**
 * Forget the reports of bots that no longer exist — the counterpart of
 * `dropCloneSignalsExcept`, called from the same sweep. Returns how many
 * records were dropped.
 */
export function dropBotDiskReportsExcept(botKeys: ReadonlySet<string>): number {
  let dropped = 0;
  for (const botKey of [...reports.keys()]) {
    if (!botKeys.has(botKey)) {
      reports.delete(botKey);
      dropped += 1;
    }
  }
  return dropped;
}

/** Test hook: empty the store. */
export function resetBotDiskReportsForTests(): void {
  reports.clear();
}
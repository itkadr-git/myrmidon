// myrmidon(1.6.5 BOT-DISK-H4b): the last disk report of every bot (contract C4).
//
// Same storage choice as ingestCloneReport (clone-hygiene.ts): an in-process map,
// no table. A report is a snapshot that botd re-sends every `nextReportSec`, so a
// server restart only leaves the board without a report for one pass; the panel
// and the Attention cards show the receive time and treat an old one as stale.
// The key is the bot key (the agent id), taken from the caller's API key by the
// route — a bot can neither write nor read another bot's entry.

import type { WsDiskReport } from "@paperclipai/shared";

export interface BotDiskReportEntry {
  botKey: string;
  report: WsDiskReport;
  /** When the board received it (ISO-8601 UTC); `report.at` is the bot's own clock. */
  receivedAt: string;
}

const reports = new Map<string, BotDiskReportEntry>();

/** Keep the report of one bot, replacing the previous one. */
export function storeBotDiskReport(botKey: string, report: WsDiskReport, nowMs = Date.now()): BotDiskReportEntry {
  const entry: BotDiskReportEntry = { botKey, report, receivedAt: new Date(nowMs).toISOString() };
  reports.set(botKey, entry);
  return entry;
}

/** The last report of every bot that has sent one (for the cards and the panel). */
export function readBotDiskReports(): BotDiskReportEntry[] {
  return [...reports.values()];
}

/** The last report of one bot, or null. */
export function readBotDiskReport(botKey: string): BotDiskReportEntry | null {
  return reports.get(botKey) ?? null;
}

/** Forget the reports of bots that are gone. */
export function dropBotDiskReportsExcept(botKeys: ReadonlySet<string>): void {
  for (const key of reports.keys()) if (!botKeys.has(key)) reports.delete(key);
}

/** Test helper. */
export function resetBotDiskReports(): void {
  reports.clear();
}

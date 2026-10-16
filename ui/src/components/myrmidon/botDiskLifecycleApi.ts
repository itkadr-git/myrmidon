// Read side of the bot disk lifecycle view (1.6.5 BOT-DISK-H4d). Types come
// from the epic contract (C4 report, C5 dockergate disk answer, in
// `docs/myrmidon/bot-disk-contract`); the two board routes below only relay
// those payloads. A route that is not deployed yet, or an old report without
// some fields, must never break the UI: callers treat a failed read as "no
// data" and every optional field as possibly absent.
import type { WsDiskApiResponse, WsDiskReport } from "@paperclipai/shared";
import { api } from "@/api/client";

/** The board relays dockergate `GET /myrmidon/disk` (contract C5). */
export type BotDiskPhysical = WsDiskApiResponse;

/** Latest stored C4 report per bot; every field but `botKey`/`at` may be absent on an old report. */
export type BotDiskReportView = Partial<Omit<WsDiskReport, "botKey" | "at">> & Pick<WsDiskReport, "botKey" | "at">;

export interface BotDiskReportsView {
  reports: BotDiskReportView[];
}

export const botDiskPhysicalQueryKey = ["myrmidon", "bot-disk", "physical"] as const;
export const botDiskReportsQueryKey = ["myrmidon", "bot-disk", "reports"] as const;

export const botDiskLifecycleApi = {
  getPhysical: () => api.get<BotDiskPhysical>("/myrmidon/bot-disk/physical"),
  getReports: () => api.get<BotDiskReportsView>("/myrmidon/bot-disk/reports"),
};

/** A report older than this is marked stale (design section 5: agent-silent). */
export const BOT_DISK_REPORT_STALE_MS = 30 * 60 * 1000;

/** Archive F retention (design section 2.3): 30 days from creation. */
export const BOT_DISK_ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// myrmidon(1.6.5-BOT-DISK-H4d): "working copy" and "archive" lines of a task,
// read from the bots' disk reports (contract C4). Also exports the small
// formatters the bot disk panel shares. Nothing here may throw on a report
// that lacks fields: an old botd reports less.
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import {
  BOT_DISK_ARCHIVE_RETENTION_MS,
  botDiskLifecycleApi,
  botDiskReportsQueryKey,
  type BotDiskReportView,
} from "./botDiskLifecycleApi";

type T = (key: string, options?: Record<string, unknown>) => string;

export function formatBotDiskBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatBotDiskAge(seconds: number | null | undefined, t: T): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return t("botDisk.ageSeconds", { count: Math.floor(seconds) });
  if (seconds < 3600) return t("botDisk.ageMinutes", { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("botDisk.ageHours", { count: Math.floor(seconds / 3600) });
  return t("botDisk.ageDays", { count: Math.floor(seconds / 86400) });
}

/** "clean, pushed" / "uncommitted changes, not pushed"; null flags read "unknown". */
export function describeCopyState(clean: boolean | null | undefined, pushed: boolean | null | undefined, t: T): string {
  const cleanText = clean === true ? t("botDisk.clean") : clean === false ? t("botDisk.dirty") : t("botDisk.unknown");
  const pushedText = pushed === true ? t("botDisk.pushed") : pushed === false ? t("botDisk.notPushed") : t("botDisk.unknown");
  return `${cleanText}, ${pushedText}`;
}

export interface BotDiskWorkspaceRowProps {
  /** The task key, e.g. `ABC-101` (the `key` of a copy and an archive). */
  issueKey: string;
  /** Test seam: the clock. */
  now?: number;
}

export function BotDiskWorkspaceRow({ issueKey, now }: BotDiskWorkspaceRowProps) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: botDiskReportsQueryKey,
    queryFn: botDiskLifecycleApi.getReports,
    retry: false,
  });
  const reports: BotDiskReportView[] = Array.isArray(data?.reports) ? data.reports : [];
  const clock = now ?? Date.now();

  const copies = reports.flatMap((report) =>
    (report.copies ?? []).filter((copy) => copy.key === issueKey).map((copy) => ({ botKey: report.botKey, copy })),
  );
  const archives = reports.flatMap((report) =>
    (report.archives ?? []).filter((archive) => archive.key === issueKey).map((archive) => ({ botKey: report.botKey, archive })),
  );
  if (copies.length === 0 && archives.length === 0) return null;

  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-testid="bot-disk-workspace-row">
      {copies.map(({ botKey, copy }) => (
        <p key={`${botKey}:${copy.path}`} data-testid="bot-disk-workspace-copy">
          <span className="font-medium text-foreground">{t("botDisk.workspaceCopy")}:</span>{" "}
          {t("botDisk.workspaceCopyLine", {
            bot: botKey,
            path: copy.path,
            state: describeCopyState(copy.clean, copy.pushed, t),
          })}
        </p>
      ))}
      {archives.map(({ botKey, archive }) => {
        const created = Date.parse(archive.createdAt);
        const validDate = Number.isFinite(created);
        return (
          <p key={`${botKey}:${archive.path}`} data-testid="bot-disk-workspace-archive">
            <span className="font-medium text-foreground">{t("botDisk.archive")}:</span>{" "}
            {t("botDisk.archiveLine", {
              path: archive.path,
              size: formatBotDiskBytes(archive.sizeBytes),
              when: validDate
                ? t("botDisk.archiveAge", { age: formatBotDiskAge(Math.max(0, (clock - created) / 1000), t) })
                : t("botDisk.unknown"),
            })}
            {", "}
            {validDate
              ? t("botDisk.retention", { date: new Date(created + BOT_DISK_ARCHIVE_RETENTION_MS).toISOString().slice(0, 10) })
              : t("botDisk.retentionUnknown")}
          </p>
        );
      })}
    </div>
  );
}

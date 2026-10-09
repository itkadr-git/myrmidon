// myrmidon(1.6.6 PROCS-0.1): the «Процессы» panel of Instance settings — the
// read-only view of `board_processes` (design §5.1). It answers the question
// the split makes necessary: which board processes are alive right now, with
// which role, and how fresh their pulse is. Every process writes its own row
// every 10 s; rows older than two minutes are stale and the leader reaps them,
// so a row in this table is a claim that the process answered recently.
//
// The panel polls at the pulse cadence, so it stays live without a server
// restart (acceptance criterion 3 of PROCS-0.1): a process that dies turns
// amber here within one tick and disappears within the staleness window.
import { useQuery } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { useTranslation } from "@/i18n";
import {
  BOARD_PROCESSES_POLL_MS,
  boardProcessesApi,
  boardProcessesQueryKey,
  type BoardProcessView,
} from "./boardProcessesApi";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Role label: `all` is today's single process, `worker`/`api` are the halves
 * of the split (T1.1); an unknown role is shown as it came from the row, so a
 * newer role never renders as an empty cell. */
export function describeBoardProcessRole(t: Translate, role: string): string {
  if (role === "all" || role === "worker" || role === "api") return t(`processes.role.${role}`);
  return role;
}

/** Age of a pulse in whole seconds, minutes or hours. */
export function formatBoardProcessAge(t: Translate, seconds: number): string {
  const value = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  if (value < 60) return t("processes.ageSeconds", { seconds: value });
  if (value < 3600) return t("processes.ageMinutes", { minutes: Math.floor(value / 60) });
  return t("processes.ageHours", { hours: Math.floor(value / 3600) });
}

/** Resident memory of a process, in the units it is judged by. */
export function formatBoardProcessBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** Event-loop lag is a small number of milliseconds, one decimal is enough. */
export function formatBoardProcessLag(lagMs: number | null): string {
  if (lagMs === null || !Number.isFinite(lagMs)) return "—";
  return lagMs < 10 ? lagMs.toFixed(1) : String(Math.round(lagMs));
}

function ProcessRow({ row, t }: { row: BoardProcessView; t: Translate }) {
  const stale = row.status === "stale";
  return (
    <tr
      className="align-top"
      data-testid={`board-process-row-${row.bootId}`}
      data-self={row.self ? "true" : "false"}
      data-stale={stale ? "true" : "false"}
    >
      <td className="pr-2 font-medium" data-testid="board-process-boot">
        <span className="font-mono">{row.bootId.slice(0, 8)}</span>
        {row.self && (
          <span className="ml-2 rounded bg-muted px-1 text-muted-foreground" data-testid="board-process-self">
            {t("processes.self")}
          </span>
        )}
      </td>
      <td className="pr-2" data-testid="board-process-role">
        {describeBoardProcessRole(t, row.role)}
      </td>
      <td className="pr-2">
        {t("processes.pidHost", { pid: row.pid, host: row.hostname })}
        {row.container && <span className="block text-muted-foreground">{row.container}</span>}
      </td>
      <td className="pr-2">{row.apiPort ?? "—"}</td>
      <td className="pr-2">{row.version}</td>
      <td className="pr-2" data-testid="board-process-uptime">{formatBoardProcessAge(t, row.uptimeSeconds)}</td>
      <td className="pr-2" data-testid="board-process-pulse" data-stale={stale ? "true" : "false"}>
        <span className={stale ? "text-amber-600" : undefined}>
          {formatBoardProcessAge(t, row.ageSeconds)}
        </span>
      </td>
      <td className="pr-2" data-testid="board-process-lag">
        {formatBoardProcessLag(row.eventLoopLagMs)}
      </td>
      <td data-testid="board-process-rss">{formatBoardProcessBytes(row.rssBytes)}</td>
    </tr>
  );
}

export function BoardProcessesSettingsPanel() {
  const { t } = useTranslation() as { t: Translate };
  const query = useQuery({
    queryKey: boardProcessesQueryKey,
    queryFn: boardProcessesApi.list,
    refetchInterval: BOARD_PROCESSES_POLL_MS,
    retry: false,
  });
  const processes = Array.isArray(query.data?.processes) ? query.data.processes : [];
  const selfMissing = query.data !== undefined && !processes.some((row) => row.self);

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="board-processes-panel">
      <div className="flex items-center gap-2">
        <Cpu className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium" data-testid="board-processes-title">
          {t("processes.title")}
        </h3>
      </div>
      <p className="text-xs text-muted-foreground">{t("processes.subtitle")}</p>
      {query.isError ? (
        <p className="text-xs text-red-600" data-testid="board-processes-error">
          {t("processes.error")}
        </p>
      ) : query.isPending ? (
        <p className="text-xs text-muted-foreground" data-testid="board-processes-loading">
          {t("processes.loading")}
        </p>
      ) : processes.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="board-processes-empty">
          {t("processes.empty")}
        </p>
      ) : (
        <table className="w-full text-left text-xs" data-testid="board-processes-table">
          <thead>
            <tr className="text-muted-foreground">
              <th className="pr-2 font-normal">{t("processes.colProcess")}</th>
              <th className="pr-2 font-normal">{t("processes.colRole")}</th>
              <th className="pr-2 font-normal">{t("processes.colHost")}</th>
              <th className="pr-2 font-normal">{t("processes.colPort")}</th>
              <th className="pr-2 font-normal">{t("processes.colVersion")}</th>
              <th className="pr-2 font-normal">{t("processes.colStarted")}</th>
              <th className="pr-2 font-normal">{t("processes.colPulse")}</th>
              <th className="pr-2 font-normal">{t("processes.colLag")}</th>
              <th className="font-normal">{t("processes.colRss")}</th>
            </tr>
          </thead>
          <tbody>
            {processes.map((row) => (
              <ProcessRow key={row.bootId} row={row} t={t} />
            ))}
          </tbody>
        </table>
      )}
      {selfMissing && (
        <p className="text-xs text-amber-600" data-testid="board-processes-self-missing">
          {t("processes.selfMissing")}
        </p>
      )}
      {query.data && (
        <p className="text-xs text-muted-foreground" data-testid="board-processes-cadence">
          {t("processes.cadence", {
            pulse: query.data.pulseSeconds,
            stale: query.data.staleAfterSeconds,
          })}
        </p>
      )}
    </section>
  );
}

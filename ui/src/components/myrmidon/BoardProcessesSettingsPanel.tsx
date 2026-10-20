// myrmidon(1.6.6 PROCS-0.1): the «Процессы» panel of Instance settings — the
// read-only view of `board_processes` (design §5.1). It answers the question
// the split makes necessary: which board processes are alive right now, with
// which role, and how fresh their pulse is. Every process writes its own row
// every 10 s; rows older than two minutes are stale and the leader reaps them,
// so a row in this table is a claim that the process answered recently.
//
// OPE-7003 (OPE-6875 ч.I): the rows are grouped by role (api first, then
// worker, then every other role as it came from the registry), each row
// carries a «Готов» (ready) verdict and a restart count, and the panel polls
// every 5 s so a fresh restart surfaces almost at once. Ready here is the
// registry verdict: a row whose pulse is inside the staleness window is
// готов, an older one is не готов — the same contract /internal/procs
// reports (ч.D, OPE-6959). The restart count is derived from the registry
// itself: one boot writes exactly one row (its bootId is a fresh UUID), so
// the boot's ordinal among the rows of its role on one host — current plus
// not yet reaped — is how many generations of it the board has seen lately;
// a process that never restarted counts 1.
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

/** The group order the operator reads the panel in: the request-serving api
 * children first, then the workers, then the all-in-one row of a single
 * process; a role this release does not know yet sorts after the known ones,
 * alphabetically, so it is never dropped. */
const BOARD_PROCESS_ROLE_ORDER: Record<string, number> = { api: 0, worker: 1, all: 2 };

function boardProcessRoleRank(role: string): number {
  return BOARD_PROCESS_ROLE_ORDER[role] ?? 3;
}

/** One group of rows of the same role, in the order the panel renders. */
export interface BoardProcessRoleGroup {
  role: string;
  rows: BoardProcessView[];
}

/** Groups the registry rows by role (OPE-7003): api first, then worker, then
 * the rest; rows inside a group keep the server's oldest-start-first order so
 * the long-lived leader of a role stays on top. */
export function groupBoardProcessesByRole(processes: BoardProcessView[]): BoardProcessRoleGroup[] {
  const byRole = new Map<string, BoardProcessView[]>();
  for (const row of processes) {
    const bucket = byRole.get(row.role);
    if (bucket) bucket.push(row);
    else byRole.set(row.role, [row]);
  }
  return [...byRole.entries()]
    .sort(([a], [b]) => {
      const rank = boardProcessRoleRank(a) - boardProcessRoleRank(b);
      return rank !== 0 ? rank : a.localeCompare(b);
    })
    .map(([role, rows]) => ({ role, rows }));
}

/** How many times this process slot has booted: the registry keeps one row
 * per boot (current and not-yet-reaped), so the boot's ordinal among the rows
 * of its role on its host — oldest start first — is the restart count. A
 * single process that never restarted counts 1. */
export function boardProcessRestartCount(
  row: BoardProcessView,
  processes: BoardProcessView[],
): number {
  const sameSlot = processes.filter(
    (other) => other.role === row.role && other.hostname === row.hostname,
  );
  const byStart = [...sameSlot].sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.bootId.localeCompare(b.bootId),
  );
  const index = byStart.findIndex((other) => other.bootId === row.bootId);
  return index < 0 ? 1 : index + 1;
}

function ProcessRow({
  row,
  t,
  restartCount,
}: {
  row: BoardProcessView;
  t: Translate;
  restartCount: number;
}) {
  const ready = row.status === "live";
  return (
    <tr
      className="align-top"
      data-testid={`board-process-row-${row.bootId}`}
      data-self={row.self ? "true" : "false"}
      data-stale={ready ? "false" : "true"}
      data-ready={ready ? "true" : "false"}
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
      <td className="pr-2" data-testid="board-process-ready" data-ready={ready ? "true" : "false"}>
        <span className={ready ? undefined : "text-amber-600"}>
          {t(ready ? "processes.readyYes" : "processes.readyNo")}
        </span>
      </td>
      <td className="pr-2">
        {t("processes.pidHost", { pid: row.pid, host: row.hostname })}
        {row.container && <span className="block text-muted-foreground">{row.container}</span>}
      </td>
      <td className="pr-2">{row.apiPort ?? "—"}</td>
      <td className="pr-2">{row.version}</td>
      <td className="pr-2" data-testid="board-process-uptime">{formatBoardProcessAge(t, row.uptimeSeconds)}</td>
      <td className="pr-2" data-testid="board-process-restarts">
        {t("processes.restartCount", { count: restartCount })}
      </td>
      <td className="pr-2" data-testid="board-process-pulse" data-stale={ready ? "false" : "true"}>
        <span className={ready ? undefined : "text-amber-600"}>
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
  const groups = groupBoardProcessesByRole(processes);
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
              <th className="pr-2 font-normal">{t("processes.colReady")}</th>
              <th className="pr-2 font-normal">{t("processes.colHost")}</th>
              <th className="pr-2 font-normal">{t("processes.colPort")}</th>
              <th className="pr-2 font-normal">{t("processes.colVersion")}</th>
              <th className="pr-2 font-normal">{t("processes.colStarted")}</th>
              <th className="pr-2 font-normal">{t("processes.colRestarts")}</th>
              <th className="pr-2 font-normal">{t("processes.colPulse")}</th>
              <th className="pr-2 font-normal">{t("processes.colLag")}</th>
              <th className="font-normal">{t("processes.colRss")}</th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.role} data-testid={`board-process-group-${group.role}`}>
              <tr data-testid={`board-process-group-header-${group.role}`}>
                <th colSpan={11} className="pt-2 text-left font-medium text-muted-foreground">
                  {t("processes.groupSummary", {
                    role: describeBoardProcessRole(t, group.role),
                    count: group.rows.length,
                    ready: group.rows.filter((row) => row.status === "live").length,
                  })}
                </th>
              </tr>
              {group.rows.map((row) => (
                <ProcessRow
                  key={row.bootId}
                  row={row}
                  t={t}
                  restartCount={boardProcessRestartCount(row, processes)}
                />
              ))}
            </tbody>
          ))}
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

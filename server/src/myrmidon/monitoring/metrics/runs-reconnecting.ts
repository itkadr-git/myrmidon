// server/src/myrmidon/monitoring/metrics/runs-reconnecting.ts
//
// myrmidon(1.6.6 rc.19 MONITORING OPE-10046):
// Watchdog and metrics for heartbeat runs hanging in reconnecting phase.

import type { Db } from "@myrmidon/db";
import { heartbeatRuns, issueCreateIdempotencyKeys, issues } from "@myrmidon/db";
import { and, eq } from "drizzle-orm";
import type { ExecutionProjection } from "@myrmidon/shared";
import {
  executionProjectionsForRuns,
  getExecutionLiveSignalWindowSec,
  projectExecution,
} from "../../../services/execution-projection.js";
import type { AlertRecoveryAlert } from "../alert-recovery/domain.js";

export const KNOWN_EXECUTION_PHASES = [
  "working",
  "reconnecting",
  "finishing",
  "retry_scheduled",
  "recovery_needed",
] as const;
export type KnownExecutionPhase = (typeof KNOWN_EXECUTION_PHASES)[number];

export interface LiveRunRecord {
  id: string;
  companyId: string;
  status: string;
  startedAt: Date | string | null;
  createdAt?: Date | string | null;
  lastConfirmedActivityAt?: Date | string | null;
  lastUsefulActionAt?: Date | string | null;
  lastOutputAt?: Date | string | null;
  lastEventAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

export interface ReconnectingRunDetail {
  runId: string;
  companyId: string;
  reconnectingSeconds: number;
  lastConfirmedActivityAt: string | null;
}

export interface RunsExecutionEvaluation {
  liveRunsCount: number;
  phaseCounts: Record<string, number>;
  reconnectingRunsCount: number;
  reconnectingRatio: number;
  reconnectingOldestSeconds: number;
  reconnectingRuns: ReconnectingRunDetail[];
  firing: boolean;
  firingReason: "count_and_age" | "ratio" | "both" | null;
}

export interface ReconnectingRunsAlertTask {
  title: string;
  description: string;
  priority: "high";
  status: "todo";
  assigneeAgentId?: string | null;
  idempotencyKey: string;
  originKind: "system";
}

/**
 * Evaluates live runs against projections to calculate:
 * 1. Counts per execution phase (working, reconnecting, etc.)
 * 2. Oldest reconnecting run duration in seconds
 * 3. Alert condition: >= 3 runs in reconnecting for >= 300s OR > 50% live runs in reconnecting
 */
export function computeRunsExecutionEvaluation(
  runs: LiveRunRecord[],
  projections?: Map<string, ExecutionProjection>,
  now = new Date(),
  options?: { liveSignalWindowSec?: number },
): RunsExecutionEvaluation {
  const windowSec = options?.liveSignalWindowSec ?? getExecutionLiveSignalWindowSec();
  const liveRuns = runs.filter((r) => r.status === "running");
  const liveRunsCount = liveRuns.length;

  const phaseCounts: Record<string, number> = {};
  for (const phase of KNOWN_EXECUTION_PHASES) {
    phaseCounts[phase] = 0;
  }

  const reconnectingRuns: ReconnectingRunDetail[] = [];

  for (const run of liveRuns) {
    let projection = projections?.get(run.id);
    if (!projection) {
      projection = projectExecution(
        run as any,
        undefined,
        [],
        undefined,
        now,
        { liveSignalWindowSec: windowSec },
      );
    }
    const phase = projection?.phase ?? "working";
    phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;

    if (phase === "reconnecting") {
      const candidateDates: Date[] = [];
      if (projection?.lastConfirmedActivityAt) {
        const d = new Date(projection.lastConfirmedActivityAt);
        if (!isNaN(d.getTime())) candidateDates.push(d);
      }
      for (const val of [
        run.lastConfirmedActivityAt,
        run.lastUsefulActionAt,
        run.lastOutputAt,
        run.lastEventAt,
        run.updatedAt,
        run.startedAt,
        run.createdAt,
      ]) {
        if (val) {
          const d = new Date(val);
          if (!isNaN(d.getTime())) candidateDates.push(d);
        }
      }

      let lastActivityIso: string | null = null;
      let lastActivityMs = now.getTime();
      if (candidateDates.length > 0) {
        lastActivityMs = Math.max(...candidateDates.map((d) => d.getTime()));
        lastActivityIso = new Date(lastActivityMs).toISOString();
      }

      const silenceSeconds = Math.max(
        0,
        Math.floor((now.getTime() - lastActivityMs) / 1000),
      );

      reconnectingRuns.push({
        runId: run.id,
        companyId: run.companyId,
        reconnectingSeconds: silenceSeconds,
        lastConfirmedActivityAt: lastActivityIso,
      });
    }
  }

  // Sort descending by reconnecting duration so oldest is first
  reconnectingRuns.sort((a, b) => b.reconnectingSeconds - a.reconnectingSeconds);

  const reconnectingRunsCount = reconnectingRuns.length;
  const reconnectingRatio =
    liveRunsCount > 0 ? reconnectingRunsCount / liveRunsCount : 0;
  const reconnectingOldestSeconds =
    reconnectingRuns.length > 0 ? reconnectingRuns[0].reconnectingSeconds : 0;

  // Alert rule:
  // - at least 3 runs in reconnecting longer than 5 minutes (300s)
  // OR
  // - more than 50% of live runs in reconnecting
  const longReconnectingCount = reconnectingRuns.filter(
    (r) => r.reconnectingSeconds >= 300,
  ).length;
  const firingByAge = longReconnectingCount >= 3;
  const firingByRatio = liveRunsCount > 0 && reconnectingRatio > 0.5;
  const firing = firingByAge || firingByRatio;

  const firingReason: RunsExecutionEvaluation["firingReason"] =
    firingByAge && firingByRatio
      ? "both"
      : firingByAge
        ? "count_and_age"
        : firingByRatio
          ? "ratio"
          : null;

  return {
    liveRunsCount,
    phaseCounts,
    reconnectingRunsCount,
    reconnectingRatio,
    reconnectingOldestSeconds,
    reconnectingRuns,
    firing,
    firingReason,
  };
}

export function buildReconnectingRunsAlertTask(
  evaluation: RunsExecutionEvaluation,
  companyId: string,
  now = new Date(),
): ReconnectingRunsAlertTask {
  const percent = Math.round(evaluation.reconnectingRatio * 100);
  const reasonText =
    evaluation.firingReason === "count_and_age"
      ? "не менее 3 прогонов в reconnecting дольше 5 мин"
      : evaluation.firingReason === "ratio"
        ? `более 50% живых прогонов в reconnecting (${percent}%)`
        : `не менее 3 прогонов в reconnecting дольше 5 мин И более 50% живых прогонов (${percent}%)`;

  const runIdsFormatted = evaluation.reconnectingRuns
    .map(
      (r) =>
        `- \`${r.runId}\`: висит ${r.reconnectingSeconds} с (последняя активность: ${r.lastConfirmedActivityAt ?? "нет данных"})`,
    )
    .join("\n");

  const title = `[devops] Прогоны висят в reconnecting (${evaluation.reconnectingRunsCount}/${evaluation.liveRunsCount})`;
  const description = [
    `## Внимание: обнаружены зависшие прогоны в фазе reconnecting`,
    ``,
    `- **Причина срабатывания:** ${reasonText}`,
    `- **Всего живых прогонов:** ${evaluation.liveRunsCount}`,
    `- **В reconnecting:** ${evaluation.reconnectingRunsCount} (${percent}%)`,
    `- **Самый старый прогон висит:** ${evaluation.reconnectingOldestSeconds} с`,
    `- **Время фиксации:** ${now.toISOString()}`,
    ``,
    `### Список затронутых run ID:`,
    runIdsFormatted,
    ``,
    `### Действия по восстановлению:`,
    `1. Проверить журналы затронутых прогонов: \`GET /api/heartbeat-runs/:id/log\`.`,
    `2. Проверить сетевую доступность агентов и шлюзов (hermes_gateway).`,
    `3. При необходимости отменить невосстановимые прогоны через \`POST /api/heartbeat-runs/:id/cancel\`.`,
  ].join("\n");

  return {
    title,
    description,
    priority: "high",
    status: "todo",
    idempotencyKey: `monitoring:runs-reconnecting:${companyId}`,
    originKind: "system",
  };
}

export function buildReconnectingRunsAlertEvent(
  evaluation: RunsExecutionEvaluation,
  companyId: string,
  now = new Date(),
): AlertRecoveryAlert {
  const percent = Math.round(evaluation.reconnectingRatio * 100);
  const runIds = evaluation.reconnectingRuns.map((r) => r.runId);

  return {
    companyId,
    source: "monitoring",
    eventKey: `runs-reconnecting:${companyId}`,
    trigger: "runs-reconnecting",
    triggerId: "runs-reconnecting",
    status: "firing",
    severity: "high",
    title: `Прогоны висят в reconnecting (${evaluation.reconnectingRunsCount}/${evaluation.liveRunsCount})`,
    summary: `Обнаружены прогоны в reconnecting (${evaluation.reconnectingRunsCount} из ${evaluation.liveRunsCount}, ${percent}%): ${runIds.join(", ")}`,
    happenedAt: now.toISOString(),
  };
}

export function buildReconnectingRunsResolvedEvent(
  companyId: string,
  now = new Date(),
): AlertRecoveryAlert {
  return {
    companyId,
    source: "monitoring",
    eventKey: `runs-reconnecting:${companyId}`,
    trigger: "runs-reconnecting",
    triggerId: "runs-reconnecting",
    status: "resolved",
    severity: "high",
    title: "Прогоны в reconnecting восстановились",
    summary: "Все живые прогоны вышли из состояния reconnecting",
    happenedAt: now.toISOString(),
  };
}

export interface RunsReconnectingWatchdogDeps {
  listLiveRuns(): Promise<LiveRunRecord[]>;
  getProjections(
    companyId: string,
    runIds: string[],
    now: Date,
  ): Promise<Map<string, ExecutionProjection>>;
  resolveAlertAssignee?(companyId: string): Promise<string | null>;
  createAlert?(
    companyId: string,
    task: ReconnectingRunsAlertTask,
  ): Promise<{ id: string }>;
  closeAlert?(
    companyId: string,
    idempotencyKey: string,
    comment: string,
  ): Promise<boolean>;
  sendAlertEvent?(event: AlertRecoveryAlert): Promise<void>;
  log?: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
}

export interface RunsReconnectingWatchdog {
  sweep(now?: Date): Promise<{
    evaluatedCompanies: number;
    firingCount: number;
    evaluations: Map<string, RunsExecutionEvaluation>;
  }>;
}

export function createRunsReconnectingWatchdog(
  deps: RunsReconnectingWatchdogDeps,
): RunsReconnectingWatchdog {
  const activeAlerts = new Set<string>();

  return {
    sweep: async (now = new Date()) => {
      const runs = await deps.listLiveRuns();

      // Group live runs by companyId
      const runsByCompany = new Map<string, LiveRunRecord[]>();
      for (const run of runs) {
        if (run.status !== "running") continue;
        const list = runsByCompany.get(run.companyId) ?? [];
        list.push(run);
        runsByCompany.set(run.companyId, list);
      }

      // Also ensure companies that previously had active alerts are checked
      for (const companyId of activeAlerts) {
        if (!runsByCompany.has(companyId)) {
          runsByCompany.set(companyId, []);
        }
      }

      let firingCount = 0;
      const evaluations = new Map<string, RunsExecutionEvaluation>();

      for (const [companyId, companyRuns] of runsByCompany.entries()) {
        const runIds = companyRuns.map((r) => r.id);
        const projections =
          runIds.length > 0
            ? await deps.getProjections(companyId, runIds, now)
            : new Map<string, ExecutionProjection>();

        const evaluation = computeRunsExecutionEvaluation(
          companyRuns,
          projections,
          now,
        );
        evaluations.set(companyId, evaluation);

        const idempotencyKey = `monitoring:runs-reconnecting:${companyId}`;

        if (evaluation.firing) {
          firingCount++;
          activeAlerts.add(companyId);

          deps.log?.warn?.(
            `Runs reconnecting alert firing for company ${companyId}: ${evaluation.reconnectingRunsCount}/${evaluation.liveRunsCount} runs in reconnecting`,
          );

          if (deps.sendAlertEvent) {
            const event = buildReconnectingRunsAlertEvent(
              evaluation,
              companyId,
              now,
            );
            await deps.sendAlertEvent(event);
          } else if (deps.createAlert) {
            const task = buildReconnectingRunsAlertTask(
              evaluation,
              companyId,
              now,
            );
            if (deps.resolveAlertAssignee) {
              task.assigneeAgentId = await deps.resolveAlertAssignee(companyId);
            }
            await deps.createAlert(companyId, task);
          }
        } else if (activeAlerts.has(companyId)) {
          activeAlerts.delete(companyId);

          deps.log?.info?.(
            `Runs reconnecting alert resolved for company ${companyId}`,
          );

          if (deps.sendAlertEvent) {
            const event = buildReconnectingRunsResolvedEvent(companyId, now);
            await deps.sendAlertEvent(event);
          } else if (deps.closeAlert) {
            const recoveryComment =
              "Сторож reconnecting-прогонов: все живые прогоны вернулись в норму, тревога снята.";
            await deps.closeAlert(companyId, idempotencyKey, recoveryComment);
          }
        }
      }

      return {
        evaluatedCompanies: runsByCompany.size,
        firingCount,
        evaluations,
      };
    },
  };
}

export function buildRunsReconnectingWatchdog(db: Db): RunsReconnectingWatchdog {
  let alertRecoverySvc: any = null;
  const getAlertRecoveryService = async () => {
    if (!alertRecoverySvc) {
      const { buildAlertRecoveryService } = await import(
        "../alert-recovery/service.js"
      );
      alertRecoverySvc = buildAlertRecoveryService(db);
    }
    return alertRecoverySvc;
  };

  return createRunsReconnectingWatchdog({
    listLiveRuns: async () => {
      return await db
        .select({
          id: heartbeatRuns.id,
          companyId: heartbeatRuns.companyId,
          status: heartbeatRuns.status,
          startedAt: heartbeatRuns.startedAt,
          createdAt: heartbeatRuns.createdAt,
          lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
          lastOutputAt: heartbeatRuns.lastOutputAt,
          lastEventAt: heartbeatRuns.lastEventAt,
          updatedAt: heartbeatRuns.updatedAt,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "running"));
    },
    getProjections: async (companyId, runIds, now) => {
      return await executionProjectionsForRuns(db, companyId, runIds, now);
    },
    sendAlertEvent: async (event) => {
      const svc = await getAlertRecoveryService();
      await svc.ingest(event);
    },
    resolveAlertAssignee: async (companyId) => {
      try {
        const { resolveActorByRole } = await import(
          "../../../services/role-resolver.js"
        );
        const actor = await resolveActorByRole(db, companyId, "devops");
        return actor?.agentId ?? null;
      } catch {
        return null;
      }
    },
    createAlert: async (companyId, task) => {
      const { issueService } = await import("../../../services/issue.js");
      const svc = issueService(db);
      const created = (await svc.create(companyId, {
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        assigneeAgentId: task.assigneeAgentId,
        originKind: task.originKind,
        idempotencyKey: task.idempotencyKey,
      } as never)) as any;
      return { id: created?.id ?? "" };
    },
    closeAlert: async (companyId, idempotencyKey, comment) => {
      const row = await db
        .select({
          issueId: issueCreateIdempotencyKeys.issueId,
          status: issues.status,
        })
        .from(issueCreateIdempotencyKeys)
        .innerJoin(issues, eq(issues.id, issueCreateIdempotencyKeys.issueId))
        .where(
          and(
            eq(issueCreateIdempotencyKeys.companyId, companyId),
            eq(issueCreateIdempotencyKeys.idempotencyKey, idempotencyKey),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!row || row.status === "done" || row.status === "cancelled") {
        return false;
      }
      const { issueService } = await import("../../../services/issue.js");
      const svc = issueService(db);
      await svc.update(row.issueId, {
        status: "done",
        companyGuard: companyId,
      } as never);
      await svc.addComment(row.issueId, comment, {}, { authorType: "system" });
      return true;
    },
  });
}

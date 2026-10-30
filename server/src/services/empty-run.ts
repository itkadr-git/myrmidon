import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import {
  activityLog,
  agents,
  heartbeatRuns,
  heartbeatRunEvents,
  issues,
  issueComments,
  issueWorkProducts,
  documentRevisions,
  workspaceOperations,
  agentWakeupRequests,
} from "@myrmidon/db";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";

export const DEVEFF_EVENT_NO_OP = "run.deveff.no_op";
export const DEVEFF_EVENT_REPEATED_TOOL_ERROR = "run.deveff.repeated_tool_error";

export type EmptyRunReason =
  | "no_changes_and_no_status_transition"
  | "repeated_tool_errors"
  | "empty_response";

export interface EmptyRunEvaluationInput {
  runId: string;
  issueId?: string | null;
  agentId?: string | null;
  statusBefore?: string | null;
  statusAfter?: string | null;
  workProductsCreated?: number;
  commitsCreated?: number;
  pullRequestsCreated?: number;
  documentRevisionsCreated?: number;
  workspaceOperationsCreated?: number;
  hasFileOrArtifactChanges?: boolean;
  repeatedToolErrorCount?: number;
  repeatedToolErrorDetails?: string | null;
  livenessState?: string | null;
  isExplicitBlocker?: boolean;
  blockerReason?: string | null;
}

export interface EmptyRunClassification {
  isEmpty: boolean;
  reason: EmptyRunReason | null;
  description: string;
}

export const MAX_REPEATED_TOOL_ERRORS = 3;
export const MAX_CONSECUTIVE_EMPTY_RUNS = 5;

/**
 * 1.7 AGENT-RUNTIME: Определение «пустого прогона» (OPE-10066).
 * Критерии: нет изменения файлов или артефакта, нет смены статуса,
 * повтор той же ошибки инструмента, либо пустой ответ (empty_response).
 */
export function classifyEmptyRun(input: EmptyRunEvaluationInput): EmptyRunClassification {
  // 1. Повтор той же ошибки инструмента (лимит повторов одинаковых ошибок)
  if ((input.repeatedToolErrorCount ?? 0) >= MAX_REPEATED_TOOL_ERRORS || input.repeatedToolErrorDetails) {
    return {
      isEmpty: true,
      reason: "repeated_tool_errors",
      description:
        input.repeatedToolErrorDetails ??
        `Repeated tool failure limit exceeded (${input.repeatedToolErrorCount ?? MAX_REPEATED_TOOL_ERRORS} failures)`,
    };
  }

  // 2. Пустой ответ / отсутствие действий
  if (input.livenessState === "empty_response") {
    return {
      isEmpty: true,
      reason: "empty_response",
      description: "Run produced no useful output or concrete actions",
    };
  }

  // 3. Явный блокер с причиной: завершение с явным блокером не является холостым зависанием
  if (input.isExplicitBlocker || input.statusAfter === "blocked") {
    return {
      isEmpty: false,
      reason: null,
      description: `Run concluded with explicit blocker: ${input.blockerReason ?? "blocked"}`,
    };
  }

  // 4. Смена статуса задачи (например, in_progress -> in_review, done, blocked)
  const statusChanged = Boolean(
    input.statusBefore &&
    input.statusAfter &&
    input.statusBefore !== input.statusAfter &&
    input.statusAfter !== "in_progress",
  );
  if (statusChanged) {
    return {
      isEmpty: false,
      reason: null,
      description: `Run changed issue status from ${input.statusBefore} to ${input.statusAfter}`,
    };
  }

  // 5. Проверка наличия изменений файлов, коммитов, PR или артефактов
  const totalArtifacts =
    (input.workProductsCreated ?? 0) +
    (input.commitsCreated ?? 0) +
    (input.pullRequestsCreated ?? 0) +
    (input.documentRevisionsCreated ?? 0);

  const hasChanges = totalArtifacts > 0 || Boolean(input.hasFileOrArtifactChanges);

  if (!hasChanges) {
    return {
      isEmpty: true,
      reason: "no_changes_and_no_status_transition",
      description: "Run produced no file changes, commits, PRs, work products, or status transition",
    };
  }

  return {
    isEmpty: false,
    reason: null,
    description: `Run produced concrete changes or artifacts (${totalArtifacts} artifact(s))`,
  };
}

export type CompletionGateKind = "commit_or_pr" | "status_change" | "explicit_blocker" | "none";

export interface CompletionGateResult {
  passed: boolean;
  gateMet: CompletionGateKind;
  reason: string;
}

/**
 * 1.7 AGENT-RUNTIME: Гейт завершения прогона (OPE-10066, пункт 4).
 * Прогон завершается только с коммитом/PR, сменой статуса, либо явным блокером с причиной.
 */
export function evaluateCompletionGate(input: EmptyRunEvaluationInput): CompletionGateResult {
  // 1. Коммит или PR (или созданный work product / артефакт)
  const hasCommitOrPr =
    (input.commitsCreated ?? 0) > 0 ||
    (input.pullRequestsCreated ?? 0) > 0 ||
    (input.workProductsCreated ?? 0) > 0 ||
    Boolean(input.hasFileOrArtifactChanges);

  if (hasCommitOrPr) {
    return {
      passed: true,
      gateMet: "commit_or_pr",
      reason: "Run produced a commit, pull request, or work product",
    };
  }

  // 2. Смена статуса задачи
  const statusChanged = Boolean(
    input.statusBefore &&
    input.statusAfter &&
    input.statusBefore !== input.statusAfter,
  );
  if (statusChanged) {
    return {
      passed: true,
      gateMet: "status_change",
      reason: `Run changed issue status from ${input.statusBefore} to ${input.statusAfter}`,
    };
  }

  // 3. Явный блокер с причиной
  if (input.statusAfter === "blocked" || input.isExplicitBlocker) {
    return {
      passed: true,
      gateMet: "explicit_blocker",
      reason: `Run declared an explicit blocker: ${input.blockerReason ?? "blocked"}`,
    };
  }

  return {
    passed: false,
    gateMet: "none",
    reason: "Completion gate failed: run ended without commit/PR, status change, or explicit blocker with reason",
  };
}

export interface EmptyRunEscalationResult {
  escalated: boolean;
  consecutiveEmptyRuns: number;
  shouldRewake: boolean;
  message?: string;
}

/**
 * 1.7 AGENT-RUNTIME: Лимит повторов и эскалация (OPE-10066, пункт 3).
 * После N (5) пустых прогонов по задаче — эскалация с причиной, а не новое пробуждение.
 */
export async function checkAndHandleEmptyRunEscalation(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    runId: string;
    classification: EmptyRunClassification;
    gateResult: CompletionGateResult;
  },
): Promise<EmptyRunEscalationResult> {
  // Если прогон продуктивный и прошёл гейт — сбрасываем серию пустых прогонов
  if (!input.classification.isEmpty && input.gateResult.passed) {
    return {
      escalated: false,
      consecutiveEmptyRuns: 0,
      shouldRewake: true,
    };
  }

  // Получаем историю последних завершённых прогонов по этой задаче
  const recentRuns = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      livenessState: heartbeatRuns.livenessState,
      livenessReason: heartbeatRuns.livenessReason,
      resultJson: heartbeatRuns.resultJson,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextIssueId}, ${heartbeatRuns.contextSnapshot} ->> 'issueId') = ${input.issueId}`,
        inArray(heartbeatRuns.status, ["succeeded", "failed"]),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(10);

  // Считаем серию пустых прогонов подряд
  let consecutiveEmptyRuns = 1; // Текущий прогон уже признан пустым
  for (const prevRun of recentRuns) {
    if (prevRun.id === input.runId) continue;

    const isPrevEmpty =
      prevRun.livenessState === "empty_response" ||
      prevRun.livenessReason?.includes("Repeated tool failure") ||
      prevRun.livenessReason?.includes("no file changes");

    if (isPrevEmpty) {
      consecutiveEmptyRuns++;
    } else {
      break;
    }
  }

  if (consecutiveEmptyRuns >= MAX_CONSECUTIVE_EMPTY_RUNS) {
    const escalationReason =
      `Лимит повторов (${MAX_CONSECUTIVE_EMPTY_RUNS} пустых прогонов подряд) исчерпан. ` +
      `Причина: ${input.classification.description}. ` +
      `Гейт завершения: ${input.gateResult.reason}.`;

    const commentBody = [
      `[STOP CONDITION / IDLE_LOOP] Задача достигла лимита в ${MAX_CONSECUTIVE_EMPTY_RUNS} пустых прогонов подряд без прогресса.`,
      "",
      `**Причина:** ${input.classification.description}`,
      `**Гейт завершения:** ${input.gateResult.reason}`,
      `**Последний прогон:** \`${input.runId}\``,
      `**Исполнитель:** \`${input.agentId}\``,
      "",
      "Задача переведена в статус `blocked`. Автоматические повторные пробуждения остановлены. Требуется вмешательство лида / владельца задачи.",
    ].join("\n");

    // 1. Оставляем комментарий с эскалацией
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorAgentId: input.agentId,
      createdByRunId: input.runId,
      body: commentBody,
    });

    // 2. Переводим задачу в blocked с метаданными блокера
    await db
      .update(issues)
      .set({
        status: "blocked",
        blockerMetadata: {
          reason: "EXCESSIVE_EMPTY_RUNS",
          consecutiveEmptyRuns,
          lastRunId: input.runId,
          cause: input.classification.description,
          escalatedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));

    // 3. Записываем в журнал активности
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.runId,
      action: "issue.empty_run_escalated",
      entityType: "issue",
      entityId: input.issueId,
      details: {
        reason: "EXCESSIVE_EMPTY_RUNS",
        consecutiveEmptyRuns,
        lastRunId: input.runId,
        cause: input.classification.description,
      },
    });

    return {
      escalated: true,
      consecutiveEmptyRuns,
      shouldRewake: false,
      message: escalationReason,
    };
  }

  return {
    escalated: false,
    consecutiveEmptyRuns,
    shouldRewake: false,
  };
}

/**
 * 1.6.6 DEVEFF: Запись run-log событий для no-op и repeated-tool-error (OPE-10096).
 * События записываются в heartbeat_run_events и формируют неизменяемый след
 * для аналитики холостых прогонов и дашборда эффективности.
 */
export async function recordEmptyRunEvent(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    agentId: string;
    issueId?: string | null;
    classification: EmptyRunClassification;
    gateResult: CompletionGateResult;
  },
): Promise<void> {
  const isRepeatedError = input.classification.reason === "repeated_tool_errors";
  const eventType = isRepeatedError ? DEVEFF_EVENT_REPEATED_TOOL_ERROR : DEVEFF_EVENT_NO_OP;
  const level = isRepeatedError ? "warn" : "info";
  const message = isRepeatedError
    ? `DEVEFF stop rule: repeated tool error limit exceeded (${input.classification.description})`
    : `DEVEFF stop rule: empty run detected (${input.classification.description})`;

  const payload: Record<string, unknown> = {
    rule: isRepeatedError ? "repeated_tool_error" : "no_op",
    reason: input.classification.reason,
    description: input.classification.description,
    issueId: input.issueId ?? null,
    gateMet: input.gateResult.gateMet,
    gatePassed: input.gateResult.passed,
    gateReason: input.gateResult.reason,
  };

  try {
    await appendHeartbeatRunEvent(db, {
      companyId: input.companyId,
      runId: input.runId,
      agentId: input.agentId,
      eventType,
      level,
      message,
      payload,
    });
  } catch (_err) {
    // Non-fatal: run-log event failure must not crash execution settlement
  }
}

/**
 * 1.6.6 DEVEFF: Канонический SQL-запрос для дашборда метрик холостых прогонов (OPE-10096).
 * Считает долю пустых прогонов по агентам за 14 дней, разбивку по причинам
 * и прогресс относительно цели сокращения на 30%.
 */
export const DEVEFF_DASHBOARD_SQL_QUERY = `-- 14-day agent empty run and stop condition metrics dashboard query
WITH runs_14d AS (
  SELECT
    r.id AS run_id,
    r.company_id,
    r.agent_id,
    a.name AS agent_name,
    r.created_at,
    r.status,
    r.liveness_state,
    r.liveness_reason,
    COALESCE(r.native_issue_id::text, r.context_issue_id, r.context_snapshot->>'issueId') AS issue_id
  FROM heartbeat_runs r
  JOIN agents a ON a.id = r.agent_id
  WHERE r.company_id = :companyId
    AND r.created_at >= NOW() - INTERVAL '14 days'
    AND r.status IN ('succeeded', 'failed')
),
run_events_agg AS (
  SELECT
    run_id,
    BOOL_OR(event_type = 'run.deveff.no_op') AS has_no_op,
    BOOL_OR(event_type = 'run.deveff.repeated_tool_error') AS has_repeated_error
  FROM heartbeat_run_events
  WHERE company_id = :companyId
    AND created_at >= NOW() - INTERVAL '14 days'
    AND event_type IN ('run.deveff.no_op', 'run.deveff.repeated_tool_error')
  GROUP BY run_id
)
SELECT
  r.agent_id,
  r.agent_name,
  COUNT(r.run_id) AS total_runs,
  COUNT(r.run_id) FILTER (WHERE ev.has_no_op OR ev.has_repeated_error OR r.liveness_state = 'empty_response' OR r.liveness_reason ILIKE '%no file changes%' OR r.liveness_reason ILIKE '%Repeated tool failure%') AS empty_runs,
  COUNT(r.run_id) FILTER (WHERE ev.has_no_op OR r.liveness_reason ILIKE '%no file changes%') AS no_op_runs,
  COUNT(r.run_id) FILTER (WHERE ev.has_repeated_error OR r.liveness_reason ILIKE '%Repeated tool failure%') AS repeated_error_runs,
  ROUND(
    COUNT(r.run_id) FILTER (WHERE ev.has_no_op OR ev.has_repeated_error OR r.liveness_state = 'empty_response' OR r.liveness_reason ILIKE '%no file changes%' OR r.liveness_reason ILIKE '%Repeated tool failure%') * 100.0 / NULLIF(COUNT(r.run_id), 0),
    1
  ) AS empty_run_ratio_pct,
  ROUND(
    (COUNT(r.run_id) FILTER (WHERE ev.has_no_op OR ev.has_repeated_error OR r.liveness_state = 'empty_response' OR r.liveness_reason ILIKE '%no file changes%' OR r.liveness_reason ILIKE '%Repeated tool failure%') * 100.0 / NULLIF(COUNT(r.run_id), 0)) * 0.7,
    1
  ) AS target_ratio_pct
FROM runs_14d r
LEFT JOIN run_events_agg ev ON ev.run_id = r.run_id
GROUP BY r.agent_id, r.agent_name
ORDER BY empty_runs DESC, total_runs DESC;`;

export interface AgentEmptyRunStats {
  agentId: string;
  agentName: string;
  agentRole: string | null;
  totalRuns: number;
  emptyRuns: number;
  emptyRunRatio: number; // percentage (0 - 100)
  breakdown: {
    noChanges: number;
    repeatedToolErrors: number;
    emptyResponse: number;
  };
}

export interface CompanyEmptyRunStatsReport {
  companyId: string;
  periodDays: number;
  startDate: string;
  endDate: string;
  dashboardSqlQuery: string;
  summary: {
    totalRuns: number;
    emptyRuns: number;
    emptyRunRatio: number; // percentage
    targetReductionPercent: number; // 30%
  };
  agents: AgentEmptyRunStats[];
}

/**
 * 1.7 AGENT-RUNTIME: Расчет доли пустых прогонов по агентам за 14 дней (OPE-10066, пункт 2).
 */
export async function getCompanyEmptyRunStats(
  db: Db,
  input: {
    companyId: string;
    days?: number;
    agentId?: string;
  },
): Promise<CompanyEmptyRunStatsReport> {
  const periodDays = input.days ?? 14;
  const startDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const endDate = new Date();

  // Получаем список агентов компании
  const agentQuery = db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, input.companyId),
        input.agentId ? eq(agents.id, input.agentId) : undefined,
      ),
    );
  const companyAgents = await agentQuery;

  // Получаем завершённые прогоны за период
  const runs = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      livenessState: heartbeatRuns.livenessState,
      livenessReason: heartbeatRuns.livenessReason,
      resultJson: heartbeatRuns.resultJson,
      finishedAt: heartbeatRuns.finishedAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        input.agentId ? eq(heartbeatRuns.agentId, input.agentId) : undefined,
        gte(heartbeatRuns.finishedAt, startDate),
        inArray(heartbeatRuns.status, ["succeeded", "failed"]),
      ),
    );

  const agentMap = new Map<
    string,
    {
      totalRuns: number;
      emptyRuns: number;
      breakdown: { noChanges: number; repeatedToolErrors: number; emptyResponse: number };
    }
  >();

  for (const ag of companyAgents) {
    agentMap.set(ag.id, {
      totalRuns: 0,
      emptyRuns: 0,
      breakdown: { noChanges: 0, repeatedToolErrors: 0, emptyResponse: 0 },
    });
  }

  let totalCompanyRuns = 0;
  let totalCompanyEmptyRuns = 0;

  for (const run of runs) {
    totalCompanyRuns++;
    let stats = agentMap.get(run.agentId);
    if (!stats) {
      stats = {
        totalRuns: 0,
        emptyRuns: 0,
        breakdown: { noChanges: 0, repeatedToolErrors: 0, emptyResponse: 0 },
      };
      agentMap.set(run.agentId, stats);
    }
    stats.totalRuns++;

    // Классификация прогона
    const isRepeatedToolError =
      Boolean(run.livenessReason?.includes("Repeated tool failure")) ||
      Boolean(run.livenessReason?.includes("repeated tool error"));
    const isEmptyResponse = run.livenessState === "empty_response";
    const isNoChanges =
      Boolean(run.livenessReason?.includes("no file changes")) ||
      Boolean(run.livenessReason?.includes("no concrete action evidence"));

    const isEmpty = isRepeatedToolError || isEmptyResponse || isNoChanges;

    if (isEmpty) {
      stats.emptyRuns++;
      totalCompanyEmptyRuns++;

      if (isRepeatedToolError) {
        stats.breakdown.repeatedToolErrors++;
      } else if (isEmptyResponse) {
        stats.breakdown.emptyResponse++;
      } else {
        stats.breakdown.noChanges++;
      }
    }
  }

  const agentsResult: AgentEmptyRunStats[] = companyAgents.map((ag) => {
    const st = agentMap.get(ag.id) ?? {
      totalRuns: 0,
      emptyRuns: 0,
      breakdown: { noChanges: 0, repeatedToolErrors: 0, emptyResponse: 0 },
    };
    const ratio = st.totalRuns > 0 ? (st.emptyRuns / st.totalRuns) * 100 : 0;
    return {
      agentId: ag.id,
      agentName: ag.name,
      agentRole: ag.role,
      totalRuns: st.totalRuns,
      emptyRuns: st.emptyRuns,
      emptyRunRatio: Math.round(ratio * 10) / 10,
      breakdown: st.breakdown,
    };
  });

  const overallRatio =
    totalCompanyRuns > 0 ? (totalCompanyEmptyRuns / totalCompanyRuns) * 100 : 0;

  return {
    companyId: input.companyId,
    periodDays,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    dashboardSqlQuery: DEVEFF_DASHBOARD_SQL_QUERY,
    summary: {
      totalRuns: totalCompanyRuns,
      emptyRuns: totalCompanyEmptyRuns,
      emptyRunRatio: Math.round(overallRatio * 10) / 10,
      targetReductionPercent: 30,
    },
    agents: agentsResult,
  };
}

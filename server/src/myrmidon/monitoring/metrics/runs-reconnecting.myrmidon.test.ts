// server/src/myrmidon/monitoring/metrics/runs-reconnecting.myrmidon.test.ts
//
// myrmidon(1.6.6 rc.19 MONITORING OPE-10046):
// Unit and acceptance tests for runs execution phase metrics and reconnecting watchdog.

import { describe, expect, it, vi } from "vitest";
import type { ExecutionProjection } from "@myrmidon/shared";
import {
  computeRunsExecutionEvaluation,
  buildReconnectingRunsAlertTask,
  buildReconnectingRunsAlertEvent,
  buildReconnectingRunsResolvedEvent,
  createRunsReconnectingWatchdog,
  KNOWN_EXECUTION_PHASES,
  type LiveRunRecord,
} from "./runs-reconnecting.js";
import { projectExecution } from "../../../services/execution-projection.js";
import { renderMetricsText, type MetricsSnapshot } from "./metrics.js";

function makeRun(overrides: Partial<LiveRunRecord> = {}): LiveRunRecord {
  return {
    id: overrides.id ?? `run-${Math.random().toString(36).slice(2, 8)}`,
    companyId: overrides.companyId ?? "test-company",
    status: overrides.status ?? "running",
    startedAt: overrides.startedAt ?? new Date(),
    createdAt: overrides.createdAt ?? new Date(),
    lastConfirmedActivityAt: overrides.lastConfirmedActivityAt ?? null,
    lastUsefulActionAt: overrides.lastUsefulActionAt ?? null,
    lastOutputAt: overrides.lastOutputAt ?? null,
    lastEventAt: overrides.lastEventAt ?? null,
    updatedAt: overrides.updatedAt ?? new Date(),
    ...overrides,
  };
}

function makeProjection(
  phase: ExecutionProjection["phase"],
  lastConfirmedActivityAt: string | null = null,
): ExecutionProjection {
  return {
    phase,
    label: phase,
    cause: null,
    lastConfirmedActivityAt,
    retryAt: null,
    attempt: 1,
    maxAttempts: 3,
    recoveryOwner: null,
    nextAction: null,
    permittedActions: [],
  };
}

describe("1.6.6 rc.19 MONITORING OPE-10046: runs execution phase metrics and watchdog", () => {
  it("counts phases correctly and stays green when runs are working", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const run1 = makeRun({ id: "run-1" });
    const run2 = makeRun({ id: "run-2" });
    const runFinished = makeRun({ id: "run-3", status: "completed" });

    const projections = new Map<string, ExecutionProjection>([
      ["run-1", makeProjection("working", "2026-10-30T11:59:50Z")],
      ["run-2", makeProjection("working", "2026-10-30T11:59:55Z")],
    ]);

    const evalResult = computeRunsExecutionEvaluation(
      [run1, run2, runFinished],
      projections,
      now,
    );

    expect(evalResult.liveRunsCount).toBe(2);
    expect(evalResult.phaseCounts.working).toBe(2);
    expect(evalResult.phaseCounts.reconnecting).toBe(0);
    expect(evalResult.reconnectingRunsCount).toBe(0);
    expect(evalResult.reconnectingRatio).toBe(0);
    expect(evalResult.reconnectingOldestSeconds).toBe(0);
    expect(evalResult.firing).toBe(false);
    expect(evalResult.firingReason).toBeNull();
  });

  it("acceptance test: verifies projection transition on no-signal > 120s -> reconnecting and alert triggering", () => {
    const now = new Date("2026-10-30T12:00:00Z");

    // 1. Run active within 120s live signal window (signals 60s ago)
    const activeRun = makeRun({
      id: "run-active-1",
      status: "running",
      lastEventAt: new Date(now.getTime() - 60_000),
      lastOutputAt: new Date(now.getTime() - 60_000),
      updatedAt: new Date(now.getTime() - 60_000),
      startedAt: new Date(now.getTime() - 120_000),
    });
    const activeProjection = projectExecution(
      activeRun as any,
      undefined,
      [],
      undefined,
      now,
      { liveSignalWindowSec: 120 },
    );
    expect(activeProjection.phase).toBe("working");

    // 2. Run with silence > 120s (signals stopped 130s ago)
    const lastSignalDate = new Date(now.getTime() - 130_000);
    const stalledRun = makeRun({
      id: "run-stalled-1",
      status: "running",
      lastEventAt: lastSignalDate,
      lastOutputAt: lastSignalDate,
      updatedAt: lastSignalDate,
      startedAt: new Date(now.getTime() - 300_000),
    });

    // Real projection builder: no signals > 120s transitions to reconnecting
    const stalledProjection = projectExecution(
      stalledRun as any,
      undefined,
      [],
      undefined,
      now,
      { liveSignalWindowSec: 120 },
    );
    expect(stalledProjection.phase).toBe("reconnecting");
    expect(stalledProjection.label).toBe("Confirming execution");
    expect(stalledProjection.lastConfirmedActivityAt).toBe(
      lastSignalDate.toISOString(),
    );

    // 3. Both runs evaluated: working and reconnecting counts are visible in metric
    const evalResult = computeRunsExecutionEvaluation(
      [activeRun, stalledRun],
      new Map([
        [activeRun.id, activeProjection],
        [stalledRun.id, stalledProjection],
      ]),
      now,
      { liveSignalWindowSec: 120 },
    );

    expect(evalResult.liveRunsCount).toBe(2);
    expect(evalResult.phaseCounts.working).toBe(1);
    expect(evalResult.phaseCounts.reconnecting).toBe(1);
    expect(evalResult.reconnectingRunsCount).toBe(1);
    expect(evalResult.reconnectingOldestSeconds).toBe(130);
    expect(evalResult.reconnectingRuns).toHaveLength(1);
    expect(evalResult.reconnectingRuns[0].runId).toBe("run-stalled-1");

    // 4. Also verify computeRunsExecutionEvaluation derives projection directly when map is omitted
    const directEval = computeRunsExecutionEvaluation(
      [stalledRun],
      undefined,
      now,
      { liveSignalWindowSec: 120 },
    );
    expect(directEval.phaseCounts.reconnecting).toBe(1);
    expect(directEval.reconnectingOldestSeconds).toBe(130);
    expect(directEval.firing).toBe(true);
    expect(directEval.firingReason).toBe("ratio");

    // 5. Alert task and event include the stalled run ID
    const alertTask = buildReconnectingRunsAlertTask(
      directEval,
      "test-company",
      now,
    );
    expect(alertTask.priority).toBe("high");
    expect(alertTask.title).toContain("run-stalled-1");
    expect(alertTask.description).toContain("run-stalled-1");
    expect(alertTask.idempotencyKey).toBe(
      "monitoring:runs-reconnecting:test-company",
    );

    const alertEvent = buildReconnectingRunsAlertEvent(
      directEval,
      "test-company",
      now,
    );
    expect(alertEvent.status).toBe("firing");
    expect(alertEvent.trigger).toBe("runs-reconnecting");
    expect(alertEvent.summary).toContain("run-stalled-1");
  });

  it("consistently determines reconnecting duration using latest activity timestamp across all fields", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    // Run started 10m ago, last confirmed activity 8m ago, but last output 4m (240s) ago
    const run = makeRun({
      id: "run-mixed-activity",
      status: "running",
      startedAt: new Date(now.getTime() - 600_000),
      lastConfirmedActivityAt: new Date(now.getTime() - 480_000),
      lastOutputAt: new Date(now.getTime() - 240_000),
      updatedAt: new Date(now.getTime() - 240_000),
    });

    const projection = projectExecution(
      run as any,
      undefined,
      [],
      undefined,
      now,
      { liveSignalWindowSec: 120 },
    );
    expect(projection.phase).toBe("reconnecting");

    const evalResult = computeRunsExecutionEvaluation([run], undefined, now, {
      liveSignalWindowSec: 120,
    });
    // Age must be based on the most recent activity (240s), not an older 480s fallback
    expect(evalResult.reconnectingOldestSeconds).toBe(240);
    expect(evalResult.reconnectingRuns[0].reconnectingSeconds).toBe(240);
  });

  it("triggers alert when at least 3 runs are in reconnecting for > 5 minutes (even if <= 50% of total)", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const runs: LiveRunRecord[] = [];
    const projections = new Map<string, ExecutionProjection>();

    // 3 runs hanging for 350s, 400s, 500s (> 300s / 5 min)
    for (let i = 1; i <= 3; i++) {
      const runId = `reconnecting-run-${i}`;
      const activity = new Date(now.getTime() - (300 + i * 50) * 1000).toISOString();
      runs.push(makeRun({ id: runId }));
      projections.set(runId, makeProjection("reconnecting", activity));
    }

    // 7 runs healthy (total 10 live runs, 3 reconnecting = 30% <= 50%)
    for (let i = 1; i <= 7; i++) {
      const runId = `healthy-run-${i}`;
      runs.push(makeRun({ id: runId }));
      projections.set(runId, makeProjection("working", now.toISOString()));
    }

    const evalResult = computeRunsExecutionEvaluation(runs, projections, now);

    expect(evalResult.liveRunsCount).toBe(10);
    expect(evalResult.reconnectingRunsCount).toBe(3);
    expect(evalResult.reconnectingRatio).toBe(0.3); // <= 50%
    expect(evalResult.reconnectingOldestSeconds).toBe(450); // 300 + 3 * 50

    // Condition 1 triggers: >= 3 runs in reconnecting for >= 300s
    expect(evalResult.firing).toBe(true);
    expect(evalResult.firingReason).toBe("count_and_age");

    const event = buildReconnectingRunsAlertEvent(
      evalResult,
      "test-company",
      now,
    );
    expect(event.summary).toContain("reconnecting-run-1");
    expect(event.summary).toContain("reconnecting-run-2");
    expect(event.summary).toContain("reconnecting-run-3");
  });

  it("does not fire when reconnecting runs are fewer than 3 and ratio is <= 50%", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const runs: LiveRunRecord[] = [];
    const projections = new Map<string, ExecutionProjection>();

    // 2 runs hanging for 400s (> 300s, but count is 2 < 3)
    for (let i = 1; i <= 2; i++) {
      const runId = `stalled-${i}`;
      const activity = new Date(now.getTime() - 400_000).toISOString();
      runs.push(makeRun({ id: runId }));
      projections.set(runId, makeProjection("reconnecting", activity));
    }

    // 6 healthy runs (total 8 runs, 2/8 = 25% <= 50%)
    for (let i = 1; i <= 6; i++) {
      const runId = `healthy-${i}`;
      runs.push(makeRun({ id: runId }));
      projections.set(runId, makeProjection("working", now.toISOString()));
    }

    const evalResult = computeRunsExecutionEvaluation(runs, projections, now);
    expect(evalResult.firing).toBe(false);
    expect(evalResult.firingReason).toBeNull();
  });

  it("renders both gauges in Prometheus text exposition format", () => {
    const snapshot: MetricsSnapshot = {
      role: "all",
      runsExecutionPhase: [
        { phase: "working", count: 8 },
        { phase: "reconnecting", count: 2 },
        { phase: "finishing", count: 1 },
        { phase: "retry_scheduled", count: 0 },
        { phase: "recovery_needed", count: 0 },
      ],
      runsReconnectingOldestSeconds: 145,
    };

    const rendered = renderMetricsText(snapshot);

    expect(rendered).toContain("# HELP myrmidon_runs_execution_phase");
    expect(rendered).toContain("# TYPE myrmidon_runs_execution_phase gauge");
    expect(rendered).toContain(
      'myrmidon_runs_execution_phase{role="all",phase="working"} 8',
    );
    expect(rendered).toContain(
      'myrmidon_runs_execution_phase{role="all",phase="reconnecting"} 2',
    );
    expect(rendered).toContain(
      'myrmidon_runs_execution_phase{role="all",phase="finishing"} 1',
    );

    expect(rendered).toContain(
      "# HELP myrmidon_runs_reconnecting_oldest_seconds",
    );
    expect(rendered).toContain(
      "# TYPE myrmidon_runs_reconnecting_oldest_seconds gauge",
    );
    expect(rendered).toContain(
      'myrmidon_runs_reconnecting_oldest_seconds{role="all"} 145',
    );
  });

  it("watchdog sweep raises and resolves alert", async () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const sendAlertEvent = vi.fn().mockResolvedValue(undefined);
    const closeAlert = vi.fn().mockResolvedValue(true);

    let stalled = true;

    const watchdog = createRunsReconnectingWatchdog({
      listLiveRuns: async () => [
        makeRun({ id: "run-wd-1", companyId: "c-1" }),
      ],
      getProjections: async (_cid, _rids, _now) => {
        return new Map<string, ExecutionProjection>([
          [
            "run-wd-1",
            makeProjection(
              stalled ? "reconnecting" : "working",
              new Date(now.getTime() - 200_000).toISOString(),
            ),
          ],
        ]);
      },
      sendAlertEvent,
      closeAlert,
    });

    // First sweep: stalled -> firing
    const sweep1 = await watchdog.sweep(now);
    expect(sweep1.firingCount).toBe(1);
    expect(sendAlertEvent).toHaveBeenCalledTimes(1);
    expect(sendAlertEvent.mock.calls[0][0].status).toBe("firing");
    expect(sendAlertEvent.mock.calls[0][0].trigger).toBe("runs-reconnecting");
    expect(sendAlertEvent.mock.calls[0][0].summary).toContain("run-wd-1");

    // Second sweep: run recovered -> resolved
    stalled = false;
    const sweep2 = await watchdog.sweep(now);
    expect(sweep2.firingCount).toBe(0);
    expect(sendAlertEvent).toHaveBeenCalledTimes(2);
    expect(sendAlertEvent.mock.calls[1][0].status).toBe("resolved");
    expect(sendAlertEvent.mock.calls[1][0].trigger).toBe("runs-reconnecting");
  });
});

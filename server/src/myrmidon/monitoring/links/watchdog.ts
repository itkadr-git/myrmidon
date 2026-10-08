// server/src/myrmidon/monitoring/links/watchdog.ts
//
// myrmidon(1.6.6 MONITORING E): the periodic "is every link still alive" pass.
//
// The pass is deliberately on the *board* side. The incident this issue comes
// from was not only a dead key: the Zabbix-side alarm also never fired, because
// the channel that carried its silence had no owner. A watchdog that lives in
// the board and raises the High task itself survives a dead alert channel, a
// dead key and a dead link alike.
//
// Detection latency is a budget, not an accident:
//   - a revoked or expired key is detected on the first pass after it dies;
//   - a link that stopped pulsing is detected one `staleAfterSec` after its
//     last pulse.
// The default thresholds (60s pass, 480s stale) keep the worst case at ~9 min,
// inside the 10-minute acceptance the issue asks for. The tests pin exactly
// that arithmetic with a fake clock.

import type { Logger } from "pino";
import { logger } from "../../../middleware/logger.js";
import {
  buildMonitoringLinkAlertTask,
  recoveryComment,
  type MonitoringLinkAlertTask,
} from "./alert.js";
import {
  MONITORING_LINK_ALERT_VERDICTS,
  evaluateMonitoringLinks,
  monitoringLinkAlertIdempotencyKey,
  type MonitoringLinkHealth,
  type MonitoringLinkKeyRow,
} from "./health.js";

/**
 * One pass per minute. With the default 480s stale threshold this puts the
 * worst-case detection of a link that went quiet at 540s < 600s.
 */
export const DEFAULT_MONITORING_LINK_SWEEP_INTERVAL_SEC = 60;
export const MIN_MONITORING_LINK_SWEEP_INTERVAL_SEC = 15;
export const MAX_MONITORING_LINK_SWEEP_INTERVAL_SEC = 3600;

export interface MonitoringLinkAlertRef {
  id: string;
  identifier?: string | null;
  /** The task's status after the create/dedup, so the watchdog can see a stale alarm. */
  status?: string | null;
}

export interface MonitoringLinkWatchdogDeps {
  listLinks(): Promise<MonitoringLinkKeyRow[]>;
  resolveAlertAssignee(companyId: string): Promise<string | null>;
  createAlert(companyId: string, task: MonitoringLinkAlertTask): Promise<MonitoringLinkAlertRef>;
  /**
   * Closes the alarm the given idempotency key opened, when it is still open.
   * Returns true when a task was actually closed.
   */
  closeAlert?(companyId: string, idempotencyKey: string, comment: string): Promise<boolean>;
  /**
   * Reopens an alarm a human closed while the link is still unhealthy. Without
   * this, closing the task would buy permanent silence for a broken link —
   * the outcome this watchdog exists to make impossible.
   */
  reopenAlert?(companyId: string, issueId: string, comment: string): Promise<void>;
  intervalMs?: number;
  now?(): Date;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

export interface MonitoringLinkSweepResult {
  skipped: boolean;
  inspected: number;
  alerted: number;
  reopened: number;
  recovered: number;
  failed: number;
  links: MonitoringLinkHealth[];
}

export interface MonitoringLinkWatchdog {
  sweep(now?: Date, options?: { force?: boolean }): Promise<MonitoringLinkSweepResult>;
  resetForTest(): void;
}

const SKIPPED: MonitoringLinkSweepResult = {
  skipped: true,
  inspected: 0,
  alerted: 0,
  reopened: 0,
  recovered: 0,
  failed: 0,
  links: [],
};

export function createMonitoringLinkWatchdog(
  deps: MonitoringLinkWatchdogDeps,
): MonitoringLinkWatchdog {
  const log = deps.log ?? logger;
  const intervalMs =
    deps.intervalMs ?? DEFAULT_MONITORING_LINK_SWEEP_INTERVAL_SEC * 1000;
  const clock = deps.now ?? (() => new Date());
  let lastRunAtMs: number | null = null;

  async function sweep(
    now: Date = clock(),
    options: { force?: boolean } = {},
  ): Promise<MonitoringLinkSweepResult> {
    if (
      !options.force &&
      lastRunAtMs !== null &&
      now.getTime() - lastRunAtMs < intervalMs
    ) {
      return SKIPPED;
    }
    lastRunAtMs = now.getTime();

    let rows: MonitoringLinkKeyRow[];
    try {
      rows = await deps.listLinks();
    } catch (err) {
      log.error({ err }, "monitoring link sweep could not read link keys");
      return { ...SKIPPED, skipped: false, failed: 1 };
    }

    const links = evaluateMonitoringLinks(rows, now);
    let alerted = 0;
    let reopened = 0;
    let recovered = 0;
    let failed = 0;

    for (const link of links) {
      try {
        if (link.unhealthy) {
          const assignee = await deps.resolveAlertAssignee(link.companyId);
          const task = buildMonitoringLinkAlertTask(link, {
            assigneeAgentId: assignee,
            now,
          });
          const created = await deps.createAlert(link.companyId, task);
          alerted += 1;
          const closedAgain =
            created.status === "done" || created.status === "cancelled";
          if (closedAgain && deps.reopenAlert) {
            await deps.reopenAlert(link.companyId, created.id, task.description);
            reopened += 1;
          }
          log.warn(
            {
              linkKey: link.linkKey,
              verdict: link.verdict,
              keyState: link.keyState,
              pulseAgeSec: link.pulseAgeSec,
              issueId: created.id,
              identifier: created.identifier ?? null,
              reopened: closedAgain,
            },
            closedAgain
              ? "monitoring link alarm was closed while the link is still blind; reopened"
              : "monitoring link alarm raised",
          );
          continue;
        }
        if (!deps.closeAlert) continue;
        for (const verdict of MONITORING_LINK_ALERT_VERDICTS) {
          const closed = await deps.closeAlert(
            link.companyId,
            monitoringLinkAlertIdempotencyKey(link.keyId, verdict),
            recoveryComment(link, now),
          );
          if (closed) {
            recovered += 1;
            log.info(
              { linkKey: link.linkKey, verdict },
              "monitoring link alarm cleared",
            );
          }
        }
      } catch (err) {
        // One broken link must not stop the pass for the others: a watchdog
        // that dies on its first bad row is the same silence it watches for.
        failed += 1;
        log.error({ err, linkKey: link.linkKey }, "monitoring link sweep failed for link");
      }
    }

    return {
      skipped: false,
      inspected: links.length,
      alerted,
      reopened,
      recovered,
      failed,
      links,
    };
  }

  return { sweep, resetForTest: () => { lastRunAtMs = null; } };
}
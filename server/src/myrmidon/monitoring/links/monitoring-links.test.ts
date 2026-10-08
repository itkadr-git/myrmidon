// server/src/myrmidon/monitoring/links/monitoring-links.test.ts
//
// myrmidon(1.6.6 MONITORING E): the acceptance test the issue asks for is in
// here — "an expired key raises the High alarm within ten minutes". It runs in
// milliseconds because the module takes the clock as an argument, and the
// simulated ticks are the real scheduler ticks (30s), so what passes here is
// the arithmetic the instance actually runs.
//
// The rest of the file pins the rules a live watchdog depends on: which
// verdict wins when several things are wrong, one open task per (link, reason),
// recovery closing the alarm, a human-closed alarm being reopened while the
// link is still blind, and one broken link not stopping the pass for the rest.

import { describe, expect, it, vi } from "vitest";
import {
  evaluateMonitoringLink,
  evaluateMonitoringLinks,
  monitoringLinkAlertIdempotencyKey,
  monitoringLinkKeyState,
  monitoringLinkPulseBaseline,
  type MonitoringLinkKeyRow,
} from "./health.js";
import {
  buildMonitoringLinkAlertTask,
  recoveryComment,
  type MonitoringLinkAlertTask,
} from "./alert.js";
import {
  createMonitoringLinkWatchdog,
  DEFAULT_MONITORING_LINK_SWEEP_INTERVAL_SEC,
  type MonitoringLinkAlertRef,
  type MonitoringLinkWatchdogDeps,
} from "./watchdog.js";

const COMPANY = "2870b911-483a-4091-9f15-183841811143";
const OTHER_COMPANY = "11111111-2222-3333-4444-555555555555";
const ISSUE_PRIORITY_HIGH = "high";
// The board's heartbeat scheduler ticks every 30s by default (config.ts:
// HEARTBEAT_SCHEDULER_INTERVAL_MS, floor 10s).
const SCHEDULER_TICK_MS = 30_000;
// The budget the issue sets: a dead link must be visible within ten minutes.
const DETECTION_BUDGET_MS = 10 * 60_000;

const T0 = new Date("2026-10-07T04:00:00.000Z");

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

function linkRow(overrides: Partial<MonitoringLinkKeyRow> = {}): MonitoringLinkKeyRow {
  return {
    keyId: "key-1",
    keyName: "zabbix-aggregator link key",
    scope: {
      kind: "monitoring_link",
      linkKey: "zabbix-aggregator",
      companyId: COMPANY,
      staleAfterSec: 480,
      alertAssigneeAgentId: null,
    },
    createdAt: at(-3600),
    lastUsedAt: at(-5),
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe("monitoring link liveness (myrmidon 1.6.6 MONITORING E)", () => {
  describe("key state", () => {
    it("is ok while the key is neither revoked nor past its expiry", () => {
      expect(monitoringLinkKeyState(linkRow(), at(0))).toBe("ok");
      expect(
        monitoringLinkKeyState(linkRow({ expiresAt: at(600) }), at(0)),
      ).toBe("ok");
    });

    it("is expired from the expiry instant, not after it", () => {
      expect(
        monitoringLinkKeyState(linkRow({ expiresAt: at(0) }), at(0)),
      ).toBe("expired");
      expect(
        monitoringLinkKeyState(linkRow({ expiresAt: at(-1) }), at(0)),
      ).toBe("expired");
    });

    it("prefers revoked over expired: the stronger fact wins", () => {
      const row = linkRow({ expiresAt: at(-10), revokedAt: at(-5) });
      expect(monitoringLinkKeyState(row, at(0))).toBe("revoked");
    });
  });

  describe("verdicts", () => {
    it("calls a live, recently used link healthy", () => {
      const health = evaluateMonitoringLink(linkRow(), at(0));
      expect(health.verdict).toBe("healthy");
      expect(health.unhealthy).toBe(false);
      expect(health.lastPulseAt).toBe(at(-5).toISOString());
      expect(health.pulseAgeSec).toBe(5);
    });

    it("calls an expired key blind even while the link still talks", () => {
      // The incident's shape: the link keeps trying, the key is dead, so every
      // request is a 401 and its surface is dark.
      const health = evaluateMonitoringLink(
        linkRow({ expiresAt: at(-30), lastUsedAt: at(-2) }),
        at(0),
      );
      expect(health.verdict).toBe("key_expired");
      expect(health.keyState).toBe("expired");
      expect(health.unhealthy).toBe(true);
    });

    it("calls a revoked key blind", () => {
      expect(
        evaluateMonitoringLink(linkRow({ revokedAt: at(-60) }), at(0)).verdict,
      ).toBe("key_revoked");
    });

    it("calls a silent link blind exactly past the threshold", () => {
      const silent = linkRow({ lastUsedAt: at(-480) });
      expect(evaluateMonitoringLink(silent, at(0)).verdict).toBe("healthy");
      const late = linkRow({ lastUsedAt: at(-481) });
      expect(evaluateMonitoringLink(late, at(0)).verdict).toBe("no_pulse");
      expect(evaluateMonitoringLink(late, at(0)).unhealthy).toBe(true);
    });

    it("counts a never-used key from its issue time, so an unwired link alarms", () => {
      const unwired = linkRow({ lastUsedAt: null, createdAt: at(-(481)) });
      expect(monitoringLinkPulseBaseline(unwired)).toEqual(at(-481));
      const health = evaluateMonitoringLink(unwired, at(0));
      expect(health.lastPulseAt).toBeNull();
      expect(health.verdict).toBe("no_pulse");
    });

    it("ranks the dead key above the silence when both are true", () => {
      const both = linkRow({ expiresAt: at(-3600), lastUsedAt: at(-7200) });
      expect(evaluateMonitoringLink(both, at(0)).verdict).toBe("key_expired");
    });

    it("sorts the feed by link key so an operator reads a stable list", () => {
      const feed = evaluateMonitoringLinks(
        [
          linkRow({ keyId: "b", scope: { ...linkRow().scope, linkKey: "zabbix-aggregator" } }),
          linkRow({ keyId: "a", scope: { ...linkRow().scope, linkKey: "alertmanager-webhook" } }),
          linkRow({ keyId: "c", scope: { ...linkRow().scope, linkKey: "collector-runners" } }),
        ],
        at(0),
      );
      expect(feed.map((entry) => entry.linkKey)).toEqual([
        "alertmanager-webhook",
        "collector-runners",
        "zabbix-aggregator",
      ]);
    });
  });

  describe("alert task", () => {
    it("is a High task on the board, one per link and reason", () => {
      const health = evaluateMonitoringLink(linkRow({ expiresAt: at(-60) }), at(0));
      const task = buildMonitoringLinkAlertTask(health, {
        assigneeAgentId: "agent-observability",
        now: at(0),
      });

      expect(task.priority).toBe(ISSUE_PRIORITY_HIGH);
      expect(task.status).toBe("todo");
      expect(task.assigneeAgentId).toBe("agent-observability");
      expect(task.originKind).toBe("manual");
      expect(task.title).toContain("zabbix-aggregator");
      expect(task.title).toContain("протух");
      expect(task.idempotencyKey).toBe(
        monitoringLinkAlertIdempotencyKey("key-1", "key_expired"),
      );
      // The description has to say what to do, not only that something broke.
      expect(task.description).toContain("monitoring_link");
      expect(task.description).toContain("Порог пульса");
    });

    it("keeps a different reason on a different task", () => {
      const expired = buildMonitoringLinkAlertTask(
        evaluateMonitoringLink(linkRow({ expiresAt: at(-60) }), at(0)),
        { now: at(0) },
      );
      const silent = buildMonitoringLinkAlertTask(
        evaluateMonitoringLink(linkRow({ lastUsedAt: at(-600) }), at(0)),
        { now: at(0) },
      );
      expect(expired.idempotencyKey).not.toBe(silent.idempotencyKey);
      expect(silent.title).toContain("пульс");
    });

    it("omits the assignee when the company has no observability agent", () => {
      const task = buildMonitoringLinkAlertTask(
        evaluateMonitoringLink(linkRow({ revokedAt: at(-1) }), at(0)),
        { assigneeAgentId: null, now: at(0) },
      );
      expect(task).not.toHaveProperty("assigneeAgentId");
    });

    it("words the recovery comment so the auto-close is not a mystery", () => {
      const comment = recoveryComment(evaluateMonitoringLink(linkRow(), at(0)), at(0));
      expect(comment).toContain("zabbix-aggregator");
      expect(comment).toContain("снова на связи");
    });
  });

  describe("the acceptance criterion: an expired key alarms within ten minutes", () => {
    /**
     * Runs the watchdog on a simulated heartbeat scheduler: a pass is offered
     * every 30s, each pass is gated by the watchdog's own default interval,
     * and the first pass that alerts is reported. This is the loop the
     * instance runs; only the clock is compressed.
     */
    async function firstAlarmMs(
      row: MonitoringLinkKeyRow,
      startMs: number,
      horizonMs = 30 * 60_000,
    ): Promise<{ alarmedAtMs: number; task: any; passes: number }> {
      const created: any[] = [];
      const deps: MonitoringLinkWatchdogDeps = {
        listLinks: async () => [row],
        resolveAlertAssignee: async () => "agent-observability",
        createAlert: async (_companyId, task) => {
          created.push(task);
          return { id: `issue-${created.length}`, identifier: `OPE-${created.length}` };
        },
        log: { info: () => {}, warn: () => {}, error: () => {} } as any,
      };
      const watchdog = createMonitoringLinkWatchdog(deps);

      let passes = 0;
      for (let elapsed = 0; elapsed <= horizonMs; elapsed += SCHEDULER_TICK_MS) {
        passes += 1;
        const result = await watchdog.sweep(new Date(startMs + elapsed));
        if (result.alerted > 0) {
          return { alarmedAtMs: startMs + elapsed, task: created[0], passes };
        }
      }
      return { alarmedAtMs: Number.POSITIVE_INFINITY, task: null, passes };
    }

    it("fires for a key that expires mid-flight", async () => {
      // The key is alive now and dies 2 minutes from now — the incident's
      // exact shape (a key that expires while the link keeps running).
      const row = linkRow({ expiresAt: at(120), lastUsedAt: at(-5) });
      const { alarmedAtMs, task } = await firstAlarmMs(row, T0.getTime());
      const latencyMs = alarmedAtMs - at(120).getTime();

      expect(task.priority).toBe(ISSUE_PRIORITY_HIGH);
      expect(task.idempotencyKey).toContain("key_expired");
      expect(latencyMs).toBeLessThanOrEqual(DETECTION_BUDGET_MS);
      // …and it is not instant by accident: the watchdog waits for the key to
      // actually be past its expiry before crying wolf.
      expect(latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("fires for a link that simply stops pulsing", async () => {
      const row = linkRow({ lastUsedAt: T0, expiresAt: null });
      const { alarmedAtMs, task } = await firstAlarmMs(row, T0.getTime());
      const latencyMs = alarmedAtMs - at(480).getTime();

      expect(task.idempotencyKey).toContain("no_pulse");
      expect(latencyMs).toBeLessThanOrEqual(DETECTION_BUDGET_MS);
    });

    it("keeps the documented budget arithmetic honest", () => {
      // staleAfterSec (480) + sweep gate (60) + scheduler tick (30) = 570s,
      // which is why the default threshold is 480 and not, say, 900.
      const worstCaseSec =
        linkRow().scope.staleAfterSec +
        DEFAULT_MONITORING_LINK_SWEEP_INTERVAL_SEC +
        SCHEDULER_TICK_MS / 1000;
      expect(worstCaseSec * 1000).toBeLessThanOrEqual(DETECTION_BUDGET_MS);
    });
  });

  describe("sweep behaviour", () => {
    function fakeDeps(overrides: Partial<MonitoringLinkWatchdogDeps> = {}) {
      const calls = {
        createAlert: vi.fn(
          async (_companyId: string, _task: MonitoringLinkAlertTask): Promise<MonitoringLinkAlertRef> => ({
            id: "issue-1",
            identifier: "OPE-1",
            status: "todo",
          }),
        ),
        closeAlert: vi.fn(async () => false),
        reopenAlert: vi.fn(async () => {}),
        resolveAlertAssignee: vi.fn(async () => "agent-observability"),
      };
      const deps: MonitoringLinkWatchdogDeps = {
        listLinks: async () => [linkRow()],
        resolveAlertAssignee: calls.resolveAlertAssignee,
        createAlert: calls.createAlert,
        closeAlert: calls.closeAlert,
        reopenAlert: calls.reopenAlert,
        log: { info: () => {}, warn: () => {}, error: () => {} } as any,
        ...overrides,
      };
      return { deps, calls };
    }

    it("skips a pass that arrives inside its own interval, unless forced", async () => {
      const { deps, calls } = fakeDeps();
      const watchdog = createMonitoringLinkWatchdog(deps);

      const first = await watchdog.sweep(at(0));
      expect(first.skipped).toBe(false);

      const second = await watchdog.sweep(at(10));
      expect(second.skipped).toBe(true);
      expect(calls.createAlert).not.toHaveBeenCalled();

      // A forced pass is real work, so it starts the next interval.
      const forced = await watchdog.sweep(at(10), { force: true });
      expect(forced.skipped).toBe(false);

      const third = await watchdog.sweep(at(60));
      expect(third.skipped).toBe(true);

      const fourth = await watchdog.sweep(at(70));
      expect(fourth.skipped).toBe(false);
    });

    it("does not repeat the alert on the next pass while the link is still blind", async () => {
      // Idempotency lives in the board's own ledger, so the sweep keeps trying
      // every minute without spamming humans: the same key maps to the same
      // open task (asserted by the shared key, exercised end to end in the
      // middleware/HTTP tests).
      const { deps, calls } = fakeDeps({
        listLinks: async () => [linkRow({ expiresAt: at(-60) })],
      });
      const watchdog = createMonitoringLinkWatchdog(deps);
      await watchdog.sweep(at(0));
      await watchdog.sweep(at(60));
      expect(calls.createAlert).toHaveBeenCalledTimes(2);
      // The task is the second argument: the first is the company id, which is
      // why a bare `[task]` here would have compared two company ids and passed
      // for the wrong reason (caught by the server typecheck in CI).
      const [, firstTask] = calls.createAlert.mock.calls[0];
      const [, secondTask] = calls.createAlert.mock.calls[1];
      expect(firstTask.idempotencyKey).toBe(secondTask.idempotencyKey);
    });

    it("resolves the observability owner per link company", async () => {
      const { deps, calls } = fakeDeps({
        listLinks: async () => [
          linkRow({ expiresAt: at(-60) }),
          linkRow({
            keyId: "key-2",
            expiresAt: at(-60),
            scope: {
              kind: "monitoring_link",
              linkKey: "collector-runners",
              companyId: OTHER_COMPANY,
              staleAfterSec: 480,
              alertAssigneeAgentId: null,
            },
          }),
        ],
      });
      const watchdog = createMonitoringLinkWatchdog(deps);
      await watchdog.sweep(at(0));
      expect(calls.resolveAlertAssignee).toHaveBeenCalledWith(COMPANY);
      expect(calls.resolveAlertAssignee).toHaveBeenCalledWith(OTHER_COMPANY);
      expect(calls.createAlert).toHaveBeenCalledTimes(2);
    });

    it("closes every alarm a recovered link had opened", async () => {
      const { deps, calls } = fakeDeps({ listLinks: async () => [linkRow()] });
      calls.closeAlert.mockResolvedValue(true);
      const watchdog = createMonitoringLinkWatchdog(deps);

      const result = await watchdog.sweep(at(0));
      expect(result.recovered).toBe(3); // revoked, expired, no_pulse
      expect(calls.createAlert).not.toHaveBeenCalled();
      const keys = calls.closeAlert.mock.calls.map((call: any) => call[1]);
      expect(keys).toEqual([
        monitoringLinkAlertIdempotencyKey("key-1", "key_revoked"),
        monitoringLinkAlertIdempotencyKey("key-1", "key_expired"),
        monitoringLinkAlertIdempotencyKey("key-1", "no_pulse"),
      ]);
    });

    it("reopens an alarm a human closed while the link is still blind", async () => {
      const { deps, calls } = fakeDeps({
        listLinks: async () => [linkRow({ expiresAt: at(-60) })],
      });
      calls.createAlert.mockResolvedValue({ id: "issue-9", identifier: "OPE-9", status: "done" });
      const watchdog = createMonitoringLinkWatchdog(deps);

      const result = await watchdog.sweep(at(0));
      expect(result.reopened).toBe(1);
      expect(calls.reopenAlert).toHaveBeenCalledTimes(1);
      const [companyId, issueId, comment] = calls.reopenAlert.mock.calls[0] as any;
      expect(companyId).toBe(COMPANY);
      expect(issueId).toBe("issue-9");
      expect(comment).toContain("протух");
    });

    it("keeps going when one link throws and reports it", async () => {
      const { deps, calls } = fakeDeps({
        listLinks: async () => [
          linkRow({ keyId: "bad", expiresAt: at(-60) }),
          linkRow({ keyId: "good", expiresAt: at(-60) }),
        ],
      });
      calls.resolveAlertAssignee.mockImplementation(async () => {
        throw new Error("assignee lookup exploded");
      });
      const watchdog = createMonitoringLinkWatchdog(deps);

      const result = await watchdog.sweep(at(0));
      expect(result.inspected).toBe(2);
      expect(result.failed).toBe(2);
      expect(result.alerted).toBe(0);
    });

    it("reports a read failure instead of throwing into the scheduler", async () => {
      const { deps } = fakeDeps({
        listLinks: async () => {
          throw new Error("db is down");
        },
      });
      const watchdog = createMonitoringLinkWatchdog(deps);
      const result = await watchdog.sweep(at(0));
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(false);
      expect(result.links).toEqual([]);
    });
  });
});
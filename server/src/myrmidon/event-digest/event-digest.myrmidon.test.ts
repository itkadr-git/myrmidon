import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EventDigestService,
  classifyEventPriority,
  isDigestAccumulatedPriority,
  isImmediateWakePriority,
  EVENT_PRIORITY_BY_TYPE,
  type AgentEvent,
} from "./index.js";

describe("WAKE-10.2: Event Digest and Priority Wake", () => {
  let service: EventDigestService;
  let wakeupMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    service = new EventDigestService();
    wakeupMock = vi.fn().mockResolvedValue({ success: true });
  });

  describe("Acceptance Criterion: P4 does not wake, P0 wakes, digest delivered", () => {
    it("accumulates P4 events without waking, wakes on P0, and delivers the accumulated digest", async () => {
      const agentId = "agent-dev-1";

      // 1. Send P4 event (heartbeat)
      const p4Event: AgentEvent = {
        agentId,
        type: "heartbeat",
        payload: { status: "alive", seq: 1 },
      };

      const p4Result = await service.handleAgentEvent(p4Event, {
        wakeup: wakeupMock,
      });

      // P4 must NOT wake the agent
      expect(p4Result.woken).toBe(false);
      expect(wakeupMock).not.toHaveBeenCalled();

      // P4 event must be accumulated into pending digest
      const pendingAfterP4 = service.getPendingDigest(agentId);
      expect(pendingAfterP4).not.toBeNull();
      expect(pendingAfterP4?.eventCount).toBe(1);
      expect(pendingAfterP4?.events[0]?.type).toBe("heartbeat");
      expect(pendingAfterP4?.events[0]?.priority).toBe("P4");

      // 2. Send another low-priority event (P3: progress)
      const p3Event: AgentEvent = {
        agentId,
        type: "progress",
        payload: { step: "syncing", percent: 50 },
      };

      const p3Result = await service.handleAgentEvent(p3Event, {
        wakeup: wakeupMock,
      });

      // P3 must NOT wake the agent
      expect(p3Result.woken).toBe(false);
      expect(wakeupMock).not.toHaveBeenCalled();

      // Both events should now be accumulated in the digest
      const pendingAfterP3 = service.getPendingDigest(agentId);
      expect(pendingAfterP3?.eventCount).toBe(2);

      // 3. Send P0 event (security incident / emergency)
      const p0Event: AgentEvent = {
        agentId,
        type: "security_incident",
        payload: { alert: "unauthorized_access", severity: "critical" },
      };

      const p0Result = await service.handleAgentEvent(p0Event, {
        wakeup: wakeupMock,
      });

      // P0 MUST wake the agent immediately
      expect(p0Result.woken).toBe(true);
      expect(wakeupMock).toHaveBeenCalledTimes(1);

      // Verify that wakeup received the accumulated digest with all prior low-priority events
      const [calledAgentId, calledContext] = wakeupMock.mock.calls[0];
      expect(calledAgentId).toBe(agentId);
      expect(calledContext.wakeReason).toBe("security_incident");
      expect(calledContext.priority).toBe("P0");

      const deliveredDigest = calledContext.eventDigest;
      expect(deliveredDigest).toBeDefined();
      expect(deliveredDigest.eventCount).toBe(3);
      expect(deliveredDigest.events).toHaveLength(3);

      // Verify events in delivered digest
      const types = deliveredDigest.events.map((e: any) => e.type);
      expect(types).toEqual(["heartbeat", "progress", "security_incident"]);

      // Verify delivered digest is drained from pending buffer
      expect(service.getPendingDigest(agentId)).toBeNull();
    });
  });

  describe("P1 immediate wake", () => {
    it("wakes immediately on P1 and delivers pending low-priority digest", async () => {
      const agentId = "agent-dev-2";

      // Send P4 log
      await service.handleAgentEvent(
        { agentId, type: "log", payload: { msg: "debug log" } },
        { wakeup: wakeupMock },
      );
      expect(wakeupMock).not.toHaveBeenCalled();

      // Send P1 ci_completed
      const ciResult = await service.handleAgentEvent(
        { agentId, type: "ci_completed", payload: { pr: 1942, status: "passed" } },
        { wakeup: wakeupMock },
      );

      expect(ciResult.woken).toBe(true);
      expect(wakeupMock).toHaveBeenCalledTimes(1);

      const deliveredDigest = ciResult.digest;
      expect(deliveredDigest?.eventCount).toBe(2);
      expect(deliveredDigest?.events[0]?.type).toBe("log");
      expect(deliveredDigest?.events[1]?.type).toBe("ci_completed");

      // Buffer is cleared after delivery
      expect(service.getPendingDigest(agentId)).toBeNull();
    });
  });

  describe("Digest isolation across agents", () => {
    it("keeps digests separate per agentId", async () => {
      const agentA = "agent-A";
      const agentB = "agent-B";

      await service.handleAgentEvent(
        { agentId: agentA, type: "heartbeat" },
        { wakeup: wakeupMock },
      );
      await service.handleAgentEvent(
        { agentId: agentB, type: "heartbeat" },
        { wakeup: wakeupMock },
      );

      expect(service.getPendingDigest(agentA)?.eventCount).toBe(1);
      expect(service.getPendingDigest(agentB)?.eventCount).toBe(1);

      // Wake agent A with P0
      await service.handleAgentEvent(
        { agentId: agentA, type: "system_failure" },
        { wakeup: wakeupMock },
      );

      // Agent A digest is cleared, Agent B digest remains pending
      expect(service.getPendingDigest(agentA)).toBeNull();
      expect(service.getPendingDigest(agentB)?.eventCount).toBe(1);
    });
  });

  describe("Event priority classification policy (plan-166 §10)", () => {
    it("classifies P0 emergency events", () => {
      expect(classifyEventPriority("security_incident")).toBe("P0");
      expect(classifyEventPriority("service_outage")).toBe("P0");
      expect(classifyEventPriority("budget.incident.opened")).toBe("P0");
      expect(classifyEventPriority("run_stalled")).toBe("P0");
      expect(classifyEventPriority("security.breach")).toBe("P0");
    });

    it("classifies P1 high-priority operational events", () => {
      expect(classifyEventPriority("ci_completed")).toBe("P1");
      expect(classifyEventPriority("review_completed")).toBe("P1");
      expect(classifyEventPriority("execution_review_requested")).toBe("P1");
      expect(classifyEventPriority("issue_unblock_requested")).toBe("P1");
      expect(classifyEventPriority("ci.passed")).toBe("P1");
    });

    it("classifies P2 actionable updates", () => {
      expect(classifyEventPriority("issue_assigned")).toBe("P2");
      expect(classifyEventPriority("issue_commented")).toBe("P2");
      expect(classifyEventPriority("issue_children_completed")).toBe("P2");
      expect(classifyEventPriority("task_assigned")).toBe("P2");
    });

    it("classifies P3 routine progress and metrics", () => {
      expect(classifyEventPriority("busy")).toBe("P3");
      expect(classifyEventPriority("progress")).toBe("P3");
      expect(classifyEventPriority("activity.logged")).toBe("P3");
      expect(classifyEventPriority("cost_event.created")).toBe("P3");
      expect(classifyEventPriority("progress.update")).toBe("P3");
    });

    it("classifies P4 heartbeat, duplicates, no-ops and logs", () => {
      expect(classifyEventPriority("heartbeat")).toBe("P4");
      expect(classifyEventPriority("heartbeat_timer")).toBe("P4");
      expect(classifyEventPriority("noop")).toBe("P4");
      expect(classifyEventPriority("duplicate")).toBe("P4");
      expect(classifyEventPriority("log")).toBe("P4");
      expect(classifyEventPriority("unknown_arbitrary_event")).toBe("P4");
    });

    it("evaluates wake and accumulation predicates correctly", () => {
      expect(isImmediateWakePriority("P0")).toBe(true);
      expect(isImmediateWakePriority("P1")).toBe(true);
      expect(isImmediateWakePriority("P2")).toBe(false);
      expect(isImmediateWakePriority("P3")).toBe(false);
      expect(isImmediateWakePriority("P4")).toBe(false);

      expect(isDigestAccumulatedPriority("P3")).toBe(true);
      expect(isDigestAccumulatedPriority("P4")).toBe(true);
      expect(isDigestAccumulatedPriority("P0")).toBe(false);
      expect(isDigestAccumulatedPriority("P1")).toBe(false);
      expect(isDigestAccumulatedPriority("P2")).toBe(false);
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
} from "../services/routable-blocked.js";

const agentId = "00000000-0000-4000-8000-000000000001";

function blockedIssue(input: {
  transitionAt?: Date | null;
  notifiedAt?: Date | null;
} = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    status: "blocked",
    unblockDescriptor: { owner: { agentId }, action: "Review the finding" } as const,
    blockedTransitionAt: input.transitionAt === undefined
      ? new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1)
      : input.transitionAt,
    blockedOwnerNotifiedAt: input.notifiedAt ?? null,
  };
}

describe("routable blocked notifications", () => {
  it("wakes the named agent and records delivery on a prospective transition", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const now = new Date("2026-07-23T18:30:00.000Z");
    const issue = blockedIssue();

    await expect(deliverAgentUnblockNotification({ issue, wakeup, markNotified, now: () => now }))
      .resolves.toBe(true);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_unblock_requested",
      idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}`,
      payload: { issueId: issue.id, action: "Review the finding" },
    }));
    expect(markNotified).toHaveBeenCalledWith(now);
  });

  it("leaves pre-existing blocked issues untouched", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1) }),
      wakeup,
      markNotified,
    })).resolves.toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  it("deduplicates one transition and notifies again after a blocked flap", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const firstTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const secondTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2);

    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: firstTransition, notifiedAt: new Date() }),
      wakeup,
      markNotified,
    });
    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: secondTransition }),
      wakeup,
      markNotified,
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: expect.stringContaining(secondTransition.toISOString()),
    });
  });
});

describe("unblock request self-wake and throttle", () => {
  const ownerId = "00000000-0000-4000-8000-000000000001";
  const otherId = "00000000-0000-4000-8000-000000000003";
  const base = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
  const T0 = new Date("2026-11-16T10:00:00.000Z");
  const min = (n: number) => new Date(T0.getTime() + n * 60_000);

  function deliver(input: {
    assignee: string;
    now: Date;
    lastWake?: Date | null;
    external?: Date | null;
    nextCheckAt?: string | null;
    escalation?: string | null;
  }) {
    const wakeup = vi.fn(async () => undefined);
    const onOutcome = vi.fn();
    return {
      wakeup,
      onOutcome,
      done: deliverAgentUnblockNotification({
        issue: { ...blockedIssue(), assigneeAgentId: input.assignee, blockedTransitionAt: base },
        wakeup,
        markNotified: async () => undefined,
        now: () => input.now,
        nextCheckAt: input.nextCheckAt ?? null,
        lastWakeAt: async () => input.lastWake ?? null,
        lastExternalEventAt: async () => input.external ?? null,
        resolveEscalationAgentId: async () => input.escalation ?? null,
        onOutcome,
      }),
    };
  }

  it("does not wake the assignee when it owns its own block, and only logs without escalation", async () => {
    const r = deliver({ assignee: agentId, now: T0 });
    await expect(r.done).resolves.toBe(false);
    expect(r.wakeup).not.toHaveBeenCalled();
    expect(r.onOutcome).toHaveBeenCalledWith("self_owner_logged", expect.anything());
  });

  it("escalates a self-owned block to the lead instead of waking the assignee", async () => {
    const r = deliver({ assignee: agentId, now: T0, escalation: otherId });
    await expect(r.done).resolves.toBe(true);
    expect(r.wakeup).toHaveBeenCalledTimes(1);
    expect(r.wakeup.mock.calls[0]?.[0]).toBe(otherId);
    expect(r.onOutcome).toHaveBeenCalledWith("self_owner_escalated", expect.anything());
  });

  it("wakes another agent owner once, then only after nextCheckAt or 30 minutes", async () => {
    const first = deliver({ assignee: otherId, now: T0 });
    await expect(first.done).resolves.toBe(true);
    expect(first.wakeup).toHaveBeenCalledTimes(1);

    const early = deliver({ assignee: otherId, now: min(2), lastWake: T0 });
    await expect(early.done).resolves.toBe(false);
    expect(early.wakeup).not.toHaveBeenCalled();

    const defaultDue = deliver({ assignee: otherId, now: min(30), lastWake: T0 });
    await expect(defaultDue.done).resolves.toBe(true);

    const beforeNextCheck = deliver({ assignee: otherId, now: min(40), lastWake: T0, nextCheckAt: min(60).toISOString() });
    await expect(beforeNextCheck.done).resolves.toBe(false);
    const afterNextCheck = deliver({ assignee: otherId, now: min(61), lastWake: T0, nextCheckAt: min(60).toISOString() });
    await expect(afterNextCheck.done).resolves.toBe(true);
  });

  it("wakes at once after a new external event", async () => {
    const r = deliver({ assignee: otherId, now: min(2), lastWake: T0, external: min(1) });
    await expect(r.done).resolves.toBe(true);
    expect(r.wakeup).toHaveBeenCalledTimes(1);
    const old = deliver({ assignee: otherId, now: min(2), lastWake: T0, external: min(-5) });
    await expect(old.done).resolves.toBe(false);
  });
});

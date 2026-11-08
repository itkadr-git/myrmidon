import { describe, expect, it, vi } from "vitest";
import {
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
  UNBLOCK_OWNER_WAKE_COOLDOWN_MS,
  unblockDescriptorFingerprint,
} from "../services/routable-blocked.js";

const agentId = "00000000-0000-4000-8000-000000000001";

function blockedIssue(input: {
  transitionAt?: Date | null;
  notifiedAt?: Date | null;
  action?: string;
} = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    status: "blocked",
    unblockDescriptor: { owner: { agentId }, action: input.action ?? "Review the finding" } as const,
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
      payload: {
        issueId: issue.id,
        action: "Review the finding",
        descriptorFingerprint: unblockDescriptorFingerprint(issue.unblockDescriptor!),
      },
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

  // myrmidon(OPE-12297): a blocked↔in_progress flap (each re-entry bumps
  // blockedTransitionAt and clears blockedOwnerNotifiedAt) must not deliver a
  // fresh wake per cycle. The recent-delivery guard stands the repeat down.
  it("stands down when an identical-descriptor wake was requested inside the cooldown window", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const wasRecentlyNotified = vi.fn(async () => true);
    const now = new Date("2026-07-23T18:30:00.000Z");
    // Flap episode: fresh blockedTransitionAt, blockedOwnerNotifiedAt cleared.
    const flapTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2);

    const delivered = await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: flapTransition }),
      wakeup,
      markNotified,
      wasRecentlyNotified,
      now: () => now,
    });

    expect(delivered).toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
    expect(wasRecentlyNotified).toHaveBeenCalledWith(
      unblockDescriptorFingerprint(blockedIssue().unblockDescriptor!),
      new Date(now.getTime() - UNBLOCK_OWNER_WAKE_COOLDOWN_MS),
    );
  });

  it("wakes again after the cooldown window has elapsed", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const wasRecentlyNotified = vi.fn(async () => false);
    const now = new Date("2026-07-23T18:30:00.000Z");
    const firstTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const flapTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2);

    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: firstTransition, notifiedAt: new Date() }),
      wakeup,
      markNotified,
    });
    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: flapTransition }),
      wakeup,
      markNotified,
      wasRecentlyNotified,
      now: () => now,
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wasRecentlyNotified).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: expect.stringContaining(flapTransition.toISOString()),
    });
  });

  it("wakes again when the unblock descriptor content changed", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const firstTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const secondTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2);
    const firstFingerprint = unblockDescriptorFingerprint(blockedIssue({ action: "Review the finding" }).unblockDescriptor!);
    const secondFingerprint = unblockDescriptorFingerprint(blockedIssue({ action: "Escalate the finding" }).unblockDescriptor!);

    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: firstTransition, notifiedAt: new Date(), action: "Review the finding" }),
      wakeup,
      markNotified,
    });
    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: secondTransition, action: "Escalate the finding" }),
      wakeup,
      markNotified,
    });

    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(wakeup.mock.calls[1]?.[1]).toMatchObject({
      payload: expect.objectContaining({ descriptorFingerprint: secondFingerprint }),
    });
    expect(firstFingerprint).not.toEqual(secondFingerprint);
  });
});

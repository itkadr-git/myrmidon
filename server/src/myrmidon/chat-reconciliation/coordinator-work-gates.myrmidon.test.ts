// myrmidon(DB-PERF-C-P5): coordinator-level behaviour of the cheap work gates.
// The vendor behaviour test next to app.ts (__tests__/app-private-hostname-gate
// .test.ts) stays as it is; this file only pins what the gates add:
//   * empty queues -> no gated lane runs, the gates are asked instead;
//   * queues with work -> every lane runs exactly as it does without gates;
//   * notifyPublications() -> one forced pass of the gated lanes even while
//     their gates answer "no work" (a live commit must not wait);
//   * without gates the lanes run against the same empty queues (the cost
//     this part removes).
import { describe, expect, it, vi } from "vitest";
import { createChatReconciliationCoordinator } from "../../app.js";
import type { ChatReconciliationWorkGates } from "./work-gates.js";

function createGates(answer: boolean): ChatReconciliationWorkGates {
  return {
    hasPublicationWork: vi.fn(async () => answer),
    hasDeliveryWork: vi.fn(async () => answer),
    hasSlackFileReceiptWork: vi.fn(async () => answer),
    hasSlackSessionSyncWork: vi.fn(async () => answer),
    hasMilestoneWork: vi.fn(async () => answer),
    noteMilestonePassCompleted: vi.fn(),
    resetMilestoneWatermark: vi.fn(),
  };
}

function createHarness(options: {
  workGates?: ChatReconciliationWorkGates;
  inserted?: number;
} = {}) {
  const lanes = {
    reconcileProviderRuntimes: vi.fn(async () => undefined),
    processPendingDeliveries: vi.fn(async () => undefined),
    processFailedGitHubWebhookDeliveries: vi.fn(async () => undefined),
    projectRunMilestones: vi.fn(async () => options.inserted ?? 0),
    flushPublications: vi.fn(async () => undefined),
    processPendingSlackFileUploadReceipts: vi.fn(async () => undefined),
    processPendingSlackSessionSyncs: vi.fn(async () => undefined),
    sweepTelegramNotifyProactivity: vi.fn(async () => undefined),
  };
  const errors: unknown[] = [];
  const coordinator = createChatReconciliationCoordinator({
    ...lanes,
    workGates: options.workGates,
    onError: (lane, error) => errors.push({ lane, error }),
    milestoneMinimumSpacingMs: 0,
  });
  return { lanes, errors, coordinator };
}

describe("chat reconciliation coordinator work gates", () => {
  it("skips every gated lane when its gate reports an empty queue", async () => {
    const gates = createGates(false);
    const h = createHarness({ workGates: gates });

    h.coordinator.reconcile();
    await h.coordinator.drain();

    expect(h.lanes.processPendingDeliveries).not.toHaveBeenCalled();
    expect(h.lanes.flushPublications).not.toHaveBeenCalled();
    expect(h.lanes.projectRunMilestones).not.toHaveBeenCalled();
    expect(h.lanes.processPendingSlackFileUploadReceipts).not.toHaveBeenCalled();
    expect(h.lanes.processPendingSlackSessionSyncs).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);

    // The cheap question was asked exactly once per gated lane.
    expect(gates.hasPublicationWork).toHaveBeenCalledTimes(1);
    expect(gates.hasDeliveryWork).toHaveBeenCalledTimes(1);
    expect(gates.hasMilestoneWork).toHaveBeenCalledTimes(1);
    expect(gates.hasSlackFileReceiptWork).toHaveBeenCalledTimes(1);
    expect(gates.hasSlackSessionSyncWork).toHaveBeenCalledTimes(1);

    // Ungated lanes keep their cadence: provider recovery, GitHub webhook
    // recovery and the Telegram-notify proactivity producer.
    expect(h.lanes.reconcileProviderRuntimes).toHaveBeenCalledTimes(1);
    expect(h.lanes.processFailedGitHubWebhookDeliveries).toHaveBeenCalledTimes(
      1,
    );
    expect(h.lanes.sweepTelegramNotifyProactivity).toHaveBeenCalledTimes(1);
  });

  it("runs each lane exactly as often as a coordinator without gates", async () => {
    const gated = createHarness({ workGates: createGates(true), inserted: 0 });
    const plain = createHarness({ inserted: 0 });

    for (const h of [gated, plain]) {
      h.coordinator.reconcile();
      await h.coordinator.drain();
    }

    for (const lane of [
      "reconcileProviderRuntimes",
      "processPendingDeliveries",
      "processFailedGitHubWebhookDeliveries",
      "projectRunMilestones",
      "flushPublications",
      "processPendingSlackFileUploadReceipts",
      "processPendingSlackSessionSyncs",
      "sweepTelegramNotifyProactivity",
    ] as const) {
      expect(gated.lanes[lane].mock.calls.length).toBe(
        plain.lanes[lane].mock.calls.length,
      );
      expect(plain.lanes[lane].mock.calls.length).toBeGreaterThan(0);
    }
    expect(gated.errors).toEqual([]);
    expect(plain.errors).toEqual([]);
  });

  it("runs the gated lanes without gates against the same empty queues", async () => {
    // The cost this part removes: the pre-change coordinator asks for the
    // heavy lanes on every tick even while the gates say "no work".
    const h = createHarness({ inserted: 0 });

    h.coordinator.reconcile();
    await h.coordinator.drain();

    expect(h.lanes.processPendingDeliveries).toHaveBeenCalledTimes(1);
    expect(h.lanes.flushPublications).toHaveBeenCalledTimes(1);
    expect(h.lanes.projectRunMilestones).toHaveBeenCalledTimes(1);
    expect(h.lanes.processPendingSlackFileUploadReceipts).toHaveBeenCalledTimes(
      1,
    );
    expect(h.lanes.processPendingSlackSessionSyncs).toHaveBeenCalledTimes(1);
  });

  it("forces one pass of the gated lanes when publications are committed", async () => {
    const gates = createGates(false);
    const h = createHarness({ workGates: gates, inserted: 0 });

    h.coordinator.reconcile();
    await h.coordinator.drain();
    expect(h.lanes.flushPublications).not.toHaveBeenCalled();
    expect(h.lanes.projectRunMilestones).not.toHaveBeenCalled();

    h.coordinator.notifyPublications();
    await vi.waitFor(() => {
      expect(h.lanes.flushPublications).toHaveBeenCalledTimes(1);
    });
    await h.coordinator.drain();
    expect(h.lanes.projectRunMilestones).toHaveBeenCalledTimes(1);

    // The forced pass is consumed: the next tick with empty queues is cheap
    // again.
    h.coordinator.reconcile();
    await h.coordinator.drain();
    expect(h.lanes.flushPublications).toHaveBeenCalledTimes(1);
    expect(h.lanes.projectRunMilestones).toHaveBeenCalledTimes(1);
  });

  it("honours notifyPublications() again after the forced pass is consumed", async () => {
    const gates = createGates(false);
    const h = createHarness({ workGates: gates, inserted: 0 });

    h.coordinator.reconcile();
    await h.coordinator.drain();
    h.coordinator.notifyPublications();
    await vi.waitFor(() => {
      expect(h.lanes.flushPublications).toHaveBeenCalledTimes(1);
    });
    await h.coordinator.drain();

    h.coordinator.notifyPublications();
    await vi.waitFor(() => {
      expect(h.lanes.flushPublications).toHaveBeenCalledTimes(2);
    });
    await h.coordinator.drain();
    expect(h.lanes.projectRunMilestones).toHaveBeenCalledTimes(2);
  });

  it("records the milestone pass with its start and inserted count", async () => {
    const gates = createGates(true);
    const h = createHarness({ workGates: gates, inserted: 0 });
    const before = Date.now();

    h.coordinator.reconcile();
    await h.coordinator.drain();

    expect(gates.noteMilestonePassCompleted).toHaveBeenCalledTimes(1);
    const [startedAt, inserted] = vi.mocked(
      gates.noteMilestonePassCompleted,
    ).mock.calls[0] as unknown as [Date, number];
    expect(inserted).toBe(0);
    expect(startedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("does not ask a lane's gate again while the lane is in flight", async () => {
    const gates = createGates(true);
    const h = createHarness({ workGates: gates });
    let release: (() => void) | undefined;

    h.lanes.processPendingDeliveries.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    h.coordinator.reconcile();
    await vi.waitFor(() => {
      expect(h.lanes.processPendingDeliveries).toHaveBeenCalledTimes(1);
    });
    // The lane is still in flight, so the next tick does not ask again.
    h.coordinator.reconcile();
    expect(gates.hasDeliveryWork).toHaveBeenCalledTimes(1);
    release?.();
    await h.coordinator.drain();
    expect(h.lanes.processPendingDeliveries).toHaveBeenCalledTimes(1);
    expect(h.errors).toEqual([]);
  });
});
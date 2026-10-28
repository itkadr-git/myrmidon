import { describe, expect, it, vi } from "vitest";
import { pickupNextReview, type ReviewPickupPorts } from "./pickup.js";

function fixture() {
  let tail = Promise.resolve();
  let covered = false;
  const wake = vi.fn(async () => { covered = true; return { id: "wake" }; });
  const ports: ReviewPickupPorts = {
    serialize: async (work) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { return await work(); } finally { release(); }
    },
    hasWorkInFlight: async () => covered,
    candidates: async () => [
      { id: "new", updatedAt: new Date(20), executionState: { currentStageId: "new-stage" } },
      { id: "old", updatedAt: new Date(10), executionState: { currentStageId: "old-stage" } },
    ],
    wake,
  };
  return { ports, wake };
}

describe("review completion pickup", () => {
  it("wakes the oldest eligible review, not the just-finished issue", async () => {
    const { ports, wake } = fixture();
    expect(await pickupNextReview(ports, { excludeIssueId: "finished" })).toBe(true);
    expect(wake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "old" }));
  });
  it("does nothing for an empty queue", async () => {
    const { ports, wake } = fixture();
    ports.candidates = async () => [];
    expect(await pickupNextReview(ports)).toBe(false);
    expect(wake).not.toHaveBeenCalled();
  });
  it("excludes the completed issue and breaks equal-age ties by id", async () => {
    const { ports, wake } = fixture();
    ports.candidates = async () => ["finished", "b", "a"].map((id) => ({ id, updatedAt: new Date(0), executionState: null }));
    await pickupNextReview(ports, { excludeIssueId: "finished" });
    expect(wake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "a" }));
  });
  it("concurrent completion events emit only one wake", async () => {
    const { ports, wake } = fixture();
    await Promise.all([pickupNextReview(ports), pickupNextReview(ports)]);
    expect(wake).toHaveBeenCalledTimes(1);
  });
  it("retries the same oldest review after budget recovers, without a duplicate wake", async () => {
    const { ports, wake } = fixture();
    const admit = wake.getMockImplementation()!;
    wake.mockImplementationOnce(async () => null as never);
    expect(await pickupNextReview(ports)).toBe(true);
    expect(await ports.hasWorkInFlight()).toBe(false);
    wake.mockImplementation(admit);
    expect(await pickupNextReview(ports)).toBe(true);
    expect(await ports.hasWorkInFlight()).toBe(true);
    expect(await pickupNextReview(ports)).toBe(true);
    expect(wake.mock.calls.map(([candidate]) => (candidate as { id: string }).id)).toEqual(["old", "old"]);
  });
  it("does not skip the oldest review when admission suppresses its wake", async () => {
    const { ports, wake } = fixture();
    wake.mockImplementation(async () => null as never);
    expect(await pickupNextReview(ports)).toBe(true);
    expect(wake).toHaveBeenCalledTimes(1);
  });
});

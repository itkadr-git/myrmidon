import { describe, expect, it } from "vitest";
import { ACK_BUCKETS, collectInteractionMetrics, renderInteractionMetrics, type InteractionMetricRow } from "./interaction-metrics.js";

const now = new Date("2026-10-27T12:00:00Z");
function row(overrides: Partial<InteractionMetricRow> = {}): InteractionMetricRow {
  return { status: "pending", createdAt: new Date(now.getTime() - 60000), resolvedAt: null,
    timeoutAt: new Date(now.getTime() - 1000), addresseeAgentId: null, addresseeUserId: null,
    addresseeQueue: null, escalationLevel: 0, ...overrides };
}
describe("interaction SLA metrics", () => {
  it("counts unaddressed cards, age, persisted levels, timeout ratio and ACK buckets", async () => {
    const interactions = [row(), row({ addresseeQueue: "ops", escalationLevel: 1 }),
      row({ addresseeUserId: "user", timeoutAt: null }),
      row({ addresseeAgentId: "agent", timeoutAt: new Date(now.getTime() + 1000) }),
      row({ status: "answered", resolvedAt: new Date(now.getTime() - 55000), timeoutAt: null }),
      row({ status: "cancelled", resolvedAt: now, timeoutAt: null })];
    const snapshot = await collectInteractionMetrics({ read: async () => ({ interactions, escalations: [{ level: 1, count: 2 }, { level: 2, count: 1 }] }) }, now);
    expect(snapshot.pendingWithoutOwner).toBe(1);
    expect(snapshot.oldestPendingAgeSeconds).toBe(60);
    expect(snapshot.timeoutEscalatedRatio).toBe(0.5);
    expect(snapshot.escalations).toEqual([{ level: 1, count: 2 }, { level: 2, count: 1 }]);
    expect(snapshot.ack).toEqual({ count: 1, sum: 5, buckets: ACK_BUCKETS.map((bound) => bound >= 5 ? 1 : 0) });
    const text = renderInteractionMetrics(snapshot, "api");
    expect(text).toContain('interactions_pending_without_owner{role="api"} 1');
    expect(text).toContain('interaction_escalations_total{role="api",level="2"} 1');
    expect(text).toContain('interaction_ack_latency_seconds_bucket{role="api",le="+Inf"} 1');
    expect(text).toContain('interaction_ack_latency_seconds_sum{role="api"} 5');
  });
  it("handles an empty source and future timestamps without invalid numbers", async () => {
    const empty = await collectInteractionMetrics({ read: async () => ({ interactions: [], escalations: [] }) }, now);
    expect(empty.pendingWithoutOwner).toBe(0);
    expect(empty.oldestPendingAgeSeconds).toBe(0);
    expect(empty.timeoutEscalatedRatio).toBe(0);
    expect(empty.ack.count).toBe(0);
  });
  it("does not disguise failed reads as zeroes", async () => {
    await expect(collectInteractionMetrics({ read: async () => { throw new Error("missing I2 migration"); } }, now)).rejects.toThrow("missing I2 migration");
    const text = renderInteractionMetrics(null, "api");
    expect(text).toContain("# TYPE interaction_ack_latency_seconds histogram");
    expect(text.split("\n").filter((line) => line && !line.startsWith("#"))).toEqual([]);
  });
});

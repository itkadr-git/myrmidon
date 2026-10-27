import { describe, expect, it } from "vitest";
import { containerOomObservation } from "./container-oom.js";

const finished = "2026-10-27T12:00:00.123456789Z";
describe("container OOM evidence", () => {
  it("requires explicit Docker evidence, not exit 137", () => {
    expect(containerOomObservation({ Id: "container-a", State: { FinishedAt: finished } })).toBeNull();
    expect(containerOomObservation({ Id: "container-a", State: { OOMKilled: false, FinishedAt: finished } })).toBeNull();
  });
  it.each([undefined, "not-a-date", "0001-01-01T00:00:00Z"])("rejects missing/invalid finish time %s", (FinishedAt) => {
    expect(containerOomObservation({ Id: "container-a", State: { OOMKilled: true, FinishedAt } })).toBeNull();
  });
  it("keeps container identity and configured limit without inventing a peak", () => {
    expect(containerOomObservation({ Id: "container-a", State: { OOMKilled: true, FinishedAt: finished }, HostConfig: { Memory: 1073741824 } }))
      .toEqual({ containerId: "container-a", occurredAt: "2026-10-27T12:00:00.123Z", memoryLimitBytes: 1073741824 });
  });
  it.each([0, -1, NaN, Infinity, 1.5])("does not report invalid limit %s", (Memory) => {
    expect(containerOomObservation({ Id: "container-a", State: { OOMKilled: true, FinishedAt: finished }, HostConfig: { Memory } })?.memoryLimitBytes).toBeNull();
  });
});

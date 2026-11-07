import { describe, expect, it } from "vitest";
import { classifyEventPriority, EVENT_PRIORITY_BY_TYPE } from "./policy.js";

describe("classifyEventPriority", () => {
  it.each(Object.entries(EVENT_PRIORITY_BY_TYPE))("maps %s to %s", (eventType, priority) => {
    expect(classifyEventPriority(eventType)).toBe(priority);
  });

  it("assigns unknown extension events the informational priority", () => {
    expect(classifyEventPriority("vendor.custom.event")).toBe("P4");
  });

  it("does not normalize event types", () => {
    expect(classifyEventPriority("Lifecycle")).toBe("P4");
    expect(classifyEventPriority(" lifecycle ")).toBe("P4");
  });
});

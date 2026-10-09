// myrmidon(1.6.6 NOTIF-PREFS): config parsing and wake-reason classification
// for per-agent notification preferences.
import { describe, expect, it } from "vitest";

import {
  classifyNotificationWakeReason,
  normalizeAgentNotificationPrefs,
  readAgentNotificationPrefs,
} from "./notification-prefs.js";

describe("classifyNotificationWakeReason", () => {
  it.each([
    ["issue_assigned", "assignment"],
    ["issue_assignment_recovery", "assignment"],
    ["issue_comment_mentioned", "mention"],
    ["execution_review_requested", "review"],
    ["execution_approval_requested", "review"],
    ["execution_changes_requested", "review"],
  ] as const)("maps %s to the %s class", (reason, cls) => {
    expect(classifyNotificationWakeReason(reason)).toBe(cls);
  });

  it("leaves non-notification reasons and null unclassified", () => {
    for (const reason of ["issue_commented", "timer_due", "idle_pickup", null, undefined]) {
      expect(classifyNotificationWakeReason(reason)).toBeNull();
    }
  });
});

describe("normalizeAgentNotificationPrefs", () => {
  it("defaults everything to notify when the block is absent or malformed", () => {
    const all = { enabled: true, assignment: true, mention: true, review: true };
    expect(normalizeAgentNotificationPrefs(undefined)).toEqual(all);
    expect(normalizeAgentNotificationPrefs(null)).toEqual(all);
    expect(normalizeAgentNotificationPrefs("off")).toEqual(all);
    expect(normalizeAgentNotificationPrefs([])).toEqual(all);
  });

  it("fills unset siblings with permissive defaults (zod v4 nested-default gap)", () => {
    expect(normalizeAgentNotificationPrefs({ assignment: false })).toEqual({
      enabled: true,
      assignment: false,
      mention: true,
      review: true,
    });
  });

  it("replaces only malformed fields with defaults, preserving valid siblings", () => {
    expect(normalizeAgentNotificationPrefs({ assignment: false, mention: "no" })).toEqual({
      enabled: true,
      assignment: false,
      mention: true,
      review: true,
    });
  });

  it("rejects unknown keys through the strict schema but keeps explicit booleans in fallback", () => {
    const prefs = normalizeAgentNotificationPrefs({ assignment: false, bogus: true });
    expect(prefs.assignment).toBe(false);
    expect(prefs.mention).toBe(true);
  });

  it("reads the block from a full runtimeConfig record", () => {
    expect(readAgentNotificationPrefs({ notifications: { review: false }, heartbeat: {} }).review).toBe(false);
    expect(readAgentNotificationPrefs({}).review).toBe(true);
    expect(readAgentNotificationPrefs(null).enabled).toBe(true);
  });
});

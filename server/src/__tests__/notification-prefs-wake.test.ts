// myrmidon(1.6.6 NOTIF-PREFS): the single decision point that every
// wake-generation path uses to gate event-shaped wakes on the target agent's
// notification preferences.
import { describe, expect, it } from "vitest";

import { notificationWakeAllowed } from "@paperclipai/shared";

describe("notificationWakeAllowed (wake generation gate)", () => {
  it("delivers every class when the agent has no notifications block", () => {
    for (const reason of [
      "issue_assigned",
      "issue_assignment_recovery",
      "issue_comment_mentioned",
      "execution_review_requested",
      "execution_approval_requested",
      "execution_changes_requested",
    ]) {
      expect(notificationWakeAllowed({}, reason)).toBe(true);
      expect(notificationWakeAllowed(null, reason)).toBe(true);
      expect(notificationWakeAllowed(undefined, reason)).toBe(true);
    }
  });

  it("mutes only the classes the agent disabled", () => {
    const runtimeConfig = { notifications: { assignment: false, review: false } };
    expect(notificationWakeAllowed(runtimeConfig, "issue_assigned")).toBe(false);
    expect(notificationWakeAllowed(runtimeConfig, "issue_assignment_recovery")).toBe(false);
    expect(notificationWakeAllowed(runtimeConfig, "execution_review_requested")).toBe(false);
    expect(notificationWakeAllowed(runtimeConfig, "execution_approval_requested")).toBe(false);
    expect(notificationWakeAllowed(runtimeConfig, "execution_changes_requested")).toBe(false);
    // mention was never muted — sibling defaults stay permissive
    expect(notificationWakeAllowed(runtimeConfig, "issue_comment_mentioned")).toBe(true);
  });

  it("mutes every class when the master switch is off", () => {
    const runtimeConfig = { notifications: { enabled: false } };
    for (const reason of [
      "issue_assigned",
      "issue_comment_mentioned",
      "execution_review_requested",
    ]) {
      expect(notificationWakeAllowed(runtimeConfig, reason)).toBe(false);
    }
  });

  it("passes reasons that belong to no configurable class", () => {
    const runtimeConfig = { notifications: { enabled: false } };
    for (const reason of [
      "issue_commented",
      "timer_due",
      "monitor_due",
      "blockers_resolved",
      "idle_pickup",
      "transient_failure_retry",
      null,
      undefined,
    ]) {
      expect(notificationWakeAllowed(runtimeConfig, reason)).toBe(true);
    }
  });

  it("falls back to per-field defaults on malformed blocks", () => {
    expect(notificationWakeAllowed({ notifications: "off" }, "issue_assigned")).toBe(true);
    expect(notificationWakeAllowed({ notifications: { assignment: "false" } }, "issue_assigned")).toBe(true);
    // a strict-schema violation (unknown key) falls back field-by-field:
    // the explicit false is preserved, the unset sibling keeps its default
    expect(notificationWakeAllowed({ notifications: { assignment: false, bogus: true } }, "issue_assigned")).toBe(false);
    expect(notificationWakeAllowed({ notifications: { assignment: false, bogus: true } }, "issue_comment_mentioned")).toBe(true);
  });
});

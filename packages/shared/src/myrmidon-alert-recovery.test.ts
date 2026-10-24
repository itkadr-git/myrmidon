// myrmidon(1.6.6 MONITORING D): the shared contract of alert recovery.
//
// What is pinned here is the arithmetic the whole feature rests on: the identity
// of an alert (so a repeat is the same problem), the settings chain
// (stored → environment → default, reported per key), and the two guards the
// sweep and the intake call — "the hold is over, close it" and "the window has
// not passed, this repeat belongs to the closed task".

import { describe, expect, it } from "vitest";
import {
  ALERT_RECOVERY_HOLD_MINUTES_DEFAULT,
  ALERT_RECOVERY_JOURNAL_KEY,
  ALERT_RECOVERY_SETTINGS_KEY,
  ALERT_RECOVERY_WINDOW_MINUTES_DEFAULT,
  alertRecoveryEventSchema,
  alertRecoveryIdentity,
  alertRecoverySettingsSchema,
  coerceAlertRecoveryRecords,
  isAlertRecoveryCloseDue,
  isAlertRecoveryRecurrence,
  mergeAlertRecoverySettings,
  normalizeAlertHosts,
  normalizeAlertTrigger,
  patchAlertRecoverySettingsSchema,
  pruneAlertRecoveryRecords,
  resolveAlertRecoverySettings,
  type AlertRecoveryRecord,
} from "./myrmidon-alert-recovery.js";

function record(overrides: Partial<AlertRecoveryRecord> = {}): AlertRecoveryRecord {
  return {
    companyId: "company-1",
    identity: "zabbix:disk space is low on /data:vm-exec",
    source: "zabbix",
    trigger: "Disk space is low on /data",
    runbookKey: "disk-space-low",
    ownerRole: "devops",
    issueId: "issue-1",
    issueIdentifier: "OPE-9001",
    state: "open",
    firedCount: 1,
    firstFiredAt: "2026-10-07T04:00:00.000Z",
    lastFiredAt: "2026-10-07T04:00:00.000Z",
    resolvedAt: null,
    closedAt: null,
    ...overrides,
  };
}

describe("alert identity", () => {
  it("is the same for a repeat of the same alert on the same host", () => {
    const first = alertRecoveryIdentity({ source: "Zabbix", trigger: "Disk  space is LOW on /data", hosts: ["VM-Exec"] });
    const second = alertRecoveryIdentity({ source: "zabbix", trigger: "disk space is low on /data", hosts: ["vm-exec"] });
    expect(first).toBe(second);
    expect(first).toBe("zabbix:disk space is low on /data:vm-exec");
  });

  it("separates the same trigger on two hosts and two triggers on one host", () => {
    const a = alertRecoveryIdentity({ source: "zabbix", trigger: "t", hosts: ["host-a"] });
    const b = alertRecoveryIdentity({ source: "zabbix", trigger: "t", hosts: ["host-b"] });
    const c = alertRecoveryIdentity({ source: "zabbix", trigger: "other", hosts: ["host-a"] });
    const d = alertRecoveryIdentity({ source: "alertmanager", trigger: "t", hosts: ["host-a"] });
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(a).toBe("zabbix:t:host-a");
  });

  it("keeps a hostless alert stable and its hosts deduplicated and ordered", () => {
    expect(alertRecoveryIdentity({ source: "zabbix", trigger: "t" })).toBe("zabbix:t");
    expect(alertRecoveryIdentity({ source: "zabbix", trigger: "t", hosts: [] })).toBe("zabbix:t");
    expect(normalizeAlertHosts(["b", "A", " b ", ""])).toEqual(["a", "b"]);
    expect(normalizeAlertTrigger("  Host   DOWN ")).toBe("host down");
  });
});

describe("settings chain", () => {
  it("reads the default and says so", () => {
    const resolved = resolveAlertRecoverySettings({});
    expect(resolved.settings.holdMinutes).toBe(ALERT_RECOVERY_HOLD_MINUTES_DEFAULT);
    expect(resolved.settings.recurrenceWindowMinutes).toBe(ALERT_RECOVERY_WINDOW_MINUTES_DEFAULT);
    expect(resolved.settings.owners).toEqual({});
    expect(resolved.sources).toEqual({ holdMinutes: "default", recurrenceWindowMinutes: "default" });
  });

  it("lets the environment be the first-start default", () => {
    const resolved = resolveAlertRecoverySettings({
      env: {
        MYRMIDON_ALERT_RECOVERY_HOLD_MINUTES: " 15 ",
        MYRMIDON_ALERT_RECOVERY_WINDOW_MINUTES: "120",
      },
    });
    expect(resolved.settings.holdMinutes).toBe(15);
    expect(resolved.settings.recurrenceWindowMinutes).toBe(120);
    expect(resolved.sources).toEqual({ holdMinutes: "env", recurrenceWindowMinutes: "env" });
  });

  it("lets the stored row win over the environment per key", () => {
    const resolved = resolveAlertRecoverySettings({
      stored: { holdMinutes: 3, owners: { "disk space is low on /data": "devops" } },
      env: { MYRMIDON_ALERT_RECOVERY_HOLD_MINUTES: "15", MYRMIDON_ALERT_RECOVERY_WINDOW_MINUTES: "120" },
    });
    expect(resolved.settings.holdMinutes).toBe(3);
    expect(resolved.sources.holdMinutes).toBe("settings");
    expect(resolved.settings.recurrenceWindowMinutes).toBe(120);
    expect(resolved.sources.recurrenceWindowMinutes).toBe("env");
    expect(resolved.settings.owners).toEqual({ "disk space is low on /data": "devops" });
  });

  it("ignores a broken stored row as a whole and falls through per key", () => {
    // One unusable value makes the stored row unreadable: the environment and
    // then the default decide, so a hand-edited row can never half-apply.
    const broken = resolveAlertRecoverySettings({
      stored: { holdMinutes: 0, recurrenceWindowMinutes: 45 },
      env: { MYRMIDON_ALERT_RECOVERY_HOLD_MINUTES: "soon" },
    });
    expect(broken.settings.holdMinutes).toBe(ALERT_RECOVERY_HOLD_MINUTES_DEFAULT);
    expect(broken.sources.holdMinutes).toBe("default");
    expect(broken.settings.recurrenceWindowMinutes).toBe(ALERT_RECOVERY_WINDOW_MINUTES_DEFAULT);
    expect(broken.sources.recurrenceWindowMinutes).toBe("default");

    // A readable row that simply does not carry the key leaves that key to the
    // environment — per key, not all or nothing.
    const partial = resolveAlertRecoverySettings({
      stored: { recurrenceWindowMinutes: 45 },
      env: { MYRMIDON_ALERT_RECOVERY_HOLD_MINUTES: "15" },
    });
    expect(partial.settings.holdMinutes).toBe(15);
    expect(partial.sources.holdMinutes).toBe("env");
    expect(partial.settings.recurrenceWindowMinutes).toBe(45);
    expect(partial.sources.recurrenceWindowMinutes).toBe("settings");
  });

  it("merges a patch over the current values without dropping the rest", () => {
    const current = alertRecoverySettingsSchema.parse({ holdMinutes: 10, recurrenceWindowMinutes: 60 });
    const merged = mergeAlertRecoverySettings(current, { holdMinutes: 30, owners: { trigger: "devops" } });
    expect(merged).toEqual({ holdMinutes: 30, recurrenceWindowMinutes: 60, owners: { trigger: "devops" } });
    // A patch is partial: an empty body changes nothing.
    expect(mergeAlertRecoverySettings(current, {})).toEqual(current);
  });

  it("rejects a patch that would write an unusable value", () => {
    expect(patchAlertRecoverySettingsSchema.safeParse({ holdMinutes: 0 }).success).toBe(false);
    expect(patchAlertRecoverySettingsSchema.safeParse({ holdMinutes: 1441 }).success).toBe(false);
    expect(patchAlertRecoverySettingsSchema.safeParse({ holdMinutes: 10 }).success).toBe(true);
    expect(patchAlertRecoverySettingsSchema.safeParse({ holdMinutes: 10, extra: 1 }).success).toBe(false);
    expect(ALERT_RECOVERY_SETTINGS_KEY).toBe("alertRecovery");
    expect(ALERT_RECOVERY_JOURNAL_KEY).toBe("alertRecoveryJournal");
  });
});

describe("the two guards of the sweep", () => {
  const resolved = record({ state: "awaiting-close", resolvedAt: "2026-10-07T04:08:00.000Z" });
  const closed = record({ state: "closed", resolvedAt: "2026-10-07T04:08:00.000Z", closedAt: "2026-10-07T04:18:01.000Z" });

  it("closes only after the hold has passed, and only while a resolve is waiting", () => {
    expect(isAlertRecoveryCloseDue(resolved, new Date("2026-10-07T04:17:59.000Z"), 10)).toBe(false);
    expect(isAlertRecoveryCloseDue(resolved, new Date("2026-10-07T04:18:00.000Z"), 10)).toBe(true);
    expect(isAlertRecoveryCloseDue(record({ state: "open" }), new Date("2026-10-07T05:00:00.000Z"), 10)).toBe(false);
    expect(isAlertRecoveryCloseDue(closed, new Date("2026-10-07T05:00:00.000Z"), 10)).toBe(false);
    expect(isAlertRecoveryCloseDue(record({ state: "awaiting-close", resolvedAt: null }), new Date(), 10)).toBe(false);
  });

  it("counts a repeat into the closed task only inside the window", () => {
    expect(isAlertRecoveryRecurrence(closed, new Date("2026-10-07T05:18:00.000Z"), 60)).toBe(true);
    expect(isAlertRecoveryRecurrence(closed, new Date("2026-10-07T05:18:01.000Z"), 60)).toBe(false);
    expect(isAlertRecoveryRecurrence(record({ state: "open" }), new Date("2026-10-07T04:20:00.000Z"), 60)).toBe(false);
  });

  it("prunes the records whose window has passed and nothing else", () => {
    const open = record({ identity: "open", state: "open" });
    const waiting = record({ identity: "waiting", state: "awaiting-close", resolvedAt: "2026-10-07T04:08:00.000Z" });
    const fresh = record({ identity: "fresh", state: "closed", closedAt: "2026-10-07T05:00:00.000Z" });
    const stale = record({ identity: "stale", state: "closed", closedAt: "2026-10-07T04:18:01.000Z" });
    const kept = pruneAlertRecoveryRecords([open, waiting, fresh, stale], new Date("2026-10-07T05:30:00.000Z"), 60);
    expect(kept.map((entry) => entry.identity)).toEqual(["open", "waiting", "fresh"]);
  });
});

describe("journal and event reads", () => {
  it("drops a broken record instead of trusting it", () => {
    const good = record({ identity: "good" });
    const broken = [
      { ...record({ identity: "no-issue" }), issueId: "" },
      { ...record({ identity: "zero" }), firedCount: 0 },
      { ...record({ identity: "state" }), state: "waiting" },
      "not an object",
      null,
    ];
    expect(coerceAlertRecoveryRecords([good, ...broken]).map((entry) => entry.identity)).toEqual(["good"]);
    // The journal of a fresh instance is an empty list, not an error.
    expect(coerceAlertRecoveryRecords(undefined)).toEqual([]);
    expect(coerceAlertRecoveryRecords("{}")).toEqual([]);
  });

  it("takes the event body of the intake only in the documented shape", () => {
    const event = {
      companyId: "company-1",
      source: "zabbix",
      trigger: "Disk space is low on /data",
      status: "firing",
      severity: "high",
      summary: "used 96% of /data",
      hosts: ["vm-exec"],
      happenedAt: "2026-10-07T04:00:00.000Z",
      url: "https://zabbix.example/tr_events.php?triggerid=42",
    };
    expect(alertRecoveryEventSchema.safeParse(event).success).toBe(true);
    expect(alertRecoveryEventSchema.safeParse({ ...event, status: "resolved" }).success).toBe(true);
    expect(alertRecoveryEventSchema.safeParse({ ...event, status: "unknown" }).success).toBe(false);
    expect(alertRecoveryEventSchema.safeParse({ ...event, happenedAt: "2026-10-07 04:00" }).success).toBe(false);
    expect(alertRecoveryEventSchema.safeParse({ ...event, companyId: "" }).success).toBe(false);
    expect(alertRecoveryEventSchema.safeParse({ ...event, host: "vm-exec" }).success).toBe(false);
    // The optional fields really are optional — the intake may know nothing more.
    expect(
      alertRecoveryEventSchema.safeParse({
        companyId: "company-1",
        source: "alertmanager",
        trigger: "Host unreachable",
        status: "resolved",
        happenedAt: "2026-10-07T04:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});
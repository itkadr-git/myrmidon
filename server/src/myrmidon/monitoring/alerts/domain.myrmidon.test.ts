// myrmidon(1.6.6-ALERTS): the pure rules — payload parsing, identity, dedup
// decision, role mapping, issue title/body. No database, no network. Neutral
// data only (agent-a, example.com, 192.0.2.1).
import { describe, expect, it } from "vitest";
import {
  alertIdentity,
  alertPriority,
  decideDedup,
  detectAlertSource,
  issueBodyFor,
  issueTitleFor,
  parseAlertmanagerAlerts,
  parseZabbixAlert,
  resolvedCommentFor,
  routeAssignee,
  updateCommentFor,
  zabbixPriority,
} from "./domain.js";

const zabbixFiring = {
  eventid: "101",
  name: "Free disk space is less than 10% on volume /",
  severity: "4",
  status: "PROBLEM",
  hosts: "host-a.example.com",
  url: "https://zabbix.example.com/tr_events.php?triggerid=1&eventid=101",
};

describe("myrmidon(1.6.6-ALERTS) payload parsing", () => {
  it("detects the Zabbix format by eventid+name", () => {
    expect(detectAlertSource(zabbixFiring)).toBe("zabbix");
  });

  it("detects the Alertmanager format by alerts/status", () => {
    expect(detectAlertSource({ status: "firing", alerts: [] })).toBe("alertmanager");
    expect(detectAlertSource({ alerts: [{ fingerprint: "f1", labels: { alertname: "Disk" } }] })).toBe("alertmanager");
  });

  it("refuses an unknown payload", () => {
    expect(detectAlertSource({ hello: "world" })).toBeNull();
    expect(detectAlertSource("nope")).toBeNull();
  });

  it("parses a firing Zabbix disk event", () => {
    const alert = parseZabbixAlert(zabbixFiring);
    expect(alert).not.toBeNull();
    expect(alert!.source).toBe("zabbix");
    expect(alert!.key).toBe("101");
    expect(alert!.resolved).toBe(false);
    expect(alert!.hosts).toEqual(["host-a.example.com"]);
  });

  it("treats a Zabbix status=Resolved event as recovery", () => {
    const alert = parseZabbixAlert({ ...zabbixFiring, status: "Resolved" });
    expect(alert!.resolved).toBe(true);
  });

  it("parses an Alertmanager payload with fingerprint and labels", () => {
    const alerts = parseAlertmanagerAlerts({
      status: "firing",
      alerts: [
        {
          status: "firing",
          fingerprint: "abc123",
          startsAt: "2026-10-03T10:00:00Z",
          endsAt: null,
          labels: { alertname: "HighDiskUsage", severity: "critical", instance: "192.0.2.1:9100" },
          annotations: { summary: "disk above 90%" },
          generatorURL: "https://am.example.com/graph",
        },
      ],
    });
    expect(alerts).not.toBeNull();
    expect(alerts).toHaveLength(1);
    expect(alerts![0].source).toBe("alertmanager");
    expect(alerts![0].key).toBe("abc123");
    expect(alerts![0].severity).toBe("critical");
    expect(alerts![0].hosts).toEqual(["192.0.2.1:9100"]);
    expect(alerts![0].resolved).toBe(false);
  });

  it("treats an Alertmanager resolved alert as recovery with endsAt", () => {
    const alerts = parseAlertmanagerAlerts({
      status: "resolved",
      alerts: [
        {
          status: "resolved",
          fingerprint: "abc123",
          startsAt: "2026-10-03T10:00:00Z",
          endsAt: "2026-10-03T11:00:00Z",
          labels: { alertname: "HighDiskUsage", severity: "critical" },
        },
      ],
    });
    expect(alerts![0].resolved).toBe(true);
    expect(alerts![0].resolvedAt).toBe("2026-10-03T11:00:00Z");
  });
});

describe("myrmidon(1.6.6-ALERTS) identity and dedup", () => {
  it("builds a stable identity from source and key", () => {
    expect(alertIdentity({ source: "zabbix", key: "101" })).toBe("zabbix:101");
  });

  it("creates for an unseen firing alert", () => {
    const alert = parseZabbixAlert(zabbixFiring)!;
    expect(decideDedup(alert, null)).toEqual({ action: "create" });
  });

  it("updates instead of duplicating for a repeated firing alert", () => {
    const alert = parseZabbixAlert(zabbixFiring)!;
    expect(decideDedup(alert, { issueStatus: "open" })).toEqual({ action: "update" });
  });

  it("resolves an open issue on recovery", () => {
    const alert = parseZabbixAlert({ ...zabbixFiring, status: "Resolved" })!;
    expect(decideDedup(alert, { issueStatus: "open" })).toEqual({ action: "resolve" });
  });

  it("ignores a recovery with no open issue and a duplicate recovery", () => {
    const resolved = parseZabbixAlert({ ...zabbixFiring, status: "Resolved" })!;
    expect(decideDedup(resolved, null)).toEqual({ action: "ignore" });
    expect(decideDedup(resolved, { issueStatus: "resolved" })).toEqual({ action: "ignore" });
  });

  it("creates again when the alert re-fires after a recovery", () => {
    const alert = parseZabbixAlert(zabbixFiring)!;
    expect(decideDedup(alert, { issueStatus: "resolved" })).toEqual({ action: "create" });
  });
});

describe("myrmidon(1.6.6-ALERTS) severity mapping and routing", () => {
  it("maps Zabbix severities to board priorities", () => {
    expect(zabbixPriority(5)).toBe("critical");
    expect(zabbixPriority(4)).toBe("critical");
    expect(zabbixPriority(3)).toBe("high");
    expect(zabbixPriority(2)).toBe("medium");
    expect(zabbixPriority(1)).toBe("low");
  });

  it("uses the critical priority for a disk > 90% Zabbix alert", () => {
    const alert = parseZabbixAlert({ ...zabbixFiring, severity: "4" })!;
    expect(alertPriority(alert)).toBe("critical");
  });

  it("maps Alertmanager severity labels", () => {
    const alerts = parseAlertmanagerAlerts({
      status: "firing",
      alerts: [{ fingerprint: "f", labels: { alertname: "A", severity: "warning" } }],
    })!;
    expect(alertPriority(alerts[0])).toBe("medium");
  });

  it("routes by title pattern and falls back to the default assignee", () => {
    const alert = parseZabbixAlert(zabbixFiring)!;
    const routes = [
      { match: "disk", assignee: "adm-devops" },
      { match: "certificate", assignee: "agent-a" },
    ];
    expect(routeAssignee(alert, routes, "fallback")).toBe("adm-devops");
    expect(routeAssignee(alert, [], "fallback")).toBe("fallback");
    expect(routeAssignee(alert, [])).toBe("adm-devops");
    expect(routeAssignee(alert, [{ match: "", assignee: "" }], "fallback")).toBe("fallback");
  });
});

describe("myrmidon(1.6.6-ALERTS) issue text", () => {
  it("builds a title with the source and the host", () => {
    const alert = parseZabbixAlert(zabbixFiring)!;
    expect(issueTitleFor(alert)).toBe("[zabbix] Free disk space is less than 10% on volume / — host-a.example.com");
  });

  it("builds a description with the key, severity and the source link", () => {
    const alert = parseZabbixAlert(zabbixFiring)!;
    const body = issueBodyFor(alert);
    expect(body).toContain("Key: 101");
    expect(body).toContain("Severity: high");
    expect(body).toContain(zabbixFiring.url);
    expect(body).toContain("auto-closes");
  });

  it("builds the update and recovery comment bodies", () => {
    const firing = parseZabbixAlert(zabbixFiring)!;
    const update = updateCommentFor(firing, new Date("2026-10-03T12:00:00Z"));
    expect(update).toContain("still firing");
    const resolved = parseZabbixAlert({ ...zabbixFiring, status: "Resolved" })!;
    const recovery = resolvedCommentFor(resolved, "2026-10-03T13:00:00Z");
    expect(recovery).toContain("Recovered");
    expect(recovery).toContain("13:00:00");
  });
});

// server/src/myrmidon/monitoring/alerts/domain.ts
// myrmidon(1.6.6-ALERTS): pure rules of the monitoring alerts webhook — payload
// parsing for the two formats, the alert identity key, the dedup decision and
// the role mapping. No database, no network, no vendor imports: the routes and
// the service stay testable without a container.

/**
 * Webhook sources. Zabbix sends one event per request; Alertmanager (and
 * vm-alertmanager, same wire format) sends one status plus an array of alerts.
 */
export const ALERT_SOURCES = ["zabbix", "alertmanager"] as const;
export type AlertSource = (typeof ALERT_SOURCES)[number];

/** Zabbix severity codes the media-type payload carries. 1..4 map below. */
export const ZABBIX_SEVERITIES = [1, 2, 3, 4, 5] as const;
export type ZabbixSeverity = (typeof ZABBIX_SEVERITIES)[number];

/** Board priorities, ordered exactly like the vendor status filter. */
export const ALERT_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type AlertPriority = (typeof ALERT_PRIORITIES)[number];

/** A normalized alert, the single internal shape for both sources. */
export interface NormalizedAlert {
  source: AlertSource;
  /** Zabbix `eventid`, Alertmanager `fingerprint`. */
  key: string;
  title: string;
  severity: string;
  /** Hosts (Zabbix) or label values (Alertmanager) affected. */
  hosts: string[];
  /** `true` when the source reports the alert as recovered. */
  resolved: boolean;
  /** Recovery moment if known. */
  resolvedAt: string | null;
  startedAt: string | null;
  severityCode: number | null;
  labels: Record<string, string>;
  /** Source-side URL for the issue description. */
  url: string | null;
}

/** Raw Zabbix media-type webhook payload (one event). */
export interface ZabbixWebhookPayload {
  eventid?: string | number;
  event_date?: string;
  event_time?: string | number;
  name?: string;
  severity?: string | number;
  status?: string;
  hosts?: string;
  host?: string;
  ip?: string;
  item?: string;
  url?: string;
  acknowledged?: string | number;
}

/** Raw Alertmanager webhook payload (status plus alerts). */
export interface AlertmanagerWebhookPayload {
  status?: string;
  alerts?: Array<{
    status?: string;
    fingerprint?: string;
    startsAt?: string;
    endsAt?: string | null;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    generatorURL?: string;
  }>;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

const ZABBIX_SEVERITY_NAMES: Record<number, string> = {
  1: "information",
  2: "warning",
  3: "average",
  4: "high",
  5: "disaster",
};

/** Maps a Zabbix severity code to a board priority. 4 (high) and 5 (disaster) are critical. */
export function zabbixPriority(severityCode: number): AlertPriority {
  if (severityCode >= 4) return "critical";
  if (severityCode === 3) return "high";
  if (severityCode === 2) return "medium";
  return "low";
}

/** Maps an Alertmanager severity label to a board priority. Unknown is high. */
export function alertmanagerPriority(severity: string): AlertPriority {
  const normalized = severity.trim().toLowerCase();
  if (normalized === "critical" || normalized === "disaster") return "critical";
  if (normalized === "high" || normalized === "average") return "high";
  if (normalized === "warning" || normalized === "medium") return "medium";
  if (normalized === "info" || normalized === "information" || normalized === "low") return "low";
  return "high";
}

/** Parses the Zabbix media-type payload. Returns null when it is not a Zabbix event. */
export function parseZabbixAlert(raw: unknown): NormalizedAlert | null {
  if (typeof raw !== "object" || raw === null) return null;
  const payload = raw as ZabbixWebhookPayload;
  const key = asString(payload.eventid);
  const name = asString(payload.name);
  if (!key || !name) return null;
  const severityCode = Number(asString(payload.severity));
  const status = asString(payload.status)?.toLowerCase() ?? "";
  const resolved = status === "resolved" || status === "closed" || status === "ok";
  const hosts = (asString(payload.hosts) ?? asString(payload.host) ?? "")
    .split(/[,;|]/)
    .map((host) => host.trim())
    .filter(Boolean);
  const startedAt =
    asString(payload.event_date) && asString(payload.event_time)
      ? `${asString(payload.event_date)}T${asString(payload.event_time)}Z`
      : null;
  return {
    source: "zabbix",
    key,
    title: name,
    severity: ZABBIX_SEVERITY_NAMES[severityCode] ?? asString(payload.severity) ?? "unknown",
    hosts,
    resolved,
    resolvedAt: resolved ? new Date().toISOString() : null,
    startedAt,
    severityCode: Number.isFinite(severityCode) ? severityCode : null,
    labels: {},
    url: asString(payload.url),
  };
}

/** Parses the Alertmanager payload. Returns null when it has no alerts. */
export function parseAlertmanagerAlerts(raw: unknown): NormalizedAlert[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const payload = raw as AlertmanagerWebhookPayload;
  if (!Array.isArray(payload.alerts) || payload.alerts.length === 0) return null;
  const alerts: NormalizedAlert[] = [];
  for (const alert of payload.alerts) {
    if (typeof alert !== "object" || alert === null) continue;
    const key = asString(alert.fingerprint);
    const labels = alert.labels ?? {};
    const title = asString(labels.alertname) ?? asString(labels.alert_name) ?? "";
    if (!key || !title) continue;
    const status = (asString(alert.status) ?? asString(payload.status) ?? "firing").toLowerCase();
    const resolved = status === "resolved";
    const annotations = alert.annotations ?? {};
    const instance = asString(labels.instance);
    const summary = asString(annotations.summary);
    alerts.push({
      source: "alertmanager",
      key,
      title: instance ? `${title} (${instance})` : title,
      severity: asString(labels.severity) ?? "unknown",
      hosts: instance ? [instance] : Object.values(labels).slice(0, 5).filter(Boolean),
      resolved,
      resolvedAt: resolved ? (asString(alert.endsAt) ?? new Date().toISOString()) : null,
      startedAt: asString(alert.startsAt),
      severityCode: null,
      labels,
      url: asString(alert.generatorURL),
    });
    void summary;
  }
  return alerts.length > 0 ? alerts : null;
}

/**
 * Detects the payload format: an object with a numeric or string `eventid`
 * plus `name` is Zabbix; an object with an `alerts` array or top-level
 * `status` of firing/resolved is Alertmanager. Returns null when neither
 * matches so the route can answer 400 without guessing.
 */
export function detectAlertSource(raw: unknown): "zabbix" | "alertmanager" | null {
  if (typeof raw !== "object" || raw === null) return null;
  const payload = raw as Record<string, unknown>;
  const hasEventId = asString(payload.eventid) !== null;
  const hasName = asString(payload.name) !== null;
  if (hasEventId && hasName) return "zabbix";
  const hasAlerts = Array.isArray(payload.alerts);
  const status = asString(payload.status)?.toLowerCase();
  if (hasAlerts || status === "firing" || status === "resolved") return "alertmanager";
  return null;
}

/** Maps an alert to the board priority of its issue. */
export function alertPriority(alert: NormalizedAlert): AlertPriority {
  if (alert.source === "zabbix" && alert.severityCode !== null) {
    return zabbixPriority(alert.severityCode);
  }
  return alertmanagerPriority(alert.severity);
}

/**
 * The identity of one alert in the dedup registry: `${source}:${key}`.
 * A repeated firing alert must land on the same string.
 */
export function alertIdentity(alert: Pick<NormalizedAlert, "source" | "key">): string {
  return `${alert.source}:${alert.key}`;
}

export interface DedupDecision {
  action: "create" | "update" | "resolve" | "ignore";
}

/**
 * The dedup rule: no registry row → create; a row with an open issue and a
 * firing alert → update (comment); a row with an open issue and a resolved
 * alert → resolve (auto-close); a resolved row plus a resolved alert → ignore;
 * a resolved row plus a firing alert → create (a new occurrence after a
 * recovery; the previous issue is closed).
 */
export function decideDedup(alert: NormalizedAlert, row: { issueStatus: string } | null): DedupDecision {
  if (!row) return { action: alert.resolved ? "ignore" : "create" };
  const open = row.issueStatus === "open";
  if (alert.resolved) return open ? { action: "resolve" } : { action: "ignore" };
  return open ? { action: "update" } : { action: "create" };
}

/** One alert-type → assignee row of the settings map. */
export interface AlertRouteRule {
  /** Substring pattern matched against the alert title, lowercase. */
  match: string;
  /** Role name or agent id from the board. */
  assignee: string;
  /** Runbook steps the assignee follows; absent = the default template. */
  runbook?: string[];
}

/** Settings stored in instance_settings.general. Default route: adm-devops. */
export interface AlertRouteSettings {
  /** Company id these settings belong to. */
  companyId: string;
  /** Routes; the first matching rule wins. */
  routes: AlertRouteRule[];
  /** Assignee when no rule matches. */
  defaultAssignee: string;
  /** Secret NAME holding the webhook token value. */
  tokenSecretName: string;
}

export const DEFAULT_ALERT_ROUTE_ASSIGNEE = "adm-devops";

export const MAX_ALERT_ROUTES = 50;

/**
 * Picks the assignee for an alert: first rule whose `match` is a substring of
 * the title (both lowercase) wins, otherwise the default. Empty rules are
 * skipped so an operator can disable one without deleting it.
 */
export function routeAssignee(
  alert: NormalizedAlert,
  routes: AlertRouteRule[],
  defaultAssignee: string = DEFAULT_ALERT_ROUTE_ASSIGNEE,
): string {
  return routeMatch(alert, routes)?.assignee ?? defaultAssignee;
}

/** The first rule matching the alert title, or null (the default route). */
export function routeMatch(alert: NormalizedAlert, routes: AlertRouteRule[]): AlertRouteRule | null {
  const title = alert.title.toLowerCase();
  for (const rule of routes) {
    const match = rule.match.trim().toLowerCase();
    if (!match || !rule.assignee.trim()) continue;
    if (title.includes(match)) return rule;
  }
  return null;
}

/** The generic runbook template when neither the route nor the operator gives steps. */
export const DEFAULT_ALERT_RUNBOOK: string[] = [
  "Acknowledge the alert and open the source link in the issue description.",
  "Identify the affected host(s) and check the alert-specific metric.",
  "Apply the standard remediation for the alert type.",
  "Verify the alert clears in the monitoring system; this issue closes automatically on recovery.",
  "If the alert does not clear within 30 minutes, escalate to the on-call engineer.",
];

/** The title of the board issue for one alert. */
export function issueTitleFor(alert: NormalizedAlert): string {
  const hosts = alert.hosts.length > 0 ? ` — ${alert.hosts.join(", ")}` : "";
  return `[${alert.source}] ${alert.title}${hosts}`;
}

/** The body of the board issue for one alert, including the source link and the runbook. */
export function issueBodyFor(alert: NormalizedAlert, runbook: string[] = DEFAULT_ALERT_RUNBOOK): string {
  const steps = runbook.filter((s) => typeof s === "string" && s.trim().length > 0);
  const lines = [
    `Monitoring alert from ${alert.source}.`,
    "",
    `- Alert: ${alert.title}`,
    `- Key: ${alert.key}`,
    alert.hosts.length > 0 ? `- Hosts: ${alert.hosts.join(", ")}` : null,
    `- Severity: ${alert.severity}`,
    alert.startedAt ? `- Started: ${alert.startedAt}` : null,
    alert.url ? `- Source: ${alert.url}` : null,
    "",
    "## Runbook",
    ...steps.map((step, i) => `${i + 1}. ${step.trim()}`),
    "",
    "The issue auto-closes when the alert recovers.",
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

/** Comment body posted on a repeated firing alert. */
export function updateCommentFor(alert: NormalizedAlert, receivedAt: Date): string {
  return `Alert still firing (received again at ${receivedAt.toISOString()}). Severity: ${alert.severity}.`;
}

/** Comment body posted when the alert recovers and the issue closes. */
export function resolvedCommentFor(alert: NormalizedAlert, resolvedAt: string | null): string {
  const when = resolvedAt ? new Date(resolvedAt).toISOString() : "recovery time unknown";
  return `Recovered: the ${alert.source} alert ${alert.title} reported resolved at ${when}. Closing automatically.`;
}

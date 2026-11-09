// server/src/myrmidon/monitoring/zabbix-sink/domain.ts
// myrmidon(1.7-ZABBIX-SINK): pure rules of the Zabbix alarm sink. Turns one
// Zabbix media-type event into a role-task draft: title from the trigger name,
// priority from the Zabbix severity, the Zabbix URL as the source link. The
// dedup identity is the eventid — a redelivery of the same event must land on
// the same draft, not a second task. No database, no network, no vendor
// imports: the route and the service stay testable without a container.

/** Board priorities, the same order the vendor status filter uses. */
export const SINK_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type SinkPriority = (typeof SINK_PRIORITIES)[number];

/** Zabbix severity codes a media-type payload may carry. */
export const ZABBIX_SINK_SEVERITY_CODES = [1, 2, 3, 4, 5] as const;
export type ZabbixSinkSeverityCode = (typeof ZABBIX_SINK_SEVERITY_CODES)[number];

const ZABBIX_SEVERITY_NAMES: Record<number, string> = {
  1: "information",
  2: "warning",
  3: "average",
  4: "high",
  5: "disaster",
};

/** Maps a Zabbix severity code to a board priority: 4/5 are critical. */
export function zabbixSinkPriority(severityCode: number): SinkPriority {
  if (severityCode >= 4) return "critical";
  if (severityCode === 3) return "high";
  if (severityCode === 2) return "medium";
  return "low";
}

/** A parsed, validated Zabbix event ready to become a role-task draft. */
export interface ZabbixSinkEvent {
  /** Stable event identity used for dedup: the Zabbix eventid. */
  eventId: string;
  triggerId: string | null;
  /** The board issue title: taken from the trigger name. */
  title: string;
  severity: string;
  severityCode: number | null;
  priority: SinkPriority;
  hosts: string[];
  startedAt: string | null;
  /** Source link for the issue description. */
  url: string | null;
  message: string | null;
}

/** Raw Zabbix media-type webhook payload (one event). */
export interface ZabbixSinkPayload {
  triggerid?: string | number;
  trigger_id?: string | number;
  triggerId?: string | number;
  eventid?: string | number;
  event_date?: string;
  event_time?: string | number;
  name?: string;
  message?: string;
  timestamp?: string;
  severity?: string | number;
  status?: string;
  hosts?: string;
  host?: string;
  url?: string;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Parses and validates one Zabbix event. Returns null when the payload is not
 * a Zabbix event or carries no identity/title, so the route answers 400
 * without guessing. The eventid is the dedup identity required by the sink.
 */
export function parseZabbixSinkEvent(raw: unknown): ZabbixSinkEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const payload = raw as ZabbixSinkPayload;
  const eventId = asString(payload.eventid);
  const title = asString(payload.name);
  if (!eventId || !title) return null;
  const triggerId = asString(payload.triggerid ?? payload.trigger_id ?? payload.triggerId);
  const severityCode = (() => {
    const parsed = Number(asString(payload.severity));
    return Number.isFinite(parsed) ? parsed : null;
  })();
  const status = asString(payload.status)?.toLowerCase() ?? "";
  if (status === "resolved" || status === "closed" || status === "ok") return null;
  const hosts = (asString(payload.hosts) ?? asString(payload.host) ?? "")
    .split(/[,;|]/)
    .map((host) => host.trim())
    .filter(Boolean);
  const rawStarted = asString(payload.timestamp);
  const startedAt = rawStarted && !Number.isNaN(Date.parse(rawStarted))
    ? new Date(rawStarted).toISOString()
    : asString(payload.event_date) && asString(payload.event_time)
      ? `${asString(payload.event_date)}T${asString(payload.event_time)}Z`
      : null;
  return {
    eventId,
    triggerId,
    title,
    severity: severityCode !== null ? ZABBIX_SEVERITY_NAMES[severityCode] ?? "unknown" : asString(payload.severity) ?? "unknown",
    severityCode,
    priority: severityCode !== null ? zabbixSinkPriority(severityCode) : "high",
    hosts,
    startedAt,
    url: asString(payload.url),
    message: asString(payload.message),
  };
}

/** Draft issue title: the trigger name within the vendor title limit. */
export function sinkTitle(event: ZabbixSinkEvent): string {
  return event.title.slice(0, 200);
}

/** Draft issue body: what fired, the source link and the hosts, in order. */
export function sinkBody(event: ZabbixSinkEvent): string {
  const lines: string[] = [
    `Zabbix alarm sink (MONITORING-ZABBIX-SINK).`,
    "",
    `Event: ${event.eventId}`,
    `Trigger: ${event.title}`,
    `Severity: ${event.severity} -> priority ${event.priority}`,
  ];
  if (event.triggerId) lines.push(`Trigger id: ${event.triggerId}`);
  if (event.hosts.length > 0) lines.push(`Hosts: ${event.hosts.join(", ")}`);
  if (event.startedAt) lines.push(`Started at: ${event.startedAt}`);
  if (event.message) lines.push(`Message: ${event.message}`);
  if (event.url) lines.push(`Source: ${event.url}`);
  lines.push("", "Draft task: assigned when a role claims it.");
  return lines.join("\n");
}

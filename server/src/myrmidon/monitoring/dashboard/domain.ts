// server/src/myrmidon/monitoring/dashboard/domain.ts
// myrmidon(1.6.6 MONITORING C): the aggregation of one dashboard answer.
//
// GET /api/myrmidon/monitoring/dashboard answers one document:
//
//   {
//     ok: boolean,                  // every configured source answered
//     generatedAt: string,          // ISO instant of the snapshot
//     sources: SourceStatus[],      // per-source probe (name, ok, latency_ms)
//     hosts: HostReading[],         // one card per fleet host
//     containers: ContainerReading[], // bot containers (cAdvisor), when VM has them
//     litellm: LiteLlmReading | null, // LiteLLM proxy health, when VM has it
//     vps: VpsReading | null          // build VPS rollup, when labeled in VM
//   }
//
// This CONTRACT is frozen for the fleet screen (OPE-3918): fields are only
// added, never renamed or dropped. Host cards carry a `runbookKey` — the key
// of the alert-recovery runbook (part B mapping) the "Create task with
// runbook" action uses; the runbook content itself is part D.

export interface SourceStatus {
  name: "victoriametrics" | "zabbix";
  ok: boolean;
  latency_ms: number | null;
  /** Machine-readable failure class when ok=false (e.g. "not_configured", "http_502", "timeout"). */
  error: string | null;
}

export interface HostReading {
  /** Stable identity: the VM instance label, or the Zabbix host name when VM has no data. */
  name: string;
  /** Where the numbers came from; "none" when the host is known but unreadable. */
  origin: "victoriametrics" | "zabbix" | "none";
  cpuPercent: number | null;
  memoryPercent: number | null;
  swapPercent: number | null;
  diskPercent: number | null;
  /** Seconds since the freshest sample; null when unknown. */
  ageSec: number | null;
  /** Runbook key for the "create task with runbook" CTA (part B mapping; content is part D). */
  runbookKey: string | null;
}

export interface ContainerReading {
  name: string;
  /** Container CPU usage, percent of one core. */
  cpuPercent: number | null;
  /** Resident memory, bytes. */
  memoryBytes: number | null;
  state: "running" | "stopped" | "unknown";
}

export interface LiteLlmReading {
  ok: boolean;
  /** Requests per second over the last 5 minutes, when the proxy exports them. */
  rps: number | null;
  /** p95 latency seconds over the last 5 minutes, when exported. */
  latencyP95Sec: number | null;
}

export interface VpsReading {
  /** Rollup of the build VPS (host labeled role="build" in VM). */
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
}

export interface DashboardView {
  ok: boolean;
  generatedAt: string;
  sources: SourceStatus[];
  hosts: HostReading[];
  containers: ContainerReading[];
  litellm: LiteLlmReading | null;
  vps: VpsReading | null;
}

export function emptyDashboardView(generatedAt: string): DashboardView {
  return { ok: false, generatedAt, sources: [], hosts: [], containers: [], litellm: null, vps: null };
}

/**
 * Classify an error thrown by a source client into the machine-readable
 * `error` field of a source status, without leaking any token or URL detail.
 */
export function classifySourceError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
    const http = /HTTP (\d{3})/.exec(err.message);
    if (http) return `http_${http[1]}`;
    if (/not configured|token reference/i.test(err.message)) return "not_configured";
    return "request_failed";
  }
  return "request_failed";
}

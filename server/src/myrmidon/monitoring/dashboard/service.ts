// server/src/myrmidon/monitoring/dashboard/service.ts
// myrmidon(1.6.6 MONITORING C): builds the one dashboard answer.
//
// The service queries both configured sources and merges per host: VM
// (node_exporter PromQL) wins when a host has fresh VM data, Zabbix items
// fill in the hosts VM does not see. A source that is not configured is
// reported as not_configured, a source that fails degrades to error — the
// dashboard still answers with whatever the other source returned.

import {
  classifySourceError,
  emptyDashboardView,
  type ContainerReading,
  type DashboardView,
  type HostReading,
  type LiteLlmReading,
  type SourceStatus,
  type VpsReading,
} from "./domain.js";
import type { MonitoringConnectionSettings } from "./settings.js";
import type { VmClient } from "./vm.js";
import type { ZabbixReadClient } from "./zabbix.js";
import { DASHBOARD_ZABBIX_ITEM_KEYS } from "./zabbix.js";

export interface DashboardServiceDeps {
  settings: MonitoringConnectionSettings;
  /** Present only when vmUrl is configured. */
  vm?: VmClient | null;
  /** Present only when zabbixUrl is configured. */
  zabbix?: ZabbixReadClient | null;
  now?: () => Date;
}

/** PromQL templates of the host readings (job selector interpolated). */
export function dashboardHostQueries(jobSelector: string) {
  const sel = `{job=~"${jobSelector}"}`;
  return {
    cpu: `100 - (avg by (instance) (rate(node_cpu_seconds_total${sel.replace("}", ',mode="idle"}')}[5m])) * 100)`,
    memory: `(1 - (node_memory_MemAvailable_bytes${sel} / node_memory_MemTotal_bytes${sel})) * 100`,
    swap: `(1 - (node_memory_SwapFree_bytes${sel} / node_memory_SwapTotal_bytes${sel})) * 100`,
    disk: `(1 - (node_filesystem_avail_bytes${sel.replace("}", ',mountpoint="/",fstype!~"tmpfs|overlay"}')} / node_filesystem_size_bytes${sel.replace("}", ',mountpoint="/",fstype!~"tmpfs|overlay"}')})) * 100`,
    up: `up${sel}`,
  };
}

export const DASHBOARD_CONTAINER_QUERIES = {
  cpu: `sum by (name) (rate(container_cpu_usage_seconds_total{name=~".+"}[5m])) * 100`,
  memory: `container_memory_working_set_bytes{name=~".+"}`,
};

export const DASHBOARD_LITELLM_QUERIES = {
  rps: `sum(rate(litellm_proxy_total_requests_metric[5m]))`,
  latencyP95: `histogram_quantile(0.95, sum(rate(litellm_request_latency_seconds_bucket[5m])) by (le))`,
};

function sampleAgeSec(timestampSec: number, now: Date): number | null {
  if (!timestampSec) return null;
  return Math.max(0, Math.round(now.getTime() / 1000 - timestampSec));
}

function numberOrNull(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : null;
}

/** Default runbook mapping (part B keys, content is part D): host trouble goes to the infra owner. */
export function defaultRunbookKey(host: HostReading): string | null {
  if (host.origin === "none") return "host-unreachable";
  const worst = Math.max(
    host.cpuPercent ?? 0,
    host.memoryPercent ?? 0,
    host.swapPercent ?? 0,
    host.diskPercent ?? 0,
  );
  if (worst >= 90) return "host-saturation";
  if ((host.diskPercent ?? 0) >= 85) return "host-disk-pressure";
  return null;
}

export async function buildDashboardView(deps: DashboardServiceDeps): Promise<DashboardView> {
  const now = deps.now ?? (() => new Date());
  const view = emptyDashboardView(now().toISOString());
  const sources: SourceStatus[] = [];

  const vmHosts = new Map<string, HostReading>();
  let vmOk = false;
  if (deps.vm && deps.settings.vmUrl) {
    const started = Date.now();
    try {
      const q = dashboardHostQueries(deps.settings.vmJobSelector);
      const [cpu, memory, swap, disk, up] = await Promise.all([
        deps.vm.query(q.cpu),
        deps.vm.query(q.memory),
        deps.vm.query(q.swap),
        deps.vm.query(q.disk),
        deps.vm.query(q.up),
      ]);
      vmOk = true;
      sources.push({ name: "victoriametrics", ok: true, latency_ms: Date.now() - started, error: null });
      const put = (name: string, patch: Partial<HostReading>, age: number | null) => {
        const current = vmHosts.get(name) ?? {
          name,
          origin: "victoriametrics" as const,
          cpuPercent: null,
          memoryPercent: null,
          swapPercent: null,
          diskPercent: null,
          ageSec: age,
          runbookKey: null,
        };
        vmHosts.set(name, { ...current, ...patch, ageSec: age ?? current.ageSec });
      };
      for (const s of cpu) put(s.metric.instance ?? "unknown", { cpuPercent: s.value }, sampleAgeSec(s.timestampSec, now()));
      for (const s of memory) put(s.metric.instance ?? "unknown", { memoryPercent: s.value }, sampleAgeSec(s.timestampSec, now()));
      for (const s of swap) put(s.metric.instance ?? "unknown", { swapPercent: s.value }, sampleAgeSec(s.timestampSec, now()));
      for (const s of disk) put(s.metric.instance ?? "unknown", { diskPercent: s.value }, sampleAgeSec(s.timestampSec, now()));
      for (const s of up) {
        const name = s.metric.instance ?? "unknown";
        if (s.value === 0) put(name, { origin: "victoriametrics" }, sampleAgeSec(s.timestampSec, now()));
      }
    } catch (err) {
      sources.push({
        name: "victoriametrics",
        ok: false,
        latency_ms: Date.now() - started,
        error: classifySourceError(err),
      });
    }
  } else {
    sources.push({ name: "victoriametrics", ok: false, latency_ms: null, error: "not_configured" });
  }

  const zabbixHosts = new Map<string, HostReading>();
  let zabbixOk = false;
  if (deps.zabbix && deps.settings.zabbixUrl) {
    const started = Date.now();
    try {
      const readings = await deps.zabbix.hostReadings([...DASHBOARD_ZABBIX_ITEM_KEYS]);
      zabbixOk = true;
      sources.push({ name: "zabbix", ok: true, latency_ms: Date.now() - started, error: null });
      for (const reading of readings) {
        const host: HostReading = {
          name: reading.name || reading.host,
          origin: "zabbix",
          cpuPercent: numberOrNull(reading.items["system.cpu.util"]),
          memoryPercent: numberOrNull(reading.items["vm.memory.utilization"]),
          swapPercent:
            numberOrNull(reading.items["system.swap.size[,pfree]"]) != null
              ? 100 - numberOrNull(reading.items["system.swap.size[,pfree]"])!
              : null,
          diskPercent: numberOrNull(reading.items["vfs.fs.size[/,pused]"]),
          ageSec: null,
          runbookKey: null,
        };
        zabbixHosts.set(host.name, host);
      }
    } catch (err) {
      sources.push({ name: "zabbix", ok: false, latency_ms: Date.now() - started, error: classifySourceError(err) });
    }
  } else {
    // Unwired (no client — tests, selective deployments) or unconfigured:
    // report not_configured; the probe list always carries both sources so
    // the fleet screen can render their status cards.
    sources.push({ name: "zabbix", ok: false, latency_ms: null, error: "not_configured" });
  }

  // Merge: VM wins when it has the host, Zabbix-only hosts are appended.
  const hosts = [...vmHosts.values()];
  for (const [name, host] of zabbixHosts) {
    if (!vmHosts.has(name)) hosts.push(host);
  }
  for (const host of hosts) host.runbookKey = defaultRunbookKey(host);
  hosts.sort((a, b) => a.name.localeCompare(b.name));

  const containers: ContainerReading[] = [];
  let litellm: LiteLlmReading | null = null;
  let vps: VpsReading | null = null;
  if (vmOk && deps.vm) {
    try {
      const [cCpu, cMem] = await Promise.all([
        deps.vm.query(DASHBOARD_CONTAINER_QUERIES.cpu),
        deps.vm.query(DASHBOARD_CONTAINER_QUERIES.memory),
      ]);
      const memByName = new Map(cMem.map((s) => [s.metric.name ?? "unknown", s.value]));
      for (const s of cCpu) {
        const name = s.metric.name ?? "unknown";
        containers.push({
          name,
          cpuPercent: s.value,
          memoryBytes: memByName.get(name) ?? null,
          state: "running",
        });
      }
      containers.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      // container readings are best-effort; the host cards stay
    }
    try {
      const [rps, p95] = await Promise.all([
        deps.vm.query(DASHBOARD_LITELLM_QUERIES.rps),
        deps.vm.query(DASHBOARD_LITELLM_QUERIES.latencyP95),
      ]);
      if (rps.length > 0 || p95.length > 0) {
        litellm = { ok: true, rps: rps[0]?.value ?? null, latencyP95Sec: p95[0]?.value ?? null };
      }
    } catch {
      // litellm readings are best-effort
    }
    const buildHost = hosts.find((h) => /build|vps/i.test(h.name));
    if (buildHost) {
      vps = {
        cpuPercent: buildHost.cpuPercent,
        memoryPercent: buildHost.memoryPercent,
        diskPercent: buildHost.diskPercent,
      };
    }
  }

  view.sources = sources;
  view.hosts = hosts;
  view.containers = containers;
  view.litellm = litellm;
  view.vps = vps;
  view.ok = sources.some((s) => s.ok) && sources.filter((s) => s.error !== "not_configured").every((s) => s.ok);
  return view;
}

/** Selfcheck: probe each configured source (VM `up`, Zabbix `apiinfo.version`). */
export async function buildSelfcheckView(deps: DashboardServiceDeps): Promise<{
  ok: boolean;
  vm_ok: boolean;
  zabbix_ok: boolean;
  sources: SourceStatus[];
}> {
  const sources: SourceStatus[] = [];
  let vm_ok = false;
  if (deps.vm && deps.settings.vmUrl) {
    const started = Date.now();
    try {
      await deps.vm.query("up");
      vm_ok = true;
      sources.push({ name: "victoriametrics", ok: true, latency_ms: Date.now() - started, error: null });
    } catch (err) {
      sources.push({ name: "victoriametrics", ok: false, latency_ms: Date.now() - started, error: classifySourceError(err) });
    }
  } else {
    sources.push({ name: "victoriametrics", ok: false, latency_ms: null, error: "not_configured" });
  }
  let zabbix_ok = false;
  if (deps.zabbix && deps.settings.zabbixUrl) {
    const started = Date.now();
    try {
      await deps.zabbix.apiVersion();
      zabbix_ok = true;
      sources.push({ name: "zabbix", ok: true, latency_ms: Date.now() - started, error: null });
    } catch (err) {
      sources.push({ name: "zabbix", ok: false, latency_ms: Date.now() - started, error: classifySourceError(err) });
    }
  } else {
    sources.push({ name: "zabbix", ok: false, latency_ms: null, error: "not_configured" });
  }
  const configured = sources.filter((s) => s.error !== "not_configured");
  return { ok: configured.length > 0 && configured.every((s) => s.ok), vm_ok, zabbix_ok, sources };
}

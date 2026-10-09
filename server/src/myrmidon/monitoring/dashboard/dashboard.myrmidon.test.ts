// server/src/myrmidon/monitoring/dashboard/dashboard.myrmidon.test.ts
// myrmidon(1.6.6 MONITORING C): the unit suite of the fleet dashboard module.
//
// The clients are fakes at the module seams (no network, no database): what
// is pinned here is the contract the fleet screen consumes — the aggregated
// shape, the per-source status lines, the secret-free settings view, and the
// selfcheck answer.

import { describe, expect, it } from "vitest";
import {
  buildDashboardView,
  buildSelfcheckView,
  dashboardHostQueries,
  defaultRunbookKey,
} from "./service.js";
import { classifySourceError } from "./domain.js";
import {
  DEFAULT_MONITORING_CONNECTION_SETTINGS,
  monitoringConnectionSettingsSchema,
  monitoringSettingsView,
} from "./settings.js";
import { VictoriaMetricsError, vmClient } from "./vm.js";
import { ZabbixReadError, zabbixReadClient } from "./zabbix.js";
import { resolveMonitoringTokenRef } from "./token.js";
import type { VmClient, VmVectorSample } from "./vm.js";
import type { ZabbixReadClient } from "./zabbix.js";

const SETTINGS = {
  ...DEFAULT_MONITORING_CONNECTION_SETTINGS,
  vmUrl: "http://vm:8428",
  zabbixUrl: "http://zabbix/api_jsonrpc.php",
};

function fakeVm(samples: Record<string, VmVectorSample[]>): VmClient {
  return {
    async query(promql: string) {
      for (const [key, value] of Object.entries(samples)) {
        if (promql.includes(key)) return value;
      }
      return [];
    },
  };
}

function failingVm(err: Error): VmClient {
  return {
    async query() {
      throw err;
    },
  };
}

function fakeZabbix(hosts: Array<{ host: string; name: string; items: Record<string, string> }>): ZabbixReadClient {
  return {
    async apiVersion() {
      return "7.0.0";
    },
    async hostReadings() {
      return hosts.map((h, i) => ({ hostid: String(i + 1), host: h.host, name: h.name, items: h.items }));
    },
  };
}

function failingZabbix(err: Error): ZabbixReadClient {
  return {
    async apiVersion() {
      throw err;
    },
    async hostReadings() {
      throw err;
    },
  };
}

const NOW = new Date("2026-10-09T12:00:00.000Z");

describe("monitoring dashboard service (myrmidon 1.6.6 MONITORING C)", () => {
  it("aggregates VM host readings into the dashboard contract", async () => {
    const vm = fakeVm({
      node_cpu_seconds_total: [{ metric: { instance: "vm-core" }, value: 42.5, timestampSec: NOW.getTime() / 1000 - 30 }],
      node_memory_MemAvailable_bytes: [
        { metric: { instance: "vm-core" }, value: 61.2, timestampSec: NOW.getTime() / 1000 - 30 },
      ],
      node_memory_SwapFree_bytes: [
        { metric: { instance: "vm-core" }, value: 3.1, timestampSec: NOW.getTime() / 1000 - 30 },
      ],
      node_filesystem_avail_bytes: [
        { metric: { instance: "vm-core" }, value: 88.4, timestampSec: NOW.getTime() / 1000 - 30 },
      ],
    });
    const view = await buildDashboardView({ settings: SETTINGS, vm, zabbix: null, now: () => NOW });
    expect(view.sources.find((s) => s.name === "victoriametrics")?.ok).toBe(true);
    expect(view.sources.find((s) => s.name === "zabbix")?.ok).toBe(true);
    const host = view.hosts.find((h) => h.name === "vm-core");
    expect(host).toBeDefined();
    expect(host?.cpuPercent).toBeCloseTo(42.5);
    expect(host?.memoryPercent).toBeCloseTo(61.2);
    expect(host?.swapPercent).toBeCloseTo(3.1);
    expect(host?.diskPercent).toBeCloseTo(88.4);
    expect(host?.origin).toBe("victoriametrics");
    expect(host?.ageSec).toBe(30);
    expect(host?.runbookKey).toBe("host-disk-pressure");
  });

  it("merges Zabbix-only hosts alongside VM hosts", async () => {
    const vm = fakeVm({
      node_cpu_seconds_total: [{ metric: { instance: "vm-core" }, value: 10, timestampSec: 0 }],
    });
    const zabbix = fakeZabbix([
      {
        host: "build-vps",
        name: "build-vps",
        items: {
          "system.cpu.util": "55",
          "vm.memory.utilization": "70",
          "vfs.fs.size[/,pused]": "91",
        },
      },
    ]);
    const view = await buildDashboardView({ settings: SETTINGS, vm, zabbix, now: () => NOW });
    const names = view.hosts.map((h) => h.name).sort();
    expect(names).toEqual(["build-vps", "vm-core"]);
    const vps = view.hosts.find((h) => h.name === "build-vps");
    expect(vps?.origin).toBe("zabbix");
    expect(vps?.cpuPercent).toBe(55);
    expect(vps?.diskPercent).toBe(91);
    // the build VPS rollup surfaces for the fleet screen
    expect(view.vps?.diskPercent).toBe(91);
  });

  it("degrades cleanly when a source fails", async () => {
    const vm = failingVm(new VictoriaMetricsError("VictoriaMetrics query returned HTTP 502"));
    const zabbix = fakeZabbix([
      { host: "vm-core", name: "vm-core", items: { "system.cpu.util": "12" } },
    ]);
    const view = await buildDashboardView({ settings: SETTINGS, vm, zabbix, now: () => NOW });
    const vmSource = view.sources.find((s) => s.name === "victoriametrics");
    expect(vmSource?.ok).toBe(false);
    expect(vmSource?.error).toBe("http_502");
    expect(view.hosts.some((h) => h.name === "vm-core" && h.origin === "zabbix")).toBe(true);
    // one failing source does not flip the whole answer to broken
    expect(view.ok).toBe(false);
  });

  it("reports not_configured sources without calling them", async () => {
    const view = await buildDashboardView({
      settings: DEFAULT_MONITORING_CONNECTION_SETTINGS,
      vm: null,
      zabbix: null,
      now: () => NOW,
    });
    expect(view.sources).toEqual([
      { name: "victoriametrics", ok: false, latency_ms: null, error: "not_configured" },
      { name: "zabbix", ok: false, latency_ms: null, error: "not_configured" },
    ]);
    expect(view.hosts).toEqual([]);
    expect(view.ok).toBe(false);
  });

  it("selfcheck probes both sources and never carries secrets", async () => {
    const good = await buildSelfcheckView({
      settings: SETTINGS,
      vm: fakeVm({ up: [{ metric: {}, value: 1, timestampSec: 0 }] }),
      zabbix: fakeZabbix([]),
    });
    expect(good).toMatchObject({ ok: true, vm_ok: true, zabbix_ok: true });
    expect(good.sources.map((s) => s.name).sort()).toEqual(["victoriametrics", "zabbix"]);
    expect(JSON.stringify(good)).not.toContain("token");

    const bad = await buildSelfcheckView({
      settings: SETTINGS,
      vm: failingVm(new Error("connect ECONNREFUSED")),
      zabbix: failingZabbix(new Error("TimeoutError")),
    });
    expect(bad.ok).toBe(false);
    expect(bad.vm_ok).toBe(false);
    expect(bad.zabbix_ok).toBe(false);
  });

  it("runbook mapping picks the dominant host trouble", () => {
    expect(
      defaultRunbookKey({
        name: "h",
        origin: "none",
        cpuPercent: null,
        memoryPercent: null,
        swapPercent: null,
        diskPercent: null,
        ageSec: null,
        runbookKey: null,
      }),
    ).toBe("host-unreachable");
    expect(
      defaultRunbookKey({
        name: "h",
        origin: "victoriametrics",
        cpuPercent: 95,
        memoryPercent: 40,
        swapPercent: 0,
        diskPercent: 50,
        ageSec: 10,
        runbookKey: null,
      }),
    ).toBe("host-saturation");
    expect(
      defaultRunbookKey({
        name: "h",
        origin: "victoriametrics",
        cpuPercent: 20,
        memoryPercent: 30,
        swapPercent: 0,
        diskPercent: 87,
        ageSec: 10,
        runbookKey: null,
      }),
    ).toBe("host-disk-pressure");
  });

  it("classifySourceError keeps the machine-readable classes", () => {
    expect(classifySourceError(new VictoriaMetricsError("VictoriaMetrics query returned HTTP 502"))).toBe("http_502");
    expect(classifySourceError(new ZabbixReadError("Zabbix host.get returned HTTP 401"))).toBe("http_401");
    expect(classifySourceError(Object.assign(new Error("boom"), { name: "TimeoutError" }))).toBe("timeout");
    expect(classifySourceError(new Error("connect ECONNREFUSED"))).toBe("request_failed");
  });
});

describe("monitoring dashboard settings (myrmidon 1.6.6 MONITORING C)", () => {
  it("defaults keep both sources off and carry no secret values", () => {
    const view = monitoringSettingsView(DEFAULT_MONITORING_CONNECTION_SETTINGS);
    expect(view.vmUrl).toBeNull();
    expect(view.zabbixUrl).toBeNull();
    expect(view.vmTokenRef).toBeNull();
    expect(view.zabbixTokenRef).toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/pcp_|Bearer/i);
  });

  it("rejects token references that are not env:/file:", () => {
    expect(
      monitoringConnectionSettingsSchema.safeParse({ vmTokenRef: "plain-token-value" }).success,
    ).toBe(false);
    expect(monitoringConnectionSettingsSchema.safeParse({ vmTokenRef: "env:VM_TOKEN" }).success).toBe(true);
  });

  it("resolveMonitoringTokenRef resolves env: refs and never the value", () => {
    const token = resolveMonitoringTokenRef("env:MY_TEST_TOKEN", { env: { MY_TEST_TOKEN: "secret-value" } });
    expect(token).toBe("secret-value");
    expect(resolveMonitoringTokenRef(null)).toBeNull();
    expect(() => resolveMonitoringTokenRef("literal", {})).toThrow(/env:<NAME>|file:<PATH>/);
  });
});

describe("monitoring dashboard clients (myrmidon 1.6.6 MONITORING C)", () => {
  it("the VM client issues instant queries and parses vector samples", async () => {
    const calls: string[] = [];
    const vm = vmClient(
      { url: "http://vm:8428/", tokenRef: null, timeoutMs: 1000 },
      {
        fetch: async (input) => {
          calls.push(String(input));
          return new Response(
            JSON.stringify({
              status: "success",
              data: {
                resultType: "vector",
                result: [
                  { metric: { instance: "vm-core" }, value: [1700000000, "12.5"] },
                  { metric: { instance: "broken" }, value: [1700000000, "NaN"] },
                ],
              },
            }),
            { status: 200 },
          );
        },
      },
    );
    const samples = await vm.query('up{job="node"}');
    expect(calls[0]).toContain("/api/v1/query?query=");
    expect(calls[0]).toContain(encodeURIComponent('up{job="node"}'));
    expect(samples).toEqual([{ metric: { instance: "vm-core" }, value: 12.5, timestampSec: 1700000000 }]);
  });

  it("the VM client sends the resolved bearer token and no other auth", async () => {
    let seenAuth: string | null = null;
    const vm = vmClient(
      { url: "http://vm:8428", tokenRef: "env:VM_TOK", timeoutMs: 1000 },
      {
        fetch: async (_input, init) => {
          seenAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
          return new Response(JSON.stringify({ status: "success", data: { result: [] } }), { status: 200 });
        },
        token: { env: { VM_TOK: "tok-123" } },
      },
    );
    await vm.query("up");
    expect(seenAuth).toBe("Bearer tok-123");
  });

  it("the Zabbix read client only calls read methods", async () => {
    const methods: string[] = [];
    const zabbix = zabbixReadClient(
      { url: "http://zabbix/api_jsonrpc.php", tokenRef: null, hostGroups: [], timeoutMs: 1000 },
      {
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body));
          methods.push(body.method);
          if (body.method === "host.get") {
            return new Response(
              JSON.stringify({ result: [{ hostid: "1", host: "vm-core", name: "vm-core" }] }),
              { status: 200 },
            );
          }
          if (body.method === "item.get") {
            return new Response(
              JSON.stringify({ result: [{ hostid: "1", key_: "system.cpu.util", lastvalue: "33" }] }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ result: "7.0.0" }), { status: 200 });
        },
      },
    );
    expect(await zabbix.apiVersion()).toBe("7.0.0");
    const readings = await zabbix.hostReadings(["system.cpu.util"]);
    expect(readings).toEqual([{ hostid: "1", host: "vm-core", name: "vm-core", items: { "system.cpu.util": "33" } }]);
    for (const method of methods) {
      expect(["apiinfo.version", "hostgroup.get", "host.get", "item.get"]).toContain(method);
    }
  });
});

describe("dashboard PromQL (myrmidon 1.6.6 MONITORING C)", () => {
  it("host queries embed the job selector", () => {
    const q = dashboardHostQueries("node");
    expect(q.cpu).toContain('job=~"node"');
    expect(q.memory).toContain("node_memory_MemAvailable_bytes");
    expect(q.disk).toContain('mountpoint="/"');
    expect(q.up).toBe('up{job=~"node"}');
  });
});

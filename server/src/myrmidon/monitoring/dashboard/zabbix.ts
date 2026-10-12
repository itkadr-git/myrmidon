// server/src/myrmidon/monitoring/dashboard/zabbix.ts
// myrmidon(1.6.6 MONITORING C): the Zabbix read side of the fleet dashboard.
//
// READ-ONLY by construction: the only methods used are `apiinfo.version`,
// `host.get` and `item.get`; there is no create/update/delete call in this
// module. The token is resolved from an env:/file: reference per call and is
// never logged, never returned.

import { resolveMonitoringTokenRef, type TokenRefDeps } from "./token.js";
import type { Fetch } from "./vm.js";

export class ZabbixReadError extends Error {}

export interface ZabbixReadSettings {
  url: string;
  tokenRef: string | null;
  hostGroups: string[];
  timeoutMs: number;
}

export interface ZabbixHostReading {
  hostid: string;
  host: string;
  name: string;
  /** Map of item key -> latest value (string as Zabbix reports). */
  items: Record<string, string>;
}

export interface ZabbixReadClient {
  /** apiinfo.version probe; resolves with the server version string. */
  apiVersion(): Promise<string>;
  /** Latest values of the requested item keys per host of the configured groups. */
  hostReadings(itemKeys: string[]): Promise<ZabbixHostReading[]>;
}

interface JsonRpcBody {
  jsonrpc: string;
  method: string;
  params: unknown;
  id: number;
  auth?: string;
}

export function zabbixReadClient(
  settings: ZabbixReadSettings,
  deps: { fetch?: Fetch; token?: TokenRefDeps & { resolve?: () => string | null } } = {},
): ZabbixReadClient {
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  let requestId = 0;

  async function token(): Promise<string | null> {
    if (deps.token?.resolve) return deps.token.resolve();
    return resolveMonitoringTokenRef(settings.tokenRef, deps.token ?? {});
  }

  async function call<T>(method: string, params: unknown): Promise<T> {
    requestId += 1;
    const body: JsonRpcBody = { jsonrpc: "2.0", method, params, id: requestId };
    const resolved = await token();
    if (resolved) body.auth = resolved;
    let response: Response;
    try {
      response = await doFetch(settings.url, {
        method: "POST",
        headers: { "content-type": "application/json-rpc" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
    } catch (err) {
      throw new ZabbixReadError(
        `Zabbix ${method} request failed: ${err instanceof Error ? err.name : "error"}`,
      );
    }
    if (!response.ok) throw new ZabbixReadError(`Zabbix ${method} returned HTTP ${response.status}`);
    const parsed = (await response.json().catch(() => null)) as
      | { result?: T; error?: { code?: number; message?: string; data?: string } }
      | null;
    if (!parsed) throw new ZabbixReadError(`Zabbix ${method} returned a non-JSON body`);
    if (parsed.error) {
      throw new ZabbixReadError(
        `Zabbix ${method} error ${parsed.error.code ?? ""}: ${parsed.error.message ?? ""} ${parsed.error.data ?? ""}`.trim(),
      );
    }
    return parsed.result as T;
  }

  return {
    async apiVersion() {
      // apiinfo.version is the canonical no-auth probe of the Zabbix API.
      return call<string>("apiinfo.version", []);
    },

    async hostReadings(itemKeys: string[]): Promise<ZabbixHostReading[]> {
      let groupids: string[] | undefined;
      if (settings.hostGroups.length > 0) {
        const groups = await call<Array<{ groupid: string; name: string }>>("hostgroup.get", {
          output: ["groupid", "name"],
          filter: { name: settings.hostGroups },
        });
        groupids = groups.map((group) => group.groupid);
        if (groupids.length === 0) return [];
      }
      const hosts = await call<Array<{ hostid: string; host: string; name: string }>>("host.get", {
        output: ["hostid", "host", "name"],
        ...(groupids ? { groupids } : {}),
        filter: { status: 0 }, // monitored hosts only
      });
      if (hosts.length === 0 || itemKeys.length === 0) {
        return hosts.map((host) => ({ hostid: host.hostid, host: host.host, name: host.name, items: {} }));
      }
      const items = await call<
        Array<{ hostid: string; key_: string; lastvalue: string }>
      >("item.get", {
        output: ["hostid", "key_", "lastvalue"],
        hostids: hosts.map((host) => host.hostid),
        filter: { key_: itemKeys },
        monitored: true,
      });
      const byHost = new Map<string, Record<string, string>>();
      for (const item of items) {
        const bucket = byHost.get(item.hostid) ?? {};
        bucket[item.key_] = item.lastvalue;
        byHost.set(item.hostid, bucket);
      }
      return hosts.map((host) => ({
        hostid: host.hostid,
        host: host.host,
        name: host.name,
        items: byHost.get(host.hostid) ?? {},
      }));
    },
  };
}

/** The Zabbix item keys the dashboard reads (standard Zabbix-agent keys). */
export const DASHBOARD_ZABBIX_ITEM_KEYS = [
  "system.cpu.util",
  "vm.memory.utilization",
  "system.swap.size[,pfree]",
  "vfs.fs.size[/,pused]",
] as const;

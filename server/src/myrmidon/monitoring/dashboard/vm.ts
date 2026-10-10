// server/src/myrmidon/monitoring/dashboard/vm.ts
// myrmidon(1.6.6 MONITORING C): the VictoriaMetrics read client.
//
// READ-ONLY by construction: the only path used is `/api/v1/query` (PromQL
// instant query); there is no write/import call in this module. The optional
// token is resolved from an env:/file: reference per call and never logged.

import { resolveMonitoringTokenRef, type TokenRefDeps } from "./token.js";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class VictoriaMetricsError extends Error {}

export interface VmClientSettings {
  url: string;
  tokenRef: string | null;
  timeoutMs: number;
}

export interface VmVectorSample {
  /** Metric labels of the series. */
  metric: Record<string, string>;
  /** The sample value, parsed to a number. */
  value: number;
  /** Sample timestamp (seconds, as VictoriaMetrics reports). */
  timestampSec: number;
}

interface VmQueryResponse {
  status?: string;
  data?: {
    resultType?: string;
    result?: Array<{ metric?: Record<string, string>; value?: [number, string] }>;
  };
  error?: string;
}

export interface VmClient {
  /**
   * Instant PromQL query. Returns one sample per series; a series whose value
   * does not parse to a finite number is dropped.
   */
  query(promql: string): Promise<VmVectorSample[]>;
}

export function vmClient(
  settings: VmClientSettings,
  deps: { fetch?: Fetch; token?: TokenRefDeps & { resolve?: () => string | null } } = {},
): VmClient {
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const baseUrl = settings.url.endsWith("/") ? settings.url.slice(0, -1) : settings.url;

  async function token(): Promise<string | null> {
    if (deps.token?.resolve) return deps.token.resolve();
    return resolveMonitoringTokenRef(settings.tokenRef, deps.token ?? {});
  }

  return {
    async query(promql: string): Promise<VmVectorSample[]> {
      const url = `${baseUrl}/api/v1/query?query=${encodeURIComponent(promql)}`;
      const headers: Record<string, string> = { accept: "application/json" };
      const resolved = await token();
      if (resolved) headers.authorization = "Bearer " + resolved;
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(settings.timeoutMs),
        });
      } catch (err) {
        throw new VictoriaMetricsError(
          `VictoriaMetrics query failed: ${err instanceof Error ? err.name : "error"}`,
        );
      }
      if (!response.ok) {
        throw new VictoriaMetricsError(`VictoriaMetrics query returned HTTP ${response.status}`);
      }
      const body = (await response.json().catch(() => null)) as VmQueryResponse | null;
      if (!body || body.status !== "success" || !body.data || !Array.isArray(body.data.result)) {
        throw new VictoriaMetricsError(
          body?.error ? `VictoriaMetrics query error: ${body.error}` : "VictoriaMetrics query returned an unexpected body",
        );
      }
      const samples: VmVectorSample[] = [];
      for (const entry of body.data.result) {
        const raw = entry.value?.[1];
        const value = typeof raw === "string" ? Number(raw) : NaN;
        if (!Number.isFinite(value)) continue;
        samples.push({
          metric: entry.metric ?? {},
          value,
          timestampSec: typeof entry.value?.[0] === "number" ? entry.value[0] : 0,
        });
      }
      return samples;
    },
  };
}

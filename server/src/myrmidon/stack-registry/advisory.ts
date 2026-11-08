// Stack registry (SUA): advisory / CVE source integration (OSV.dev).
//
// Queries OSV.dev batch endpoint (POST /v1/querybatch) for stack component
// packages and versions. When vulnerabilities are found, extracts (id, severity)
// and marks components in the stack registry.
//
// Error contract: advisory sources are auxiliary. If OSV.dev is unreachable,
// returns 5xx or times out, the check degrades gracefully without failing the
// release check (components simply carry no advisory mark).

import type { StackFetchJson, StackHttpResponse } from "./releases.js";
import { STACK_HTTP_TIMEOUT_MS } from "./releases.js";
import type { StackAdvisoryPackage, StackVulnerability } from "./domain.js";

export { type StackAdvisoryPackage, type StackVulnerability };

export const DEFAULT_OSV_API_BASE = "https://api.osv.dev";
export const OSV_QUERY_BATCH_PATH = "/v1/querybatch";

export interface StackAdvisoryQuery {
  componentName: string;
  package: StackAdvisoryPackage;
  version: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract severity rating from an OSV vulnerability record.
 * Checks direct severity string, database_specific.severity, or CVSS vector/score.
 */
export function extractVulnSeverity(vuln: Record<string, unknown>): string {
  if (typeof vuln.severity === "string" && vuln.severity.trim()) {
    return vuln.severity.trim().toUpperCase();
  }
  if (isRecord(vuln.database_specific) && typeof vuln.database_specific.severity === "string") {
    return vuln.database_specific.severity.trim().toUpperCase();
  }
  if (Array.isArray(vuln.severity) && vuln.severity.length > 0) {
    for (const entry of vuln.severity) {
      if (isRecord(entry)) {
        if (typeof entry.severity === "string" && entry.severity.trim()) {
          return entry.severity.trim().toUpperCase();
        }
        if (typeof entry.score === "string" && entry.score.trim()) {
          const num = parseFloat(entry.score);
          if (!isNaN(num)) {
            if (num >= 9.0) return "CRITICAL";
            if (num >= 7.0) return "HIGH";
            if (num >= 4.0) return "MEDIUM";
            return "LOW";
          }
          if (entry.score.includes("/C:H") || entry.score.includes("/I:H") || entry.score.includes("/A:H")) {
            return "HIGH";
          }
        }
      }
    }
  }
  return "UNKNOWN";
}

/**
 * Extract canonical vulnerability ID and CVE alias (if present).
 * If a CVE alias exists in aliases, uses it as the primary id or cveId.
 */
export function extractVulnIdAndCve(vuln: Record<string, unknown>): { id: string; cveId: string | null } {
  const rawId = typeof vuln.id === "string" ? vuln.id.trim() : "UNKNOWN";
  const aliases = Array.isArray(vuln.aliases)
    ? vuln.aliases.filter((a): a is string => typeof a === "string")
    : [];
  const cveAlias = aliases.find((a) => /^CVE-\d{4}-\d+/i.test(a)) ?? null;
  const isCve = /^CVE-\d{4}-\d+/i.test(rawId);
  const cveId = isCve ? rawId : cveAlias;
  const id = cveAlias ?? rawId;
  return { id, cveId };
}

/**
 * Parse a raw list of vulnerabilities from OSV into StackVulnerability items.
 */
export function parseOsvVulnerabilities(vulnsRaw: unknown): StackVulnerability[] {
  if (!Array.isArray(vulnsRaw)) return [];
  const list: StackVulnerability[] = [];
  for (const item of vulnsRaw) {
    if (!isRecord(item)) continue;
    const { id, cveId } = extractVulnIdAndCve(item);
    const severity = extractVulnSeverity(item);
    const summary = typeof item.summary === "string" ? item.summary.trim() : null;
    list.push({
      id,
      severity,
      ...(cveId ? { cveId } : {}),
      ...(summary ? { summary } : {}),
    });
  }
  return list;
}

/**
 * Build the payload for OSV.dev POST /v1/querybatch.
 */
export function buildOsvBatchPayload(queries: readonly StackAdvisoryQuery[]): {
  queries: Array<{
    package: { name: string; ecosystem?: string };
    version: string;
  }>;
} {
  return {
    queries: queries.map((q) => ({
      package: {
        name: q.package.name,
        ...(q.package.ecosystem ? { ecosystem: q.package.ecosystem } : {}),
      },
      version: q.version,
    })),
  };
}

/**
 * Parse the OSV.dev POST /v1/querybatch response into a map of componentName -> StackVulnerability[].
 */
export function parseOsvBatchResponse(
  queries: readonly StackAdvisoryQuery[],
  json: unknown,
): Map<string, StackVulnerability[]> {
  const result = new Map<string, StackVulnerability[]>();
  if (!isRecord(json) || !Array.isArray(json.results)) {
    return result;
  }
  const results = json.results;
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]!;
    const entry = results[i];
    if (!isRecord(entry)) continue;
    const vulns = parseOsvVulnerabilities(entry.vulns);
    if (vulns.length > 0) {
      result.set(q.componentName, vulns);
    }
  }
  return result;
}

/**
 * Query OSV.dev batch endpoint for vulnerabilities across stack components.
 * Degrades gracefully on any network or HTTP error, returning an empty map.
 */
export async function queryOsvAdvisories(
  queries: readonly StackAdvisoryQuery[],
  port: StackFetchJson,
  osvBaseUrl = DEFAULT_OSV_API_BASE,
): Promise<Map<string, StackVulnerability[]>> {
  if (queries.length === 0) {
    return new Map();
  }
  const url = `${osvBaseUrl.replace(/\/+$/, "")}${OSV_QUERY_BATCH_PATH}`;
  const payload = JSON.stringify(buildOsvBatchPayload(queries));
  try {
    const res = await port(url, {
      method: "POST",
      body: payload,
      headers: {
        "content-type": "application/json",
      },
    });
    if (res.status < 200 || res.status >= 300) {
      return new Map();
    }
    return parseOsvBatchResponse(queries, res.json);
  } catch {
    return new Map();
  }
}

/**
 * Default JSON transport for OSV.dev API queries.
 */
export function osvJsonPort(options: { timeoutMs?: number } = {}): StackFetchJson {
  const timeoutMs = options.timeoutMs ?? STACK_HTTP_TIMEOUT_MS;
  return async (url, fetchOptions) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "myrmidon-stack-registry",
        ...(fetchOptions?.headers ?? {}),
      };
      const method = fetchOptions?.method ?? (fetchOptions?.body ? "POST" : "GET");
      const res = await fetch(url, {
        method,
        headers,
        body: fetchOptions?.body,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  };
}

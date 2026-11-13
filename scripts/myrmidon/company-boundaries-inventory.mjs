#!/usr/bin/env node
/** Read-only company-boundaries inventory probe.
 *
 * The HTTP transport is injected by the caller: this module never opens
 * connections and never performs writes. Every request the probe issues is
 * a GET; a transport that observes any other method is a contract violation
 * and must fail the probe (see company-boundaries-inventory.test.mjs).
 */

import { createHash } from "node:crypto";

export const INVENTORY_SECTIONS = Object.freeze([
  { key: "agents", path: "/agents", attribution: ["ownerCompanyId"] },
  { key: "issues", path: "/issues", attribution: ["ownerCompanyId", "dependency"] },
  { key: "projects-documents", path: "/projects-documents", attribution: ["ownerCompanyId"] },
  { key: "skills-policies", path: "/skills-policies", attribution: ["ownerCompanyId", "dependency"] },
  { key: "secrets-bindings", path: "/secrets-bindings", attribution: ["ownerCompanyId", "dependency"] },
  { key: "connections-tools", path: "/connections-tools", attribution: ["ownerCompanyId", "dependency"] },
  { key: "budgets-costs", path: "/budgets-costs", attribution: ["ownerCompanyId"] },
  { key: "memory-knowledge-sessions", path: "/memory-knowledge-sessions", attribution: ["ownerCompanyId", "dependency"] },
  { key: "chat-exchange-wake", path: "/chat-exchange-wake", attribution: ["ownerCompanyId", "dependency"] },
  { key: "audit-approvals", path: "/audit-approvals", attribution: ["ownerCompanyId", "dependency"] },
]);

const SECTION_BY_PATH = new Map(INVENTORY_SECTIONS.map((section) => [section.path, section]));

export const INVENTORY_METHOD = "GET";

function safePayload(body) {
  return Array.isArray(body) ? body : body && Array.isArray(body.items) ? body.items : null;
}

function stateFor(response, payload) {
  if (!response || !Number.isInteger(response.status)) return "error";
  if (response.status === 403) return "denied";
  if (response.status === 404) return "not-found";
  if (!response.ok || response.status >= 400) return "error";
  return payload ? (payload.length ? "data" : "empty") : "error";
}

/**
 * Run the read-only inventory probe against an injected transport.
 * @param {{request: (opts: {method: string, path: string}) => Promise<{status:number, ok:boolean, json?:() => Promise<unknown>}>}} transport
 * @returns {Promise<{sections: Array<object>, summary: object}>}
 */
export async function collectInventory(transport) {
  const sections = [];
  for (const definition of INVENTORY_SECTIONS) {
    let response;
    let payload = null;
    try {
      response = await transport.request({ method: INVENTORY_METHOD, path: definition.path });
      if (response?.ok && typeof response.json === "function") payload = safePayload(await response.json());
    } catch {
      response = null;
    }
    const state = stateFor(response, payload);
    sections.push({
      key: definition.key,
      path: definition.path,
      state,
      covered: state === "data" || state === "empty",
      count: state === "data" ? payload.length : 0,
      missingAttribution: state === "data" || state === "empty" ? [...definition.attribution] : [],
    });
  }
  const counts = Object.fromEntries(
    ["data", "empty", "denied", "not-found", "error"].map((state) => [state, sections.filter((s) => s.state === state).length]),
  );
  return {
    sections,
    summary: { total: sections.length, covered: sections.filter((s) => s.covered).length, counts },
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

/** Deterministic normalized form of a probe report (sorted object keys, section order preserved). */
export function normalizeInventoryReport(report) {
  return canonicalize({ sections: report.sections, summary: report.summary });
}

/** Stable sha256 over the normalized report; equal runs on the same fixture produce equal hashes. */
export function inventoryReportHash(report) {
  return createHash("sha256").update(JSON.stringify(normalizeInventoryReport(report))).digest("hex");
}

export function renderInventory(report) {
  return JSON.stringify(normalizeInventoryReport(report));
}

export function sectionForPath(path) {
  return SECTION_BY_PATH.get(path);
}

// ===========================================================================
// CLI probe runner, memory coverage, summarizers, and diffing engine
// ===========================================================================

// OPE-12764: COMPANY-BOUNDARIES inventory probe (dry-run).
//
// Builds a verifiable metadata map of a company's entities — agents, roles and
// reporting lines, projects, issues, skills/instructions, secrets (metadata
// only), tool/connections surface, budgets, documents/knowledge/memory — and
// prints a diff between two probe runs so a reviewer can see exactly what a
// company-transfer dry-run would observe changing. The probe is read-only:
// every request below is GET (or the export-preview POST, which by contract
// plans without writing), no state is created, modified or deleted.
//
// Secret values are never requested and never printed. Secret surfaces are
// enumerated by key, provider, scope, binding target and version counts only
// — the routes that carry plaintext material (`/secrets` values,
// `company_secret_versions.material`, proposals' `value_ciphertext`) are
// deliberately not called.
//
// Reproducible & idempotent: same inputs (company id, base URL, key) produce
// the same report shape; running the probe twice changes nothing and the
// `diff` command compares two captured reports without touching the board.
//
// Usage:
//   node scripts/myrmidon/company-boundaries-inventory.mjs probe \
//        --company <uuid> --url <api-base> --key-env <ENV_VAR_NAME> \
//        [--out <report.json>]
//   node scripts/myrmidon/company-boundaries-inventory.mjs diff \
//        --before <report.json> --after <report.json>
//
// `--key-env` names an environment variable that holds the bearer token; the
// token value itself is never accepted on the command line, echoed, or
// written into the report.
//
// Exit codes: 0 ok, 1 probe found cross-company/owner findings (informational
// gate for the migration pilot), 2 usage/transport error (fail closed).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PROBE_SCHEMA = "company-boundaries-inventory/v1";
export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;

export const MEMORY_COVERAGE_STATUS = {
  COVERED_EMPTY: "covered-empty",
  COVERED_NONEMPTY: "covered-nonempty",
  UNAVAILABLE: "unavailable",
};

// ---------------------------------------------------------------------------
// Board surface inventory (metadata-only, read-only)
// ---------------------------------------------------------------------------

// Each entry: logical section -> company-scoped GET path (relative to
// /api/companies/<id>). `optional` sections are recorded as "unavailable"
// when the actor key lacks board scope instead of failing the probe.
export const SECTIONS = [
  { id: "agents", path: "/agents", count: true },
  { id: "org", path: "/org", count: false, optional: true },
  { id: "projects", path: "/projects", count: true },
  { id: "issues", path: "/issues?view=compact&limit=500&offset=0", count: true, paginated: true },
  { id: "agentConfigurations", path: "/agent-configurations", count: true, optional: true, note: "redacted configuration metadata; per-agent instructions/skills are not materialized" },
  { id: "agentSkillsAndInstructions", path: "/agent-skills-and-instructions", count: false, optional: true, note: "detail surface is unavailable unless the board exposes a bulk export" },
  { id: "memory", path: "/memory", count: false, optional: true, note: "profile memory/corpus is outside the company API when unavailable" },
  { id: "memoryCoverage", path: "/memory-coverage", count: false, optional: true, custom: "memoryCoverage", note: "metadata-only probe of agent memory banks: per-agent coverage status only, memory contents are never fetched" },
  { id: "skills", path: "/skills", count: true },
  { id: "skillFolders", path: "/folders?kind=skill", count: false, optional: true },
  { id: "routineFolders", path: "/folders?kind=routine", count: false, optional: true },
  { id: "routines", path: "/routines", count: true },
  { id: "goals", path: "/goals", count: true },
  { id: "cases", path: "/cases", count: true },
  { id: "secretsCatalog", path: "/secrets/catalog", count: true, optional: true, note: "metadata catalog only: keys, names, status; secret values never queried" },
  { id: "secretProviderConfigs", path: "/secret-provider-configs", count: true, optional: true, note: "board-only metadata; provider credentials are never requested" },
  { id: "secretBindings", path: "/secret-bindings", count: true, optional: true, note: "binding metadata only; secret values and ciphertext are never requested" },
  { id: "budgetsOverview", path: "/budgets/overview", count: true, optional: true },
  { id: "costsSummary", path: "/costs/summary", count: false, optional: true },
  { id: "aiConnections", path: "/ai-connections", count: true, optional: true },
  { id: "chatEndpoints", path: "/chat-endpoints", count: true, optional: true },
  { id: "exportFidelity", path: "/export/fidelity", count: false, optional: true },
];

export function parseArgs(argv) {
  const args = {};
  let i = 0;
  if (argv.length > 0 && !argv[0].startsWith("--")) {
    args._cmd = argv[0];
    i = 1;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

export class UsageError extends Error {}

function usageError(message) {
  return new UsageError(message);
}

export function requireArgs(args, names) {
  for (const name of names) {
    const v = args[name];
    if (typeof v !== "string" || v.length === 0) {
      throw usageError(`missing required --${name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export async function getJson(baseUrl, path, token, { allow403 = false } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new Error(`transport error for ${path}: ${err.message}`);
  }
  if (res.status === 403 && allow403) {
    return { __unavailable: "board_access_required" };
  }
  if (res.status === 404 && allow403) {
    return { __unavailable: "route_not_found" };
  }
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Redaction / metadata shaping
// ---------------------------------------------------------------------------

// Keys that must never survive into a report even if an upstream payload
// carries them. The probe strips them defensively at every section.
const VALUE_KEYS = new Set([
  "value", "valueCiphertext", "value_ciphertext", "material", "plaintext",
  "secret", "token", "apiKey", "api_key", "keyHash", "key_hash", "password",
  "privateKey", "private_key", "privateKeyCiphertext", "private_key_ciphertext",
  "credential", "externalCredential", "external_credential", "envValue",
]);

export function redact(node, depth = 0) {
  if (depth > 6) return "[depth-limit]";
  if (Array.isArray(node)) return node.map((n) => redact(n, depth + 1));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (VALUE_KEYS.has(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return node;
}

export function sha256Of(obj) {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

// ---------------------------------------------------------------------------
// Section summarizers (metadata only)
// ---------------------------------------------------------------------------

export function summarizeAgents(rows) {
  const list = rows ?? [];
  const byId = new Map(list.map((a) => [a.id, a]));
  const roles = {};
  for (const a of list) {
    roles[a.role ?? "general"] = (roles[a.role ?? "general"] ?? 0) + 1;
  }
  const reportLines = {};
  let orphans = 0;
  let externalReportsTo = 0;
  for (const a of list) {
    if (a.reportsTo == null) {
      orphans++;
    } else if (!byId.has(a.reportsTo)) {
      externalReportsTo++;
    } else {
      reportLines[a.reportsTo] = (reportLines[a.reportsTo] ?? 0) + 1;
    }
  }
  const budgeted = list.filter((a) => (a.budgetMonthlyCents ?? 0) > 0).length;
  const spentCents = list.reduce((s, a) => s + (a.spentMonthlyCents ?? 0), 0);
  return {
    count: list.length,
    roles,
    orphansWithoutLeader: orphans,
    reportsToMissingInCompany: externalReportsTo,
    leadersWithDirectReports: Object.keys(reportLines).length,
    budgetedAgents: budgeted,
    spentMonthlyCentsTotal: spentCents,
    adapterTypes: countBy(list.map((a) => a.adapterType)),
    // Stable per-agent fingerprints (id + role + reportsTo) so the diff can
    // show *which* agents changed between two probe runs.
    members: list
      .map((a) => ({ id: a.id, name: a.name, role: a.role, reportsTo: a.reportsTo, status: a.status }))
      .sort((x, y) => (x.id < y.id ? -1 : 1)),
  };
}

export function summarizeIssues(rows) {
  const list = rows ?? [];
  const byProject = {};
  let unassigned = 0;
  let open = 0;
  for (const i of list) {
    const p = i.projectId ?? "none";
    byProject[p] = (byProject[p] ?? 0) + 1;
    if (i.assigneeAgentId == null && i.assigneeUserId == null) unassigned++;
    if (i.status && !["done", "cancelled"].includes(i.status)) open++;
  }
  return {
    count: list.length,
    open,
    unassigned,
    byProject,
    statusCounts: countBy(list.map((i) => i.status)),
  };
}

export function summarizeProjects(rows) {
  const list = rows ?? [];
  return {
    count: list.length,
    byStatus: countBy(list.map((p) => p.status)),
    withLead: list.filter((p) => p.leadAgentId != null).length,
    members: list.map((p) => ({ id: p.id, name: p.name, status: p.status, leadAgentId: p.leadAgentId ?? null })),
  };
}

export function summarizeSkills(rows) {
  const list = rows ?? [];
  return {
    count: list.length,
    byTrustLevel: countBy(list.map((s) => s.trustLevel)),
    bySourceType: countBy(list.map((s) => s.sourceType)),
    shared: list.filter((s) => s.sharingScope && s.sharingScope !== "company").length,
    forkedIn: list.filter((s) => s.forkedFromCompanyId && s.forkedFromCompanyId !== s.companyId).length,
  };
}

export function summarizeRoutines(rows) {
  const list = rows ?? [];
  return {
    count: list.length,
    byStatus: countBy(list.map((r) => r.status)),
    withAssignee: list.filter((r) => r.assigneeAgentId != null).length,
  };
}

export function countBy(values) {
  const out = {};
  for (const v of values) {
    const k = v ?? "null";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function summarizeSecretsMeta(rows) {
  // Metadata only: keys, names, statuses — never values. The catalog endpoint
  // returns {id, name, key, status} without any secret material.
  const list = rows ?? [];
  return {
    count: list.length,
    byStatus: countBy(list.map((s) => s.status)),
    keys: list
      .map((s) => ({ id: s.id, key: s.key ?? s.name, status: s.status }))
      .sort((a, b) => (a.key < b.key ? -1 : 1)),
  };
}

export function summarizeBudgetsMeta(payload) {
  // /budgets/overview returns { companyId, policies: [...] }.
  const list = Array.isArray(payload) ? payload : (payload?.policies ?? []);
  return {
    count: list.length,
    byScopeType: countBy(list.map((b) => b.scopeType)),
    byMetric: countBy(list.map((b) => b.metric)),
    byStatus: countBy(list.map((b) => b.status)),
    active: list.filter((b) => b.isActive).length,
    withHardStop: list.filter((b) => b.hardStopEnabled).length,
    totalAmountCents: list.reduce((s, b) => s + (b.amount ?? 0), 0),
    totalObservedCents: list.reduce((s, b) => s + (b.observedAmount ?? 0), 0),
    policies: list
      .map((b) => ({
        policyId: b.policyId,
        scopeType: b.scopeType,
        scopeId: b.scopeId,
        metric: b.metric,
        amount: b.amount,
        observedAmount: b.observedAmount,
        utilizationPercent: b.utilizationPercent,
        status: b.status,
        isActive: b.isActive,
      }))
      .sort((a, b) => (a.policyId < b.policyId ? -1 : 1)),
  };
}

export function summarizeCostsSummary(payload) {
  if (!payload || typeof payload !== "object") return { payload: redact(payload) };
  return {
    spendCents: payload.spendCents ?? null,
    budgetCents: payload.budgetCents ?? null,
    utilizationPercent: payload.utilizationPercent ?? null,
    forecastCents: payload.forecastCents ?? null,
    unpricedEvents: payload.unpricedEvents ?? null,
    unpricedTokens: payload.unpricedTokens ?? null,
  };
}

// ---------------------------------------------------------------------------
// Memory coverage (metadata-only): per-agent status, never memory text
// ---------------------------------------------------------------------------

// A memory coverage verdict for one agent. The probe MUST NOT fetch memory
// contents: the only accepted read-only source is the board's per-agent
// memory status endpoint (`GET /api/myrmidon/agents/:id/memory`), which returns
// `{ enabled, bank, reason }` — identifiers and flags, no memory text.
//
// Source of truth:
//   - server/src/app.ts:1328: api.use(myrmidonAgentMemoryRoutes(db))
//   - server/src/myrmidon/agent-memory/routes.ts:88: router.get("/myrmidon/agents/:id/memory", ...)
//   - server/src/myrmidon/agent-memory/service.ts:51: export interface MemoryCardStatus { enabled, bank, reason }
//   - ui/src/components/myrmidon/agent-memory/memoryApi.ts:40: base = /myrmidon/agents/:id/memory
//
// The status route is strictly read-only: it resolves the bank from adapterConfig
// and pluginConfig without writing to the database, dispatching actions, or
// creating activity log entries (unlike the mutating clear/invalidate routes).
// Verified behaviorally in company-boundaries-inventory.test.mjs.
//
//   covered-empty     — agent exists, board answered 200, no bank attached
//                       (or memory disabled for the instance): verifiably
//                       no memory coverage, not an unknown state.
//   covered-nonempty  — board answered 200 and an explicit non-empty bank
//                       marker (bankId) is present: the agent has a memory
//                       bank (content itself is never read).
//   unavailable       — the source did not answer authoritatively: 403/404,
//                       transport error, timeout, or a malformed payload.
//                       Absence of an endpoint or a refusal is never
//                       reported as an empty/covered result.
export function memoryCoverageStatusFor({ httpStatus, payload, transportError } = {}) {
  if (transportError) return { status: MEMORY_COVERAGE_STATUS.UNAVAILABLE, reason: `transport: ${transportError}` };
  if (httpStatus === 200 && payload && typeof payload === "object" && !Array.isArray(payload)) {
    // If memory is explicitly disabled instance-wide, coverage is empty for this agent.
    if (payload.enabled === false) {
      return { status: MEMORY_COVERAGE_STATUS.COVERED_EMPTY, reason: payload.reason ?? "not_enabled" };
    }
    // Inspect bank resolution.
    // The server returns `bank: { bankId: string, source: string } | null`.
    // We also tolerate a string bank for forward-compatibility.
    const rawBank = payload.bank;
    let bankId = null;
    let bankSource = null;
    if (typeof rawBank === "string" && rawBank.trim().length > 0) {
      bankId = rawBank.trim();
    } else if (rawBank && typeof rawBank === "object" && !Array.isArray(rawBank)) {
      if (typeof rawBank.bankId === "string" && rawBank.bankId.trim().length > 0) {
        bankId = rawBank.bankId.trim();
        bankSource = typeof rawBank.source === "string" ? rawBank.source : null;
      }
    }
    if (bankId) {
      const out = { status: MEMORY_COVERAGE_STATUS.COVERED_NONEMPTY, bankId };
      if (bankSource) out.bankSource = bankSource;
      return out;
    }
    if (rawBank === null || payload.reason === "no_bank") {
      return { status: MEMORY_COVERAGE_STATUS.COVERED_EMPTY };
    }
    // 200 but not a recognizable memory-status payload: do not guess.
    return { status: MEMORY_COVERAGE_STATUS.UNAVAILABLE, reason: "malformed_payload" };
  }
  return {
    status: MEMORY_COVERAGE_STATUS.UNAVAILABLE,
    reason: httpStatus === 403 ? "board_access_required" : httpStatus === 404 ? "route_not_found" : `http_${httpStatus ?? "unknown"}`,
  };
}

// Probe every agent of the company through the per-agent memory status
// endpoint. GET only; the response payload is reduced to a coverage status
// and a stable bank reference before it enters the report — memory text is
// never requested (the export/memories list routes are deliberately not
// called) and any unexpected field is dropped by the allowlist below.
export async function probeMemoryCoverage({ baseUrl, token, agents, fetcher = fetch }) {
  const entries = [];
  const list = Array.isArray(agents) ? agents : [];
  for (const agent of list) {
    const agentId = agent?.id;
    if (typeof agentId !== "string" || agentId.length === 0) continue;
    let httpStatus = null;
    let payload = null;
    let transportError = null;
    try {
      const res = await fetcher(`${baseUrl}/api/myrmidon/agents/${encodeURIComponent(agentId)}/memory`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      httpStatus = res.status;
      if (res.status === 200) {
        try {
          payload = await res.json();
        } catch {
          payload = null;
        }
      }
    } catch (err) {
      transportError = err?.message ?? "transport error";
    }
    const verdict = memoryCoverageStatusFor({ httpStatus, payload, transportError });
    const entry = { agentId, status: verdict.status };
    if (verdict.reason) entry.reason = verdict.reason;
    if (verdict.bankId) {
      entry.bankId = verdict.bankId;
      entry.bankSource = verdict.bankSource ?? null;
    }
    entries.push(entry);
  }
  const covered = entries.filter((e) => e.status === MEMORY_COVERAGE_STATUS.COVERED_EMPTY || e.status === MEMORY_COVERAGE_STATUS.COVERED_NONEMPTY);
  return {
    available: true,
    source: "GET /api/myrmidon/agents/:id/memory (status-only)",
    probedAgents: entries.length,
    coveredAgents: covered.length,
    byStatus: countBy(entries.map((e) => e.status)),
    agents: entries,
  };
}

// ---------------------------------------------------------------------------
// Probe runner
// ---------------------------------------------------------------------------

export function summarizeSection(id, payload) {
  if (payload && payload.__unavailable) {
    return { available: false, reason: payload.__unavailable };
  }
  const rows = Array.isArray(payload) ? payload : null;
  switch (id) {
    case "agents":
      return { available: true, ...summarizeAgents(rows) };
    case "issues":
      return { available: true, ...summarizeIssues(rows) };
    case "projects":
      return { available: true, ...summarizeProjects(rows) };
    case "skills":
      return { available: true, ...summarizeSkills(rows) };
    case "routines":
      return { available: true, ...summarizeRoutines(rows) };
    case "secretsCatalog":
      return { available: true, ...summarizeSecretsMeta(rows) };
    case "budgetsOverview":
      return { available: true, ...summarizeBudgetsMeta(payload) };
    case "costsSummary":
      return { available: true, ...summarizeCostsSummary(payload) };
    case "memory": {
      // Direct /memory endpoint probe: if it returned 403 or 404, it is
      // already caught by __unavailable. If it returned data, summarize metadata
      // only — never raw contents.
      if (payload && typeof payload === "object") {
        return { available: true, payload: redact(payload) };
      }
      return { available: true };
    }
    case "memoryCoverage": {
      // When fed directly with a pre-probed summary
      if (payload && typeof payload === "object" && payload.byStatus) {
        return payload;
      }
      return { available: true, payload: redact(payload) };
    }
    case "chatEndpoints":
    case "aiConnections": {
      if (rows) return { available: true, count: rows.length, items: redact(rows) };
      return { available: true, payload: redact(payload) };
    }
    default: {
      if (rows) return { available: true, count: rows.length };
      return { available: true, payload: redact(payload) };
    }
  }
}

export async function runProbe({ baseUrl, token, companyId }) {
  const report = {
    schema: PROBE_SCHEMA,
    generatedAt: new Date().toISOString(),
    companyId,
    mode: "dry-run-read-only",
    sections: {},
    findings: [],
  };
  let agentRows = null;
  for (const section of SECTIONS) {
    const path = `/api/companies/${companyId}${section.path}`;
    try {
      let payload = await getJson(baseUrl, path, token, { allow403: section.optional === true });
      // The issue route has a hard server-side maximum of 500 rows. Walk every
      // page so the inventory cannot silently present a compact sample as a
      // complete task inventory. Each request remains a read-only GET.
      if (section.id === "issues" && Array.isArray(payload)) {
        const allRows = [...payload];
        const pageSize = 500;
        for (let offset = pageSize; payload.length === pageSize; offset += pageSize) {
          payload = await getJson(
            baseUrl,
            `/api/companies/${companyId}/issues?view=compact&limit=${pageSize}&offset=${offset}`,
            token,
            { allow403: false },
          );
          if (!Array.isArray(payload)) break;
          allRows.push(...payload);
        }
        payload = allRows;
      }
      if (section.id === "agents" && Array.isArray(payload)) agentRows = payload;
      if (section.id === "memoryCoverage" && agentRows) {
        // Custom per-agent probe (metadata-only status endpoint). The company
        // route `/memory-coverage` does not exist by design: reuse the agents
        // list collected above instead of trusting a non-existent source.
        report.sections[section.id] = await probeMemoryCoverage({ baseUrl, token, agents: agentRows });
        continue;
      }
      report.sections[section.id] = summarizeSection(section.id, payload);
    } catch (err) {
      if (section.optional) {
        report.sections[section.id] = { available: false, reason: `error: ${err.message}` };
      } else {
        throw err;
      }
    }
  }
  report.findings = collectFindings(report.sections);
  report.reportSha256 = sha256Of({ sections: report.sections, findings: report.findings });
  return report;
}

// ---------------------------------------------------------------------------
// Findings: cross-company risk signals and owner gaps
// ---------------------------------------------------------------------------

export function collectFindings(sections) {
  const findings = [];
  const agents = sections.agents ?? {};
  if (agents.available) {
    if (agents.reportsToMissingInCompany > 0) {
      findings.push({
        code: "agents_reports_to_missing",
        severity: "error",
        detail: `${agents.reportsToMissingInCompany} agent(s) report to an agent id that is not in the company — transfer must resolve or drop these links`,
      });
    }
    if (agents.orphansWithoutLeader > 0) {
      findings.push({
        code: "agents_without_leader",
        severity: "warning",
        detail: `${agents.orphansWithoutLeader} agent(s) have reportsTo=null (top-level); confirm intended leaders after transfer`,
      });
    }
  }
  const issues = sections.issues ?? {};
  if (issues.available && issues.unassigned > 0) {
    findings.push({
      code: "issues_unassigned",
      severity: "warning",
      detail: `${issues.unassigned} issue(s) have no assignee — auto-assignment after split must not pick agents of other companies`,
    });
  }
  const skills = sections.skills ?? {};
  if (skills.available && skills.forkedIn > 0) {
    findings.push({
      code: "skills_forked_from_other_company",
      severity: "error",
      detail: `${skills.forkedIn} skill(s) forked from another company — cross-company dependency survives a transfer`,
    });
  }
  for (const id of [
    "secretsCatalog",
    "secretProviderConfigs",
    "secretBindings",
    "agentConfigurations",
    "agentSkillsAndInstructions",
    "memory",
    "memoryCoverage",
    "budgetsOverview",
    "aiConnections",
    "chatEndpoints",
    "exportFidelity",
  ]) {
    const s = sections[id];
    if (s && s.available === false) {
      findings.push({
        code: `${id}_unavailable`,
        severity: "warning",
        detail: `${id} surface not readable with this actor key (${s.reason ?? "unavailable"}) — inventory incomplete; rerun with a board key or export before the pilot`,
      });
    }
  }
  const memCov = sections.memoryCoverage ?? {};
  if (memCov.available && memCov.byStatus) {
    const unavailableCount = memCov.byStatus[MEMORY_COVERAGE_STATUS.UNAVAILABLE] ?? 0;
    if (unavailableCount > 0) {
      findings.push({
        code: "memory_coverage_incomplete",
        severity: "warning",
        detail: `memory coverage probe could not resolve status for ${unavailableCount} agent(s) (unavailable/403/404) — rerun with board key`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Diff between two captured reports
// ---------------------------------------------------------------------------

// Live-usage counters tick constantly on an active board (spend accumulates
// while the probe runs). They are recorded in reports but excluded from the
// content comparison: the diff must flag boundary/entity changes, not load.
const VOLATILE_KEYS = new Set([
  "spentMonthlyCentsTotal",
  "spendCents",
  "forecastCents",
  "unpricedEvents",
  "unpricedTokens",
  "budgetCents",
  "totalObservedCents",
  "observedAmount",
  "utilizationPercent",
]);

function stripVolatile(node, depth = 0) {
  if (depth > 8) return node;
  if (Array.isArray(node)) return node.map((n) => stripVolatile(n, depth + 1));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripVolatile(v, depth + 1);
    }
    return out;
  }
  return node;
}

export function diffReports(before, after) {
  const changes = [];
  const ids = new Set([...Object.keys(before.sections), ...Object.keys(after.sections)]);
  for (const id of ids) {
    const b = before.sections[id];
    const a = after.sections[id];
    const bAvail = b?.available === true;
    const aAvail = a?.available === true;
    if (bAvail !== aAvail) {
      changes.push({ section: id, kind: "availability", before: bAvail, after: aAvail });
      continue;
    }
    if (!bAvail) continue;
    const bSha = sha256Of(stripVolatile(withoutVolatile(b)));
    const aSha = sha256Of(stripVolatile(withoutVolatile(a)));
    if (bSha !== aSha) {
      changes.push({ section: id, kind: "content", beforeSha256: bSha, afterSha256: aSha });
    }
    if (typeof b.count === "number" && typeof a.count === "number" && b.count !== a.count) {
      changes.push({ section: id, kind: "count", before: b.count, after: a.count });
    }
  }
  const findings = [];
  for (const f of after.findings ?? []) {
    const same = (before.findings ?? []).some((x) => x.code === f.code && x.severity === f.severity);
    if (!same) findings.push({ ...f, status: "new" });
  }
  for (const f of before.findings ?? []) {
    const same = (after.findings ?? []).some((x) => x.code === f.code && x.severity === f.severity);
    if (!same) findings.push({ ...f, status: "resolved" });
  }
  return { schema: PROBE_SCHEMA, changes, findings };
}

function withoutVolatile(section) {
  const copy = { ...section };
  delete copy.available;
  delete copy.reason;
  return copy;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv) {
  const args = parseArgs(argv);
  if (args._cmd === "probe" || argv[0] === "probe") {
    requireArgs(args, ["company", "url", "key-env"]);
    const token = process.env[args["key-env"]];
    if (!token) {
      process.stderr.write(`environment variable ${args["key-env"]} is not set\n`);
      return EXIT_USAGE;
    }
    const report = await runProbe({
      baseUrl: args.url.replace(/\/$/, ""),
      token,
      companyId: args.company,
    });
    const out = typeof args.out === "string" ? args.out : null;
    const text = JSON.stringify(report, null, 2) + "\n";
    if (out) {
      fs.writeFileSync(out, text);
    } else {
      process.stdout.write(text);
    }
    const blocking = (report.findings ?? []).some((f) => f.severity === "error");
    return blocking ? EXIT_FINDINGS : EXIT_OK;
  }
  if (args._cmd === "diff" || argv[0] === "diff") {
    requireArgs(args, ["before", "after"]);
    const before = JSON.parse(fs.readFileSync(args.before, "utf8"));
    const after = JSON.parse(fs.readFileSync(args.after, "utf8"));
    if (before.schema !== PROBE_SCHEMA || after.schema !== PROBE_SCHEMA) {
      process.stderr.write(`report schema mismatch: expected ${PROBE_SCHEMA}\n`);
      return EXIT_USAGE;
    }
    process.stdout.write(JSON.stringify(diffReports(before, after), null, 2) + "\n");
    return EXIT_OK;
  }
  process.stderr.write(
    "usage:\n" +
    "  company-boundaries-inventory.mjs probe --company <uuid> --url <api-base> --key-env <ENV_NAME> [--out report.json]\n" +
    "  company-boundaries-inventory.mjs diff --before report1.json --after report2.json\n",
  );
  return EXIT_USAGE;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(EXIT_USAGE);
  });
}


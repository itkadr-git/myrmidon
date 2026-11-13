#!/usr/bin/env node
// OPE-12764: COMPANY-BOUNDARIES inventory probe (dry-run).
//
// Builds a verifiable metadata map of a company's entities — agents, roles and
// reporting lines, projects, issues, per-agent configurations / skills /
// instructions, skills with their per-skill agent assignments, secrets
// (metadata only) with provider configs and binding references, budgets,
// per-agent cost attribution, per-agent memory-bank metadata (board-only
// surface), the company knowledge corpus (dataset list + aggregate counters,
// never document or chunk content), and the export-fidelity surface — and
// prints a diff between two probe runs so a reviewer can see exactly what a
// company-transfer dry-run would observe changing. The probe is read-only:
// every request below is GET, no state is created, modified or deleted.
//
// Secret values are never requested and never printed. Secret surfaces are
// enumerated through `/secrets/catalog` (id/name/key/status only); binding
// references come from `/secrets/:id/usage`, a board-only route the probe
// calls per secret and records as unavailable-with-reason when the actor key
// lacks board scope. Memory surfaces are metadata-only by construction:
// `/agents/:id/memory` answers {enabled, bank, reason} and the probe never
// calls `/memory/memories` or `/memory/export` (the latter would write an
// audit row, breaking the read-only contract). Corpus surfaces return dataset
// rows and aggregate counters only. Routes that carry plaintext material
// (`GET /companies/:id/secrets`, `company_secret_versions.material`,
// proposals' `value_ciphertext`, corpus document/chunk contents) are
// deliberately never called, and a final-pass `redact()` strips secret-material
// keys from anything that did make it into a section payload.
//
// Reproducible & idempotent: same inputs (company id, base URL, key) produce
// the same report shape; running the probe twice changes nothing and the
// `diff` command compares two captured reports without touching the board.
// Live-activity counters (spend ticks, agent runtime status flips, task
// status transitions) are recorded in the reports but excluded from the
// content comparison, so a clean diff means "no boundary-relevant change".
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

import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const PROBE_SCHEMA = "company-boundaries-inventory/v1";
export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;

// ---------------------------------------------------------------------------
// Board surface inventory (metadata-only, read-only)
// ---------------------------------------------------------------------------

// Each entry maps a logical section to the real server route it probes:
// - kind "get":       single GET to `path` (company-scoped unless absolutePath).
// - kind "issues":    GET with `limit`/`offset`, walking every page so the
//                     compact view cannot present a sample as a full inventory.
// - kind "per-agent": GET per agent id (from the agents section) to an
//                     agent-scoped route (absolutePath with `:agentId`).
// - kind "per-skill": GET per skill id to `/companies/:id/skills/:skillId`.
// - kind "per-secret":GET per secret id to `/secrets/:id/usage` (board-only).
// `optional` sections degrade to an explicit `available: false` + warning
// finding when the actor key lacks the gate (board scope, config-read grant,
// CEO role) instead of failing the probe; required sections fail the run.
export const SECTIONS = [
  { id: "agents", kind: "get", path: "/agents", attribution: ["ownerCompanyId"] },
  { id: "org", kind: "get", path: "/org", optional: true },
  { id: "runtimeIdentity", kind: "get", path: "/api/agents/me", absolutePath: true, optional: true, note: "probes /api/agents/me: which actor identity ran the probe; profile memory follows the agent, not a company route" },
  { id: "projects", kind: "get", path: "/projects", attribution: ["ownerCompanyId"] },
  { id: "issues", kind: "issues", path: "/issues?view=compact", pageSize: 500, attribution: ["ownerCompanyId", "dependency"] },
  { id: "agentConfigurations", kind: "per-agent", path: "/api/agents/:agentId/configuration", optional: true, note: "server-redacted configuration rows (redactAgentConfiguration); probe keeps key names only" },
  { id: "agentSkills", kind: "per-agent", path: "/api/agents/:agentId/skills", optional: true, note: "AgentSkillSnapshot per agent; skill keys only, no skill content" },
  { id: "agentInstructions", kind: "per-agent", path: "/api/agents/:agentId/instructions-bundle", optional: true, note: "bundle metadata per agent (mode, entry file, file count); file contents are not fetched" },
  { id: "skills", kind: "get", path: "/skills", attribution: ["ownerCompanyId", "dependency"] },
  { id: "skillAssignments", kind: "per-skill", path: "/companies/:companyId/skills/:skillId", optional: true, note: "per-skill usedByAgents (desired attachment map: which agents own which skill)" },
  { id: "skillFolders", kind: "get", path: "/folders?kind=skill", optional: true },
  { id: "routineFolders", kind: "get", path: "/folders?kind=routine", optional: true },
  { id: "routines", kind: "get", path: "/routines", attribution: ["ownerCompanyId"] },
  { id: "goals", kind: "get", path: "/goals", optional: true, attribution: ["ownerCompanyId"] },
  { id: "cases", kind: "get", path: "/cases", optional: true, attribution: ["ownerCompanyId"] },
  { id: "secretsCatalog", kind: "get", path: "/secrets/catalog", optional: true, attribution: ["ownerCompanyId"], note: "metadata catalog only: id/name/key/status; secret values never queried" },
  { id: "secretProviderConfigs", kind: "get", path: "/secret-provider-configs", optional: true, note: "board-only route (assertBoard); provider credentials never requested" },
  { id: "secretBindings", kind: "per-secret", path: "/api/secrets/:secretId/usage", optional: true, attribution: ["ownerCompanyId", "dependency"], note: "binding references per secret via board-only /secrets/:id/usage; metadata fields only" },
  { id: "budgetsOverview", kind: "get", path: "/budgets/overview", optional: true, attribution: ["ownerCompanyId"] },
  { id: "costsSummary", kind: "get", path: "/costs/summary", optional: true },
  { id: "costsByAgent", kind: "get", path: "/costs/by-agent", optional: true, note: "per-agent spend attribution (which agents accrue cost); values are volatile" },
  { id: "corpusDatasets", kind: "get", path: "/api/myrmidon/companies/:companyId/corpus/datasets", absolutePath: true, optional: true, attribution: ["ownerCompanyId"], note: "knowledge-corpus dataset list per company (id/name/description + documentCount/readyCount/failedCount/chunkCount); document bytes and parsed contents are never fetched" },
  { id: "corpusStats", kind: "get", path: "/api/myrmidon/companies/:companyId/corpus/stats", absolutePath: true, optional: true, note: "company corpus aggregate counters only (datasets/documents/ready/pending/failed/chunks/bytes); never includes document or chunk content" },
  { id: "agentMemory", kind: "per-agent", path: "/api/myrmidon/agents/:agentId/memory", optional: true, note: "per-agent memory-bank metadata via board-only route: enabled / bank.bankId / bank.source (agent-card|plugin-config) / reason; memory items, /memory/memories and /memory/export are never queried (export would write an audit row)" },
  { id: "aiConnections", kind: "get", path: "/ai-connections", optional: true, attribution: ["ownerCompanyId", "dependency"], note: "board-only route (assertBoard)" },
  { id: "chatEndpoints", kind: "get", path: "/chat-endpoints", optional: true, attribution: ["ownerCompanyId", "dependency"], note: "board-only route (assertBoard)" },
  { id: "exportFidelity", kind: "get", path: "/export/fidelity", optional: true, note: "CEO-or-board gate; counts-only report" },
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
  // The corpus module answers 503 when the instance switch is off or its ports
  // are not wired: inventory availability is boundary-relevant, so record it
  // explicitly instead of failing the whole probe.
  if (res.status === 503 && allow403) {
    return { __unavailable: "module_disabled_or_unconfigured" };
  }
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status}`);
  }
  return res.json();
}

// Bounded-concurrency map so per-item sweeps stay polite to the board.
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

// Per-item fetch that never throws for gated items: 403/404 degrade to an
// unavailable marker so a partial sweep is recorded instead of lost.
export async function getItem(baseUrl, path, token) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return { __unavailable: `transport: ${err.message}` };
  }
  if (res.status === 403) return { __unavailable: "board_access_required" };
  if (res.status === 404) return { __unavailable: "not_found" };
  if (res.status === 503) return { __unavailable: "module_disabled_or_unconfigured" };
  if (!res.ok) return { __unavailable: `http_${res.status}` };
  try {
    return await res.json();
  } catch (err) {
    return { __unavailable: `invalid_json: ${err.message}` };
  }
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
  "content", "config", "env",
]);

export function redact(node, depth = 0) {
  if (depth > 8) return "[depth-limit]";
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

function sortedById(list) {
  const keyOf = (x) => x.id ?? x.agentId ?? x.skillId ?? x.secretId ?? "";
  return [...list].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
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
  const budgeted = list.filter((a) => (a.budgetMonthlyCents ?? 0) > 0);
  const spentCents = list.reduce((s, a) => s + (a.spentMonthlyCents ?? 0), 0);
  return {
    count: list.length,
    roles,
    orphansWithoutLeader: orphans,
    reportsToMissingInCompany: externalReportsTo,
    leadersWithDirectReports: Object.keys(reportLines).length,
    budgetedAgents: budgeted.length,
    budgetedMembers: budgeted
      .map((a) => ({ id: a.id, name: a.name, budgetMonthlyCents: a.budgetMonthlyCents }))
      .sort((x, y) => (x.id < y.id ? -1 : 1)),
    spentMonthlyCentsTotal: spentCents,
    statusCounts: countBy(list.map((a) => a.status)),
    adapterTypes: countBy(list.map((a) => a.adapterType)),
    // Stable per-agent ownership fingerprints (id + role + reportsTo) so the
    // diff shows *which* agent's reporting line changed between two runs.
    // Runtime `status` is deliberately excluded (see statusCounts above).
    members: sortedById(
      list.map((a) => ({ id: a.id, name: a.name, role: a.role, reportsTo: a.reportsTo ?? null })),
    ),
  };
}

export function summarizeIssues(rows) {
  const list = rows ?? [];
  const byProject = {};
  const byAssignee = {};
  let unassigned = 0;
  let open = 0;
  for (const i of list) {
    const p = i.projectId ?? "none";
    byProject[p] = (byProject[p] ?? 0) + 1;
    const assignee = i.assigneeAgentId ?? i.assigneeUserId ?? null;
    if (assignee == null) {
      unassigned++;
    } else {
      byAssignee[assignee] = (byAssignee[assignee] ?? 0) + 1;
    }
    if (i.status && !["done", "cancelled"].includes(i.status)) open++;
  }
  return {
    count: list.length,
    open,
    unassigned,
    byProject,
    byAssignee,
    statusCounts: countBy(list.map((i) => i.status)),
  };
}

export function summarizeProjects(rows) {
  const list = rows ?? [];
  return {
    count: list.length,
    withLead: list.filter((p) => p.leadAgentId != null).length,
    members: sortedById(
      list.map((p) => ({ id: p.id, name: p.name, status: p.status, leadAgentId: p.leadAgentId ?? null })),
    ),
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
    attachedAgentCountTotal: list.reduce((s, x) => s + (x.attachedAgentCount ?? 0), 0),
    members: sortedById(
      list.map((s) => ({
        id: s.id,
        key: s.key ?? s.name,
        folderId: s.folderId ?? null,
        sharingScope: s.sharingScope ?? null,
        forkedFromCompanyId: s.forkedFromCompanyId ?? null,
        attachedAgentCount: s.attachedAgentCount ?? 0,
      })),
    ),
  };
}

// Per-skill detail (`usedByAgents`): the real skill->agent attachment map.
export function summarizeSkillAssignments(details) {
  const rows = details.filter((d) => d && !d.__unavailable);
  const assignments = sortedById(
    rows.map((d) => ({
      skillId: d.id,
      skillKey: d.key ?? d.name,
      agentCount: Array.isArray(d.usedByAgents) ? d.usedByAgents.length : 0,
      agents: sortedById(
        (d.usedByAgents ?? []).map((u) => ({ id: u.id, name: u.name, adapterType: u.adapterType ?? null })),
      ),
    })),
  );
  const byAgent = {};
  for (const a of assignments) {
    for (const u of a.agents) {
      byAgent[u.id] = (byAgent[u.id] ?? 0) + 1;
    }
  }
  return {
    count: assignments.length,
    totalAssignments: assignments.reduce((s, a) => s + a.agentCount, 0),
    agentsWithSkills: Object.keys(byAgent).length,
    byAgent,
    assignments,
  };
}

export function summarizeRoutines(rows) {
  const list = rows ?? [];
  return {
    count: list.length,
    withAssignee: list.filter((r) => r.assigneeAgentId != null).length,
    byStatus: countBy(list.map((r) => r.status)),
    members: sortedById(
      list.map((r) => ({
        id: r.id,
        title: r.title ?? null,
        assigneeAgentId: r.assigneeAgentId ?? null,
        projectId: r.projectId ?? null,
        folderId: r.folderId ?? null,
      })),
    ),
  };
}

// Org tree: structural only (ids, names, roles, child counts); runtime status
// is dropped so two probes N minutes apart do not diff on idle<->running.
export function summarizeOrg(tree) {
  const list = Array.isArray(tree) ? tree : [];
  const nodes = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== "object") return;
    nodes.push({ id: node.id, name: node.name, role: node.role ?? null, depth, directReports: Array.isArray(node.reports) ? node.reports.length : 0 });
    for (const child of node.reports ?? []) walk(child, depth + 1);
  };
  for (const root of list) walk(root, 0);
  return {
    rootCount: list.length,
    nodeCount: nodes.length,
    roots: list.map((r) => ({ id: r.id, name: r.name, role: r.role ?? null })),
    nodes: nodes.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

export function summarizeFolders(payload) {
  if (!payload || typeof payload !== "object" || payload.__unavailable) {
    return { payload: redact(payload) };
  }
  const folders = Array.isArray(payload.folders) ? payload.folders : [];
  return {
    kind: payload.kind ?? null,
    folderCount: folders.length,
    allCount: payload.allCount ?? null,
    unfiledCount: payload.unfiledCount ?? null,
    folders: sortedById(
      folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId ?? null, path: f.path ?? null })),
    ),
  };
}

export function summarizeSecretsMeta(rows) {
  // Metadata only: keys, names, statuses — never values. The catalog endpoint
  // returns {id, name, key, status} without any secret material.
  const list = rows ?? [];
  const prefixOf = (key) => {
    const parts = String(key ?? "").split("-");
    return parts.length > 1 ? `${parts[0]}-${parts[1]}` : String(key ?? "");
  };
  return {
    count: list.length,
    byStatus: countBy(list.map((s) => s.status)),
    byPrefix: countBy(list.map((s) => prefixOf(s.key ?? s.name))),
    keys: sortedById(list.map((s) => ({ id: s.id, key: s.key ?? s.name, status: s.status }))),
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
    policies: sortedById(
      list.map((b) => ({
        policyId: b.policyId,
        scopeType: b.scopeType,
        scopeId: b.scopeId,
        metric: b.metric,
        amount: b.amount,
        observedAmount: b.observedAmount,
        utilizationPercent: b.utilizationPercent,
        status: b.status,
        isActive: b.isActive,
      })),
    ),
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

// Per-agent cost attribution: which agents accrue spend (structural), with
// the monetary/token counters left out of the diff (volatile live values).
export function summarizeCostsByAgent(rows) {
  const list = rows ?? [];
  return {
    agentsWithCost: sortedById(
      list.map((r) => ({ id: r.agentId, name: r.agentName ?? null })),
    ),
  };
}

// Per-agent configuration metadata: server already redacts values; the probe
// keeps only the shape (key names), never adapter config values.
export function summarizeAgentConfigurations(results) {
  const ok = results.filter((r) => r.payload && !r.payload.__unavailable);
  const configs = sortedById(
    ok.map(({ agentId, payload }) => ({
      agentId,
      name: payload.name ?? null,
      role: payload.role ?? null,
      reportsTo: payload.reportsTo ?? null,
      adapterType: payload.adapterType ?? null,
      adapterConfigKeys: Object.keys(payload.adapterConfig ?? {}).sort(),
      runtimeConfigKeys: Object.keys(payload.runtimeConfig ?? {}).sort(),
      permissions: payload.permissions ?? null,
    })),
  );
  return {
    count: configs.length,
    requested: results.length,
    unavailable: results.length - ok.length,
    configs,
  };
}

// Per-agent skill snapshots: skill KEYS only (desired attachment intent);
// snapshot entries/warnings content is not inventoried.
export function summarizeAgentSkills(results) {
  const ok = results.filter((r) => r.payload && !r.payload.__unavailable);
  const perAgent = sortedById(
    ok.map(({ agentId, payload }) => ({
      agentId,
      adapterType: payload.adapterType ?? null,
      supported: payload.supported ?? null,
      mode: payload.mode ?? null,
      desiredSkills: [...(payload.desiredSkills ?? [])].sort(),
      warningCount: Array.isArray(payload.warnings) ? payload.warnings.length : 0,
    })),
  );
  return {
    count: perAgent.length,
    requested: results.length,
    unavailable: results.length - ok.length,
    perAgent,
  };
}

// Per-agent instructions bundle metadata: mode, entry file, file count and
// file NAMES (paths) — never file contents.
export function summarizeAgentInstructions(results) {
  const ok = results.filter((r) => r.payload && !r.payload.__unavailable);
  const bundles = sortedById(
    ok.map(({ agentId, payload }) => ({
      agentId,
      mode: payload.mode ?? null,
      entryFile: payload.entryFile ?? null,
      fileCount: Array.isArray(payload.files) ? payload.files.length : 0,
      fileNames: (payload.files ?? []).map((f) => f.path).sort(),
      warningCount: Array.isArray(payload.warnings) ? payload.warnings.length : 0,
    })),
  );
  return {
    count: bundles.length,
    requested: results.length,
    unavailable: results.length - ok.length,
    bundles,
  };
}

export function summarizeRuntimeIdentity(payload) {
  if (!payload || typeof payload !== "object" || payload.__unavailable) {
    return { payload: redact(payload) };
  }
  return {
    id: payload.id ?? null,
    companyId: payload.companyId ?? null,
    name: payload.name ?? null,
    role: payload.role ?? null,
    adapterType: payload.adapterType ?? null,
    status: payload.status ?? null,
  };
}

// Per-agent memory-bank metadata: which agents hold a Hindsight memory bank
// and where it is anchored (agent-card vs plugin-config). Counters only — the
// memory items themselves are never listed or exported by the probe.
export function summarizeAgentMemory(results) {
  const ok = results.filter((r) => r.payload && !r.payload.__unavailable);
  const perAgent = sortedById(
    ok.map(({ agentId, payload }) => ({
      agentId,
      enabled: payload.enabled ?? null,
      hasBank: payload.bank != null,
      bankId: payload.bank?.bankId ?? null,
      bankSource: payload.bank?.source ?? null,
      reason: payload.reason ?? null,
    })),
  );
  return {
    count: perAgent.length,
    requested: results.length,
    unavailable: results.length - ok.length,
    agentsWithBank: perAgent.filter((a) => a.hasBank).length,
    byBankSource: countBy(perAgent.filter((a) => a.hasBank).map((a) => a.bankSource)),
    perAgent,
  };
}

// Knowledge-corpus datasets: structural metadata (id/name/description and the
// per-dataset document counters). Document bytes, parsed text and chunk text
// are never fetched — the probe only walks the dataset list.
export function summarizeCorpusDatasets(payload) {
  const list = Array.isArray(payload?.datasets) ? payload.datasets : [];
  const sum = (key) => list.reduce((s, d) => s + (d[key] ?? 0), 0);
  return {
    count: list.length,
    totalDocuments: sum("documentCount"),
    totalReady: sum("readyCount"),
    totalFailed: sum("failedCount"),
    totalChunks: sum("chunkCount"),
    datasets: sortedById(
      list.map((d) => ({
        id: d.id,
        companyId: d.companyId ?? null,
        name: d.name,
        documentCount: d.documentCount ?? 0,
        readyCount: d.readyCount ?? 0,
        failedCount: d.failedCount ?? 0,
        chunkCount: d.chunkCount ?? 0,
      })),
    ),
  };
}

// Company corpus aggregates as served by /corpus/stats (already counter-only).
export function summarizeCorpusStats(payload) {
  const stats = payload && typeof payload === "object" && payload.__unavailable
    ? payload
    : (payload?.stats ?? payload ?? {});
  if (stats.__unavailable) {
    return { available: false, reason: stats.__unavailable };
  }
  return {
    datasets: stats.datasets ?? null,
    documents: stats.documents ?? null,
    ready: stats.ready ?? null,
    pending: stats.pending ?? null,
    failed: stats.failed ?? null,
    chunks: stats.chunks ?? null,
    bytes: stats.bytes ?? null,
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
    case "org":
      return { available: true, ...summarizeOrg(payload) };
    case "skillFolders":
    case "routineFolders":
      return { available: true, ...summarizeFolders(payload) };
    case "secretsCatalog":
      return { available: true, ...summarizeSecretsMeta(rows) };
    case "budgetsOverview":
      return { available: true, ...summarizeBudgetsMeta(payload) };
    case "costsSummary":
      return { available: true, ...summarizeCostsSummary(payload) };
    case "costsByAgent":
      return { available: true, ...summarizeCostsByAgent(rows) };
    case "corpusDatasets":
      return { available: true, ...summarizeCorpusDatasets(payload) };
    case "corpusStats":
      return { ...summarizeCorpusStats(payload), available: true };
    case "runtimeIdentity":
      return { ...summarizeRuntimeIdentity(payload), available: true };
    case "goals":
    case "cases": {
      if (rows) return { available: true, count: rows.length };
      return { available: true, payload: redact(payload) };
    }
    case "aiConnections":
    case "chatEndpoints":
    case "secretProviderConfigs":
    case "exportFidelity": {
      if (rows) return { available: true, count: rows.length, items: redact(rows) };
      return { available: true, payload: redact(payload) };
    }
    default: {
      if (rows) return { available: true, count: rows.length };
      return { available: true, payload: redact(payload) };
    }
  }
}

function sectionPath(section, companyId) {
  if (section.absolutePath) {
    return section.path.replace(":companyId", encodeURIComponent(companyId));
  }
  return `/api/companies/${companyId}${section.path}`;
}

async function fetchSectionRows(section, { baseUrl, token, companyId }) {
  if (section.kind === "issues") {
    const pageSize = section.pageSize ?? 500;
    let payload = await getJson(
      baseUrl,
      `${sectionPath(section, companyId)}&limit=${pageSize}&offset=0`,
      token,
    );
    // Walk every page so the inventory cannot silently present a compact
    // sample as a complete task inventory. Each request stays a read-only GET.
    if (!Array.isArray(payload)) return payload;
    const allRows = [...payload];
    for (let offset = pageSize; payload.length === pageSize; offset += pageSize) {
      payload = await getJson(
        baseUrl,
        `${sectionPath(section, companyId)}&limit=${pageSize}&offset=${offset}`,
        token,
      );
      if (!Array.isArray(payload)) break;
      allRows.push(...payload);
    }
    return allRows;
  }
  const allow403 = section.optional === true;
  return getJson(baseUrl, sectionPath(section, companyId), token, { allow403 });
}

async function fetchPerItem(section, itemIds, { baseUrl, token, companyId }) {
  return mapPool(itemIds, 8, async (itemId) => {
    const path = section.path
      .replace(":agentId", encodeURIComponent(itemId))
      .replace(":skillId", encodeURIComponent(itemId))
      .replace(":secretId", encodeURIComponent(itemId))
      .replace(":companyId", encodeURIComponent(companyId));
    const payload = await getItem(baseUrl, path, token);
    // Normalize the item key for the per-agent summarizers; per-skill and
    // per-secret summarizers read the same key from their rows.
    return { itemId, agentId: itemId, skillId: itemId, secretId: itemId, payload };
  });
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
  const dependencies = [];
  let agentIds = [];
  for (const section of SECTIONS) {
    try {
      if (section.kind === "per-agent" || section.kind === "per-skill" || section.kind === "per-secret") {
        if (agentIds.length === 0 && section.kind === "per-agent") {
          report.sections[section.id] = { available: false, reason: "agents_unavailable" };
          continue;
        }
        const ids = section.kind === "per-agent"
          ? agentIds
          : section.kind === "per-skill"
            ? (report.sections.skills?.members ?? []).map((m) => m.id)
            : (report.sections.secretsCatalog?.keys ?? []).map((k) => k.id);
        const results = await fetchPerItem(section, ids, { baseUrl, token, companyId });
        report.sections[section.id] = summarizePerItemSection(section.id, results);
        if (section.attribution) {
          report.sections[section.id].attribution = [...section.attribution];
          const allBindings = section.id === "secretBindings"
            ? results.flatMap((r) => Array.isArray(r.payload?.bindings) ? r.payload.bindings : [])
            : results.map((r) => r.payload).filter((p) => p && !p.__unavailable);
          if (report.sections[section.id].available) {
            report.sections[section.id].missingAttribution = missingAttribution(section.attribution, allBindings);
          }
          if (section.attribution.includes("dependency") && allBindings.length > 0) {
            for (const row of formatInventoryDependencies(allBindings, { currentCompanyId: companyId })) {
              dependencies.push({ section: section.id, ...row });
            }
          }
        }
        continue;
      }
      const payload = await fetchSectionRows(section, { baseUrl, token, companyId });
      if (section.id === "agents" && Array.isArray(payload)) {
        // Deterministic per-agent sweep order for the derived sections.
        agentIds = payload.map((a) => a.id).filter(Boolean).sort();
      }
      report.sections[section.id] = summarizeSection(section.id, payload);
      const rawRows = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.datasets)
        ? payload.datasets
        : Array.isArray(payload?.items)
        ? payload.items
        : Array.isArray(payload?.secrets)
        ? payload.secrets
        : [];
      if (section.attribution) {
        report.sections[section.id].attribution = [...section.attribution];
        if (report.sections[section.id].available) {
          report.sections[section.id].missingAttribution = missingAttribution(section.attribution, rawRows);
        }
      }
      if (section.attribution?.includes("dependency") && rawRows.length > 0) {
        for (const row of formatInventoryDependencies(rawRows, { currentCompanyId: companyId })) {
          dependencies.push({ section: section.id, ...row });
        }
      }
    } catch (err) {
      if (section.optional) {
        report.sections[section.id] = { available: false, reason: `error: ${err.message}` };
      } else {
        throw err;
      }
    }
  }
  // Defensive final pass: no secret-material key survives into the report.
  report.sections = redact(report.sections);
  if (dependencies.length > 0) {
    report.dependencies = dependencies.sort((a, b) => {
      const ka = `${a.section}\0${a.objectId ?? ""}\0${a.status}\0${a.dependency?.type ?? ""}\0${a.dependency?.id ?? ""}\0${a.dependency?.companyId ?? ""}`;
      const kb = `${b.section}\0${b.objectId ?? ""}\0${b.status}\0${b.dependency?.type ?? ""}\0${b.dependency?.id ?? ""}\0${b.dependency?.companyId ?? ""}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  report.findings = collectFindings(report.sections, { currentCompanyId: companyId, dependencies: report.dependencies });
  report.reportSha256 = sha256Of({
    sections: report.sections,
    findings: report.findings,
    ...(report.dependencies ? { dependencies: report.dependencies } : {}),
  });
  return report;
}

function summarizePerItemSection(id, results) {
  switch (id) {
    case "agentConfigurations":
      return { available: true, ...summarizeAgentConfigurations(results) };
    case "agentSkills":
      return { available: true, ...summarizeAgentSkills(results) };
    case "agentInstructions":
      return { available: true, ...summarizeAgentInstructions(results) };
    case "agentMemory": {
      const s = summarizeAgentMemory(results);
      // A per-agent sweep that is unavailable for every agent (agent-key actor
      // against the board-only memory route) must read as unavailable — never
      // as "all agents hold no memory bank".
      if (s.requested > 0 && s.count === 0) {
        const firstReason = results.find((r) => r.payload?.__unavailable)?.payload.__unavailable
          ?? "unavailable";
        return { available: false, reason: firstReason, requested: s.requested, unavailable: s.unavailable };
      }
      return { available: true, ...s };
    }
    case "skillAssignments": {
      const details = results.map((r) => (r.payload?.__unavailable
        ? r.payload
        // Skill detail rows may omit `id` server-side; fall back to the
        // swept skill id so the assignment map is always attributable.
        : { id: r.skillId, ...r.payload, __unavailable: undefined }));
      const s = summarizeSkillAssignments(details);
      return { available: s.count > 0 || results.length === 0, ...s };
    }
    case "secretBindings": {
      const ok = results.filter((r) => r.payload && !r.payload.__unavailable);
      const bindings = sortedById(
        ok.flatMap(({ payload }) =>
          (payload.bindings ?? []).map((b) => ({
            secretId: payload.secretId ?? null,
            targetType: b.targetType ?? null,
            targetId: b.targetId ?? null,
            configPath: b.configPath ?? null,
            versionSelector: b.versionSelector ?? null,
            required: b.required ?? null,
          })),
        ),
      );
      const byTargetType = countBy(bindings.map((b) => b.targetType));
      return {
        available: ok.length > 0,
        requested: results.length,
        unavailable: results.length - ok.length,
        count: bindings.length,
        byTargetType,
        bindings,
      };
    }
    default:
      return { available: false, reason: `unknown per-item section ${id}` };
  }
}

// ---------------------------------------------------------------------------
// Findings: cross-company risk signals and owner gaps
// ---------------------------------------------------------------------------

export function collectFindings(sections, options = {}) {
  const findings = [];
  const collected = Array.isArray(options) ? options : (options?.dependencies ?? []);
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
  const assignments = sections.skillAssignments ?? {};
  if (assignments.available && skills.available && assignments.agentsWithSkills < agents.count) {
    findings.push({
      code: "agents_without_skills",
      severity: "warning",
      detail: `${agents.count - assignments.agentsWithSkills} agent(s) hold no company skill attachment — confirm intended skill sets before transfer`,
    });
  }
  const memory = sections.agentMemory ?? {};
  if (memory.available && memory.agentsWithBank > 0) {
    findings.push({
      code: "agents_with_memory_banks",
      severity: "warning",
      detail: `${memory.agentsWithBank} agent(s) hold a server-side memory bank (${(memory.byBankSource ?? {}).agentCard ?? 0} agent-card, ${(memory.byBankSource ?? {}).pluginConfig ?? 0} plugin-config) — the bank follows the agent; copy it with the agent at transfer`,
    });
  }
  const corpus = sections.corpusDatasets ?? {};
  if (corpus.available && corpus.count > 0) {
    findings.push({
      code: "corpus_datasets_present",
      severity: "warning",
      detail: `${corpus.count} knowledge-corpus dataset(s) (${corpus.totalDocuments} documents, ${corpus.totalChunks} chunks) — corporate corpus stays with the owning company; split per-company datasets before the pilot`,
    });
  }
  for (const section of SECTIONS) {
    if (section.optional !== true) continue;
    const s = sections[section.id];
    if (s && s.available === false) {
      findings.push({
        code: `${section.id}_unavailable`,
        severity: "warning",
        detail: `${section.id} surface not readable with this actor key (${s.reason ?? "unavailable"}) — inventory incomplete; rerun with a key that satisfies the route gate before the pilot`,
      });
    } else if (s && s.available === true && typeof s.requested === "number" && s.unavailable > 0) {
      findings.push({
        code: `${section.id}_partial`,
        severity: "warning",
        detail: `${section.id}: ${s.unavailable}/${s.requested} item(s) not readable with this actor key — partial coverage; rerun with a board key for full detail`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Diff between two captured reports
// ---------------------------------------------------------------------------

// Live-usage counters tick constantly on an active board (spend accumulates,
// agents flip idle<->running, tasks transition while the probe runs). They are
// recorded in reports but excluded from the content comparison: the diff must
// flag boundary/entity changes, not load or scheduling noise.
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
  "statusCounts",
  "byStatus",
  "open",
  // Per-assignee issue counts churn between two probe runs purely from board
  // activity (issue created/reassigned mid-run: observed 157->156 / 63->64 on
  // the live board). Ownership of issues is inventoried in the report itself;
  // it is excluded from the idempotency diff so a repeatable dry-run does not
  // flag routine board traffic as a boundary change.
  "byAssignee",
  // Live corpus counters tick as documents are parsed/fetched between runs;
  // the boundary-relevant facts are dataset membership and ownership, not the
  // momentary document/chunk/byte totals.
  "totalDocuments",
  "totalReady",
  "totalFailed",
  "totalChunks",
  "documents",
  "ready",
  "pending",
  "failed",
  "chunks",
  "bytes",
]);

function stripVolatile(node, depth = 0) {
  if (depth > 12) return node;
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


// ---------------------------------------------------------------------------
// Injected-transport inventory collector & cross-company dependency formatters (OPE-12905 / #3035)
// ---------------------------------------------------------------------------

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

const OWNER_REF_FIELD = "ownerCompanyId";

/** Reasons an agent owner ref can fail exact attribution. */
export const OWNER_REF_REASONS = Object.freeze({
  missingOwnerRef: "missing-owner-ref",
  ownerCompanyUnknown: "owner-company-not-in-known-set",
});

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

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
 * Serialize the ownership attribution of one entity kind (agents) from an
 * inventory payload. The probe performs no resolution lookups and no writes:
 * attribution is derived purely from the fetched rows plus an optional
 * caller-supplied set of company ids the board knows about.
 *
 * Contract (OPE-12906):
 * - missing or unusable owner ref  -> { attribution: "unknown",   ownerCompanyId: null, reason: "missing-owner-ref" }
 * - owner ref absent from the known set -> { attribution: "unresolved", ownerCompanyId: null, reason: "owner-company-not-in-known-set", ownerRefHash }
 * - known owner ref                -> { attribution: "resolved", ownerCompanyId: <exact id> }
 *
 * Fail-closed: only a ref verifiably present in `knownCompanyIds` may
 * serialize as resolved with its raw id. An empty or absent known set makes
 * every present ref unresolved (pseudonymized), never resolved-by-default;
 * a raw owner id can reach the report only when the board itself supplied it
 * as known. An unknown owner ref is NEVER serialized as the zero domain or
 * the current domain: `ownerCompanyId` stays `null` and the reason carries
 * the cause.
 * Entity and unresolved owner references are pseudonymized (truncated sha256)
 * so reports stay deterministic without carrying raw identifiers.
 * @param {Array<object>} entities agent rows in payload order (canonical)
 * @param {{knownCompanyIds?: Iterable<string>}} [options] the set of company
 *   ids the caller can verify; omitting it leaves every present ref unresolved
 * @returns {Array<object>} deterministic serialized ownership records
 */
export function serializeAgentOwnership(entities, { knownCompanyIds } = {}) {
  const known = knownCompanyIds instanceof Set ? knownCompanyIds : new Set(knownCompanyIds ?? []);
  const rows = Array.isArray(entities) ? entities : [];
  return rows.map((entity) => {
    const entityRef = entity && typeof entity === "object" && typeof entity.id === "string" && entity.id ? shortHash(entity.id) : null;
    const rawOwner = entity && typeof entity === "object" ? entity[OWNER_REF_FIELD] : undefined;
    if (typeof rawOwner !== "string" || !rawOwner.trim()) {
      return { entityRef, attribution: "unknown", ownerCompanyId: null, reason: OWNER_REF_REASONS.missingOwnerRef };
    }
    if (!known.has(rawOwner)) {
      return {
        entityRef,
        attribution: "unresolved",
        ownerCompanyId: null,
        reason: OWNER_REF_REASONS.ownerCompanyUnknown,
        ownerRefHash: shortHash(rawOwner),
      };
    }
    return { entityRef, attribution: "resolved", ownerCompanyId: rawOwner };
  });
}

/**
 * Attribution fields are reported from observed rows only: a declared field is
 * missing when at least one returned row lacks it (absent key, null, or
 * undefined). Field names only — row contents never enter the report.
 */
export function missingAttribution(attribution, rows) {
  if (!rows || !rows.length) return [...attribution];
  const missing = new Set();
  for (const row of rows) {
    for (const field of attribution) {
      const hasField = row !== null && typeof row === "object" && (
        (row[field] !== undefined && row[field] !== null) ||
        (field === "ownerCompanyId" && row.companyId !== undefined && row.companyId !== null)
      );
      if (!hasField) missing.add(field);
    }
  }
  return attribution.filter((field) => missing.has(field));
}

/**
 * Run the read-only inventory probe against an injected transport.
 * Sections whose registry contract names a `dependency` attribution also feed
 * the allowlisted cross-company dependency view: every listed object keeps a
 * visible row (`report.dependencies`), failed sections contribute none, and a
 * report with no collected objects carries no `dependencies` key at all.
 * @param {{request: (opts: {method: string, path: string}) => Promise<{status:number, ok:boolean, json?:() => Promise<unknown>}>}} transport
 * @param {{currentCompanyId?: string | null, knownCompanyIds?: Iterable<string>}} [options]
 * @returns {Promise<{sections: Array<object>, summary: object, ownership: {agents: Array<object>}, dependencies?: Array<object>}>}
 */
export async function collectInventory(transport, { currentCompanyId = null, knownCompanyIds } = {}) {
  const sections = [];
  const dependencies = [];
  let agentsPayload = null;
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
    const covered = state === "data" || state === "empty";
    if (definition.key === "agents" && state === "data") agentsPayload = payload;
    const section = {
      key: definition.key,
      path: definition.path,
      state,
      covered,
      count: state === "data" ? payload.length : 0,
      missingAttribution: state === "data" || state === "empty" ? missingAttribution(definition.attribution, payload) : [],
    };
    sections.push(section);
    if (covered && definition.attribution.includes("dependency")) {
      for (const row of formatInventoryDependencies(payload, { currentCompanyId })) {
        dependencies.push({ section: section.key, ...row });
      }
    }
  }
  const counts = Object.fromEntries(
    ["data", "empty", "denied", "not-found", "error"].map((state) => [state, sections.filter((s) => s.state === state).length]),
  );
  const report = {
    sections,
    summary: { total: sections.length, covered: sections.filter((s) => s.covered).length, counts },
    ownership: { agents: serializeAgentOwnership(agentsPayload ?? [], { knownCompanyIds }) },
  };
  if (dependencies.length > 0) {
    report.dependencies = dependencies;
  }
  return report;
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

const DEPENDENCY_UNRESOLVED_STATUSES = new Set(["unknown", "unresolved"]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Pure formatter for a single supported inventory object's cross-company dependency.
 * Strictly allowlists safe metadata (objectId, ownerCompanyId, status, dependency.{type,id,companyId})
 * so payload secrets/tokens/credentials are never copied into the report.
 */
export function formatCrossCompanyDependency(item, { currentCompanyId = null } = {}) {
  const objectId = item && typeof item === "object" ? nonEmptyString(item.id) : null;
  const ownerCompanyId = item && typeof item === "object" ? nonEmptyString(item.ownerCompanyId ?? item.companyId) : null;
  const baseCompanyId = nonEmptyString(currentCompanyId) ?? ownerCompanyId;

  if (!item || typeof item !== "object") {
    return canonicalize({
      objectId,
      ownerCompanyId,
      status: "unknown",
      dependency: null,
    });
  }

  if (item.dependency === undefined) {
    if (nonEmptyString(item.forkedFromCompanyId)) {
      const forkedCompany = nonEmptyString(item.forkedFromCompanyId);
      const isCross = baseCompanyId ? forkedCompany !== baseCompanyId : false;
      return canonicalize({
        objectId,
        ownerCompanyId,
        status: isCross ? "cross-company" : "same-company",
        dependency: {
          type: nonEmptyString(item.forkedFromSkillId) ? "skill" : "company",
          id: nonEmptyString(item.forkedFromSkillId) ?? objectId ?? forkedCompany,
          companyId: forkedCompany,
        },
      });
    }
    return canonicalize({
      objectId,
      ownerCompanyId,
      status: "unknown",
      dependency: null,
    });
  }

  const rawDep = item.dependency;
  if (!rawDep || typeof rawDep !== "object" || Array.isArray(rawDep) || rawDep.unresolved === true) {
    return canonicalize({
      objectId,
      ownerCompanyId,
      status: "unresolved",
      dependency: null,
    });
  }

  const type = nonEmptyString(rawDep.type);
  const id = nonEmptyString(rawDep.id);
  const companyId = nonEmptyString(rawDep.companyId ?? rawDep.targetCompanyId);

  if (!type || !id || !companyId || !baseCompanyId) {
    return canonicalize({
      objectId,
      ownerCompanyId,
      status: "unresolved",
      dependency: { type, id, companyId },
    });
  }

  const status = companyId !== baseCompanyId ? "cross-company" : "same-company";
  return canonicalize({
    objectId,
    ownerCompanyId,
    status,
    dependency: { type, id, companyId },
  });
}

export function formatInventoryDependencies(items, options = {}) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => formatCrossCompanyDependency(item, options))
    .sort((a, b) => {
      const ka = `${a.objectId ?? ""}\0${a.status}\0${a.dependency?.type ?? ""}\0${a.dependency?.id ?? ""}\0${a.dependency?.companyId ?? ""}`;
      const kb = `${b.objectId ?? ""}\0${b.status}\0${b.dependency?.type ?? ""}\0${b.dependency?.id ?? ""}\0${b.dependency?.companyId ?? ""}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

export function isUnresolvedDependencyStatus(status) {
  return DEPENDENCY_UNRESOLVED_STATUSES.has(status);
}

/** Deterministic normalized form of a probe report (sorted object keys, section order preserved). */
export function normalizeInventoryReport(report) {
  const base = { sections: report.sections, summary: report.summary };
  if (report.ownership !== undefined) {
    base.ownership = report.ownership;
  }
  if (report.dependencies !== undefined) {
    base.dependencies = report.dependencies;
  }
  return canonicalize(base);
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


const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(EXIT_USAGE);
  });
}

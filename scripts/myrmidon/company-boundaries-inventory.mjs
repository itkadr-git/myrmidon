#!/usr/bin/env node
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
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const PROBE_SCHEMA = "company-boundaries-inventory/v1";
export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;

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

export async function getJson(
  baseUrl,
  path,
  token,
  { allow403 = false, timeoutMs = 15000, fetchImpl = fetch } = {},
) {
  let res;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    res = await fetchImpl(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError" || err?.message?.toLowerCase().includes("timed out")) {
      throw new Error(`timeout: GET ${path} timed out after ${timeoutMs}ms`);
    }
    throw new Error(`transport error for ${path}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 403 && allow403) {
    return { __unavailable: "board_access_required", status: 403 };
  }
  if (res.status === 404 && allow403) {
    return { __unavailable: "route_not_found", status: 404 };
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
  "value", "valueCiphertext", "value_ciphertext", "ciphertext", "material", "plaintext",
  "secret", "secretValue", "secret_value", "secretValues", "token", "authToken", "auth_token",
  "vaultToken", "vault_token", "apiKey", "api_key", "keyHash", "key_hash", "password",
  "privateKey", "private_key", "privateKeyCiphertext", "private_key_ciphertext", "private_key_pem",
  "credential", "externalCredential", "external_credential", "envValue", "envValues",
  "accessKeyId", "secretAccessKey", "secret_access_key", "clientSecret", "client_secret",
  "certificate", "authorization", "bearer", "encryptedValue", "encrypted_value",
  "encryptedData", "encrypted_data", "iv", "authTag", "auth_tag",
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

// Normalized metadata for secret provider vault configs (OPE-12860). The board
// route returns full rows whose `config` jsonb can carry vault endpoints and
// credential material; the inventory keeps identifiers, ownership and provider
// link only, and never materializes `config`, health message/details text
// (which can echo provider errors containing config), or any value-shaped key.
export function summarizeSecretProviderConfigs(rows) {
  const list = rows ?? [];
  return {
    count: list.length,
    byProvider: countBy(list.map((c) => c.provider)),
    byStatus: countBy(list.map((c) => c.status)),
    defaultProviders: list.filter((c) => c.isDefault === true).map((c) => c.provider).sort(),
    configs: list
      .map((c) => ({
        id: c.id,
        provider: c.provider,
        displayName: c.displayName,
        status: c.status,
        isDefault: c.isDefault === true,
        healthStatus: c.healthStatus ?? null,
        createdByAgentId: c.createdByAgentId ?? null,
        createdByUserId: c.createdByUserId ?? null,
        createdAt: c.createdAt ?? null,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

// Normalized metadata for secret bindings (OPE-12860). There is no agent/board
// REST surface for `company_secret_bindings` yet (GET /secret-bindings -> 404),
// so live probes record coverage-missing via the unavailable path; this
// summarizer exists for the confirmed export feed so binding topology can be
// inventoried without ever touching secret values.
export function summarizeSecretBindings(rows) {
  const list = rows ?? [];
  return {
    count: list.length,
    byTargetType: countBy(list.map((b) => b.targetType)),
    byProjectionClass: countBy(list.map((b) => b.projectionClass)),
    required: list.filter((b) => b.required === true).length,
    bindings: list
      .map((b) => ({
        id: b.id,
        secretId: b.secretId,
        targetType: b.targetType,
        targetId: b.targetId,
        configPath: b.configPath,
        versionSelector: b.versionSelector ?? null,
        required: b.required === true,
        projectionClass: b.projectionClass ?? null,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
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
    case "secretProviderConfigs":
      return { available: true, ...summarizeSecretProviderConfigs(rows) };
    case "secretBindings":
      return { available: true, ...summarizeSecretBindings(rows) };
    case "budgetsOverview":
      return { available: true, ...summarizeBudgetsMeta(payload) };
    case "costsSummary":
      return { available: true, ...summarizeCostsSummary(payload) };
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

export async function runProbe({ baseUrl, token, companyId, fetchImpl = fetch, timeoutMs = 15000 }) {
  const report = {
    schema: PROBE_SCHEMA,
    generatedAt: new Date().toISOString(),
    companyId,
    mode: "dry-run-read-only",
    sections: {},
    findings: [],
  };
  for (const section of SECTIONS) {
    const path = `/api/companies/${companyId}${section.path}`;
    try {
      let payload = await getJson(baseUrl, path, token, {
        allow403: section.optional === true,
        timeoutMs,
        fetchImpl,
      });
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

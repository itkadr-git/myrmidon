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
 * Attribution fields are reported from observed rows only: a declared field is
 * missing when at least one returned row lacks it (absent key, null, or
 * undefined). Field names only — row contents never enter the report.
 */
function missingAttribution(attribution, rows) {
  if (!rows || !rows.length) return [...attribution];
  const missing = new Set();
  for (const row of rows) {
    for (const field of attribution) {
      const hasField = row !== null && typeof row === "object" && row[field] !== undefined && row[field] !== null;
      if (!hasField) missing.add(field);
    }
  }
  return attribution.filter((field) => missing.has(field));
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
      missingAttribution: state === "data" || state === "empty" ? missingAttribution(definition.attribution, payload) : [],
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
/* --- Source labels (OPE-12912): safe attribution, never credential payload --- */

const SOURCE_LABEL_COVERAGE_STATES = Object.freeze(["data", "empty", "denied", "not-found", "error"]);

const SOURCE_LABEL_CREDENTIAL_FIELDS = Object.freeze([
  "credential",
  "credentials",
  "token",
  "apiKey",
  "secret",
  "password",
  "authorization",
]);

/** Reasons a source entry fails exact attribution; the report never invents labels. */
export const SOURCE_LABEL_REASONS = Object.freeze({
  unknownEndpoint: "unknown-endpoint",
  unknownCategory: "unknown-category",
  categoryEndpointMismatch: "category-endpoint-mismatch",
  coverageUnknown: "unknown-coverage",
});

/** Fixed marker emitted when a credential-bearing field is present; the value itself is never copied. */
export const SOURCE_LABEL_CREDENTIAL_REDACTED = "redacted";

function sourceLabelString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sourceHasCredential(source) {
  if (!source || typeof source !== "object") return false;
  return SOURCE_LABEL_CREDENTIAL_FIELDS.some((field) => {
    const value = source[field];
    return value !== null && value !== undefined && value !== "" && value !== false;
  });
}

/**
 * Pure formatter for one inventory source entry. Only validated registry labels
 * (endpoint path, matching section category), a canonical coverage state, and a
 * redacted credential-presence marker are emitted. Endpoint/category values are
 * shown only when they resolve through INVENTORY_SECTIONS; anything else —
 * including credential-shaped strings — stays out of the report.
 */
export function formatInventorySourceLabel(source) {
  const endpoint = sourceLabelString(source?.endpoint);
  const category = sourceLabelString(source?.category);
  const coverage = sourceLabelString(source?.coverage);
  const section = endpoint ? sectionForPath(endpoint) : null;

  let reason = null;
  const endpointLabel = section ? endpoint : null;
  if (!section) reason = SOURCE_LABEL_REASONS.unknownEndpoint;
  const categoryLabel = section && category && category === section.key ? category : null;
  if (section && !categoryLabel && reason === null) {
    reason = category ? SOURCE_LABEL_REASONS.categoryEndpointMismatch : SOURCE_LABEL_REASONS.unknownCategory;
  }
  const coverageLabel = coverage && SOURCE_LABEL_COVERAGE_STATES.includes(coverage) ? coverage : "unknown";
  if (coverageLabel === "unknown" && reason === null) reason = SOURCE_LABEL_REASONS.coverageUnknown;

  return canonicalize({
    endpoint: endpointLabel,
    category: categoryLabel,
    coverage: coverageLabel,
    credential: sourceHasCredential(source) ? SOURCE_LABEL_CREDENTIAL_REDACTED : null,
    attribution: reason === null ? "resolved" : "unknown",
    reason,
  });
}

/** Deterministic batch form: per-entry labels sorted by (endpoint, category, coverage). */
export function formatInventorySourceLabels(sources) {
  if (!Array.isArray(sources)) return [];
  return sources
    .map((source) => formatInventorySourceLabel(source))
    .sort((a, b) => {
      const ka = `${a.endpoint ?? ""}\0${a.category ?? ""}\0${a.coverage}`;
      const kb = `${b.endpoint ?? ""}\0${b.category ?? ""}\0${b.coverage}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
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

/**
 * Deterministic normalized form of a probe report (sorted object keys, section
 * order preserved). `sourceLabels` (OPE-12912) participates in normalization
 * only when provided, so existing reports keep their shape and hash.
 */
export function normalizeInventoryReport(report) {
  const base = { sections: report.sections, summary: report.summary };
  if (report.sourceLabels !== undefined) {
    base.sourceLabels = report.sourceLabels;
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

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error("This module requires an injected read-only GET transport; no live calls are performed.");
  process.exitCode = 2;
}

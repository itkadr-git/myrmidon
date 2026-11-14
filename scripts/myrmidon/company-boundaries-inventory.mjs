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
 * Sections whose registry contract names a `dependency` attribution also feed
 * the allowlisted cross-company dependency view: every listed object keeps a
 * visible row (`report.dependencies`), failed sections contribute none, and a
 * report with no collected objects carries no `dependencies` key at all.
 * @param {{request: (opts: {method: string, path: string}) => Promise<{status:number, ok:boolean, json?:() => Promise<unknown>}>}} transport
 * @param {{currentCompanyId?: string | null}} [options]
 * @returns {Promise<{sections: Array<object>, summary: object, dependencies?: Array<object>}>}
 */
export async function collectInventory(transport, { currentCompanyId = null } = {}) {
  const sections = [];
  const dependencies = [];
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
  const ownerCompanyId = item && typeof item === "object" ? nonEmptyString(item.ownerCompanyId) : null;
  const baseCompanyId = nonEmptyString(currentCompanyId) ?? ownerCompanyId;

  if (!item || typeof item !== "object" || item.dependency === undefined) {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error("This module requires an injected read-only GET transport; no live calls are performed.");
  process.exitCode = 2;
}

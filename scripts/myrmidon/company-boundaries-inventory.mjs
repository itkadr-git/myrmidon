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

/** Marker substituted for every secret-shaped string found in rendered output. */
const INVENTORY_REDACTED = "[REDACTED]";

/**
 * Secret-shape matchers applied at render time as defense in depth: the probe
 * structurally never copies payload values into the report, so these patterns
 * only fire on values that a future regression injects into output fields.
 * Covers board key prefixes (pcp_*), common token prefixes, and bearer headers.
 */
const INVENTORY_SECRET_PATTERNS = Object.freeze([
  /pcp_[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
]);

function redactInventoryText(text) {
  let redacted = text;
  for (const pattern of INVENTORY_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, INVENTORY_REDACTED);
  }
  return redacted;
}

function redactInventoryDeep(value) {
  if (typeof value === "string") return redactInventoryText(value);
  if (Array.isArray(value)) return value.map(redactInventoryDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactInventoryDeep(entry)]));
  }
  return value;
}

/** JSON rendering of the inventory summary; secret-shaped values are masked before serialization. */
export function renderInventory(report) {
  return JSON.stringify(redactInventoryDeep(normalizeInventoryReport(report)));
}

export function sectionForPath(path) {
  return SECTION_BY_PATH.get(path);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error("This module requires an injected read-only GET transport; no live calls are performed.");
  process.exitCode = 2;
}

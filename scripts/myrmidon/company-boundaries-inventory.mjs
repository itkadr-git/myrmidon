#!/usr/bin/env node
/** Read-only company-boundaries inventory probe with owner/domain attribution.
 *
 * The HTTP transport is injected by the caller: this module never opens
 * connections and never performs writes. Every request the probe issues is
 * a GET; a transport that observes any other method is a contract violation
 * and must fail the probe (see company-boundaries-inventory.test.mjs).
 *
 * Attribution is extracted ONLY from verifiable source fields of the section
 * payloads the transport returns. Nothing is guessed from names, titles or
 * free-text fields: an entity without a verifiable owner field is reported as
 * owner "unknown" with ownerKnown=false. The attribution summary is
 * deterministic and contains no sensitive values: owners are ids or the
 * literal "unknown" marker; domains are declared-field values or the unknown
 * marker. Secret-value keys are dropped defensively even if a payload row
 * carries them, and raw payload rows never enter the report.
 */

import { createHash } from "node:crypto";

export const UNKNOWN_OWNER = "unknown";

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

// Fields that must never survive into a report, even if an upstream row
// carries them. Mirrors the secret-surface allowlist in ADR-0052.
const SENSITIVE_VALUE_KEYS = new Set([
  "value", "valueCiphertext", "value_ciphertext", "material", "plaintext",
  "secret", "token", "apiKey", "api_key", "keyHash", "key_hash", "password",
  "privateKey", "private_key", "privateKeyCiphertext", "private_key_ciphertext",
  "credential", "externalCredential", "external_credential", "envValue",
]);

// Per-section owner attribution fields, in verification order. The first
// present, non-empty field wins; ids are copied verbatim (verifiable source
// fields only — no name/title/urlKey heuristics). Section keys are the
// INVENTORY_SECTIONS registry keys.
//
// OPE-12872 (skills domain, registry section `skills-policies`): a company
// skill carries its owner only in metadata — the fork writer stamps
// metadata.forkedByAgentId / metadata.forkedByUserId
// (server/src/services/company-skills.ts). Free-text authorName and the
// external GitHub/skills.sh metadata.owner are source provenance, not company
// ownership, so they are never consulted.
const OWNER_FIELDS_BY_SECTION = new Map([
  ["issues", ["assigneeAgentId", "assigneeUserId"]],
  ["agents", ["reportsTo"]],
  ["projects-documents", ["leadAgentId"]],
  ["secrets-bindings", ["ownerUserId"]],
  ["skills-policies", ["metadata.forkedByAgentId", "metadata.forkedByUserId"]],
]);

export function isKnownId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function stripSensitive(row) {
  if (!row || typeof row !== "object") return {};
  const out = {};
  for (const [key, val] of Object.entries(row)) {
    if (!SENSITIVE_VALUE_KEYS.has(key)) out[key] = val;
  }
  return out;
}

function firstOwnerField(section, row) {
  const fields = OWNER_FIELDS_BY_SECTION.get(section);
  if (!fields) return null;
  for (const field of fields) {
    const [root, nested] = field.split(".");
    const value = nested && row[root] && typeof row[root] === "object"
      ? row[root][nested]
      : row[field];
    if (isKnownId(value)) return { field, id: value.trim() };
  }
  return null;
}

function declaredDomain(row) {
  if (isKnownId(row.domain)) {
    return { domain: row.domain.trim().toLowerCase(), source: "domain" };
  }
  const metadataDomain = row.metadata && typeof row.metadata === "object" ? row.metadata.domain : null;
  if (isKnownId(metadataDomain)) {
    return { domain: metadataDomain.trim().toLowerCase(), source: "metadata.domain" };
  }
  return null;
}

// Skills domain only: sharingScope is the single declared boundary field on a
// company skill (CompanySkillSharingScope: private | company | public_link).
// public_link is externally reachable, so it maps to its own domain marker;
// the company-scoped values collapse to the company domain marker. Any other
// value is unknown, not a guess.
function declaredSharingScopeDomain(row) {
  if (row.sharingScope === "public_link") {
    return { domain: "public_link", source: "sharingScope" };
  }
  if (row.sharingScope === "company" || row.sharingScope === "private") {
    return { domain: "company", source: "sharingScope" };
  }
  return null;
}

/**
 * Attribute one entity of a known inventory section to an owner and a domain.
 * @param {string} section one of the OWNER_FIELDS_BY_SECTION keys
 * @param {object} row the source row (used read-only; sensitive keys ignored)
 * @returns {{section: string, entityId: string, owner: string, ownerKnown: boolean,
 *            ownerSource: string|null, ownerRef: string|null,
 *            domain: string, domainSource: string|null}}
 */
export function attributeOwnership(section, row) {
  const cleanRow = stripSensitive(row && typeof row === "object" ? row : {});
  const entityId = isKnownId(cleanRow.id) ? cleanRow.id.trim() : "";

  const ownerField = firstOwnerField(section, cleanRow);
  const owner = ownerField ? ownerField.id : UNKNOWN_OWNER;
  const ownerRef = ownerField ? ownerField.id : null;

  // Domain attribution: declared fields only. The skills domain
  // (OPE-12872) reads its single declared boundary field — the sharing
  // scope ("public_link" is externally linkable; "company"/"private" are
  // company-scoped) — and ignores generic domain fields entirely. Other
  // sections keep the generic declared-domain lookup. Without a declared
  // field the domain stays unknown — no inference from names, ids or
  // company membership.
  const domain = section === "skills-policies"
    ? declaredSharingScopeDomain(cleanRow)
    : declaredDomain(cleanRow) ?? declaredSharingScopeDomain(cleanRow);

  return {
    section,
    entityId,
    owner,
    ownerKnown: Boolean(ownerField),
    ownerSource: ownerField ? ownerField.field : null,
    ownerRef,
    domain: domain ? domain.domain : UNKNOWN_OWNER,
    domainSource: domain ? domain.source : null,
  };
}

function countByOwner(entries) {
  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry.owner, (counts.get(entry.owner) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([owner, count]) => ({
      owner,
      known: owner !== UNKNOWN_OWNER,
      count,
    }));
}

/**
 * Deterministic attribution summary over attributed rows. Owners are sorted
 * alphabetically; the summary carries ids/unknown markers and counts only —
 * never titles, names or any sensitive row values.
 * @param {Array<ReturnType<typeof attributeOwnership>>} entries
 * @returns {{total: number, knownOwners: number, unknownOwners: number,
 *            owners: Array<{owner: string, known: boolean, count: number}>,
 *            domains: Record<string, number>}}
 */
export function summarizeAttribution(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const owners = countByOwner(list);
  const domains = {};
  for (const entry of list) {
    domains[entry.domain] = (domains[entry.domain] ?? 0) + 1;
  }
  return {
    total: list.length,
    knownOwners: list.filter((e) => e.ownerKnown).length,
    unknownOwners: list.filter((e) => !e.ownerKnown).length,
    owners,
    domains,
  };
}

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
 * Run the read-only inventory probe against an injected transport and
 * attribute every covered row with a defined owner mapping.
 * @param {{request: (opts: {method: string, path: string}) => Promise<{status:number, ok:boolean, json?:() => Promise<unknown>}>}} transport
 * @returns {Promise<{sections: Array<object>, attribution: object, summary: object}>}
 */
export async function collectInventory(transport) {
  const sections = [];
  const attributedEntries = [];
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
    const section = {
      key: definition.key,
      path: definition.path,
      state,
      covered: state === "data" || state === "empty",
      count: state === "data" ? payload.length : 0,
      missingAttribution: state === "data" || state === "empty" ? [...definition.attribution] : [],
    };
    // OPE-12872: attribute ownership into the report. A covered section with
    // a defined owner mapping attributes every payload row; sections without
    // a mapping and states without rows carry no ownership block — the report
    // never invents attribution.
    if (section.covered && OWNER_FIELDS_BY_SECTION.has(definition.key)) {
      const entries = (payload ?? []).map((row) => attributeOwnership(definition.key, row));
      section.ownership = summarizeAttribution(entries);
      attributedEntries.push(...entries);
    }
    sections.push(section);
  }
  const counts = Object.fromEntries(
    ["data", "empty", "denied", "not-found", "error"].map((state) => [state, sections.filter((s) => s.state === state).length]),
  );
  return {
    sections,
    attribution: summarizeAttribution(attributedEntries),
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

/** Deterministic normalized form of a probe report (sorted object keys, section order preserved).
 * OPE-12872: the attribution summary is part of the report, so it is normalized and hashed with it. */
export function normalizeInventoryReport(report) {
  return canonicalize({ sections: report.sections, attribution: report.attribution, summary: report.summary });
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

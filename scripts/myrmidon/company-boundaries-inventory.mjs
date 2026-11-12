#!/usr/bin/env node
// OPE-12871: owner/domain attribution for the read-only company-boundaries
// inventory (extends the Phase 0 dry-run in ADR-0052).
//
// Every attribution below is extracted ONLY from verifiable source fields of
// an already-supported domain surface (issues, agents, projects/documents,
// secrets bindings metadata). Nothing is guessed from names, titles or
// free-text fields: an entity without a verifiable owner field is reported as
// owner "unknown" with ownerKnown=false.
//
// The attribution summary is deterministic (sorted, fixed key order) and
// contains no sensitive values: owners are ids, the literal "unknown" marker,
// or normalized domain names from declared domain fields only. Secret-value
// keys are dropped defensively even if a caller passes a polluted row.
//
// Read-only: this module performs no I/O of its own — callers feed it the rows
// they already fetched with the read-only probe.

export const UNKNOWN_OWNER = "unknown";

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
// fields only — no name/title/urlKey heuristics).
const OWNER_FIELDS_BY_SECTION = new Map([
  ["issues", ["assigneeAgentId", "assigneeUserId"]],
  ["agents", ["reportsTo"]],
  ["projects-documents", ["leadAgentId"]],
  ["secrets-bindings", ["ownerUserId"]],
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
    if (isKnownId(row[field])) return { field, id: row[field].trim() };
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

  // Domain attribution: declared domain fields only. Without one, the domain
  // stays unknown — no inference from names, ids or company membership.
  const domain = declaredDomain(cleanRow);

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

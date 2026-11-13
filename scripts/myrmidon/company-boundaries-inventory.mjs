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

const OWNER_FIELD = "ownerCompanyId";
const DEPENDENCY_FIELD = "dependency";
const DEPENDENCY_REF_KEYS = Object.freeze(["type", "id", "companyId"]);
/** Max exact-identifier length: company ids and ref keys are short; longer
 * "identifiers" are payload masquerading in an id slot. */
const IDENTIFIER_MAX_LENGTH = 100;
/** UUID shape and lowercase slug shape: the only exact identifier shapes this
 * formatter may echo verbatim. Company ids in this codebase are lowercase
 * slugs ("c1") or UUIDs; anything longer, uppercase, or otherwise shaped is
 * payload masquerading in an id slot and must never be serialized. */
const SAFE_IDENTIFIER_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z][a-z0-9_-]{0,49})$/;
/** Secret-shaped values never echo verbatim even if they fit an id shape.
 * Mirrors the token-prefix rules of scripts/myrmidon/scan-text.mjs so the
 * formatter and the publication scanner agree on what is secret-like. */
const SECRET_SHAPED_RE = /(?:^|[^A-Za-z0-9])(?:pcp_[A-Za-z0-9_-]*|sk-[A-Za-z0-9_-]+|gh[ousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)/;

/** True when a string is safe to serialize verbatim as an identifier. */
function isSafeIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length <= IDENTIFIER_MAX_LENGTH &&
    !SECRET_SHAPED_RE.test(value) &&
    SAFE_IDENTIFIER_RE.test(value)
  );
}

/**
 * Attribution outcomes are deliberately distinct:
 * - `unknown` — the object declares no owner/dependency fields at all; attribution is impossible.
 * - `unresolved` — attribution fields are declared but could not be exactly verified (reason stated).
 * These are different facts: collapsing them would turn "no link exists" into "we could not check".
 */
/** Reasons an object's owner attribution cannot be exactly stated. */
export const OWNER_ATTRIBUTION_REASONS = Object.freeze({
  noFields: "no-owner-dependency-fields",
  missingOwnerRef: "missing-owner-ref",
  ownerRefNotString: "owner-ref-not-a-string",
  ownerCompanyUnknown: "owner-company-not-in-known-set",
  dependencyRefInvalid: "dependency-ref-invalid",
  currentCompanyUnknown: "current-company-unknown",
  unsafeIdentifier: "identifier-not-safe-to-echo",
});

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

const UNRESOLVED_ATTRIBUTION_STATES = new Set(["unknown", "unresolved"]);

/** True when attribution means the cross-company relation could not be verified. */
export function isUnresolvedAttribution(attribution) {
  return UNRESOLVED_ATTRIBUTION_STATES.has(attribution);
}

/** Only these exact identifier fields of a dependency ref may be serialized. */
function safeDependencyRef(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  const safe = {};
  let any = false;
  for (const key of DEPENDENCY_REF_KEYS) {
    // Identifier slots get the same gate as the owner slot: a string that is
    // not a safe identifier (secret-shaped, oversize, exotic punctuation) is
    // dropped from the ref rather than echoed, and drops completeness.
    const value = isSafeIdentifier(ref[key]) ? ref[key] : null;
    safe[key] = value;
    if (value !== null) any = true;
  }
  return any ? safe : null;
}

/**
 * Format per-object owner attribution for arbitrary inventory rows (OPE-12910).
 *
 * The intent is to distinguish "this object carries no cross-company link" from
 * "the link cannot be verified":
 * - an object with NEITHER an owner field NOR a dependency field is reported
 *   `attribution: "unknown"` with reason `no-owner-dependency-fields`;
 * - an object whose owner/dependency fields are present but unusable (owner not
 *   in the known company set, malformed dependency ref, missing comparison
 *   context) is reported `attribution: "unresolved"` with the cause;
 * - only exact, safe identifiers are serialized: a resolved owner company id is
 *   echoed verbatim; a dependency ref contributes only its `type`/`id`/
 *   `companyId` strings; unverifiable refs are pseudonymized (truncated sha256).
 *   Identifier slots are themselves gated: a value in `ownerCompanyId` or a
 *   dependency ref key that is not a safe identifier shape (UUID or short
 *   slug — this includes secret-shaped strings like token prefixes) is never
 *   echoed; it is pseudonymized (owner) or dropped from the ref (dependency)
 *   and the row reports `unresolved` with `identifier-not-safe-to-echo`.
 *
 * Sensitive values never enter the output — neither from payload fields
 * beyond the identifier keys nor from the identifier slots themselves.
 *
 * When both halves are present but unusable, the row's single `reason` names
 * the owner cause (owner field is the attribution field); with no owner field
 * at all, the dependency cause explains the row. The other half stays visible
 * through `dependencyStatus`/`dependency`.
 *
 * @param {Array<unknown>} entities inventory rows in payload order
 * @param {{currentCompanyId?: string, knownCompanyIds?: Iterable<string>}} [options]
 * @returns {{rows: Array<object>, summary: object}} rows sorted by entityRef for
 *   input-order-independent output, plus a status summary
 */
export function formatOwnerAttribution(entities, { currentCompanyId, knownCompanyIds } = {}) {
  const known = knownCompanyIds instanceof Set ? knownCompanyIds : new Set(knownCompanyIds ?? []);
  const sourceRows = Array.isArray(entities) ? entities : [];
  const rows = sourceRows.map((entity) => {
    const isObject = entity !== null && typeof entity === "object" && !Array.isArray(entity);
    const entityRef = isObject && typeof entity.id === "string" && entity.id ? shortHash(entity.id) : null;
    if (!isObject) {
      return { entityRef, attribution: "unknown", reason: OWNER_ATTRIBUTION_REASONS.noFields, ownerCompanyId: null, ownerRefHash: null, dependencyStatus: null, dependency: null };
    }
    const ownerRaw = entity[OWNER_FIELD];
    const dependencyRaw = entity[DEPENDENCY_FIELD];
    const hasOwnerField = ownerRaw !== undefined && ownerRaw !== null;
    const hasDependencyField = dependencyRaw !== undefined;
    if (!hasOwnerField && !hasDependencyField) {
      return { entityRef, attribution: "unknown", reason: OWNER_ATTRIBUTION_REASONS.noFields, ownerCompanyId: null, ownerRefHash: null, dependencyStatus: null, dependency: null };
    }

    let ownerCompanyId = null;
    let ownerRefHash = null;
    let ownerReason = null;
    let ownerResolved = false;
    if (!hasOwnerField || (typeof ownerRaw === "string" && !ownerRaw.trim())) {
      ownerReason = OWNER_ATTRIBUTION_REASONS.missingOwnerRef;
    } else if (typeof ownerRaw !== "string") {
      ownerReason = OWNER_ATTRIBUTION_REASONS.ownerRefNotString;
      ownerRefHash = shortHash(JSON.stringify(ownerRaw) ?? String(ownerRaw));
    } else if (!isSafeIdentifier(ownerRaw)) {
      // Secret-shaped or otherwise non-identifier values in the owner slot are
      // never echoed verbatim: they are pseudonymized and the row stays
      // unresolved even when the value is in the known set — "exact safe
      // identifiers" is a property of the output, not of the lookup.
      ownerReason = OWNER_ATTRIBUTION_REASONS.unsafeIdentifier;
      ownerRefHash = shortHash(ownerRaw);
    } else if (known.size > 0 && !known.has(ownerRaw)) {
      ownerReason = OWNER_ATTRIBUTION_REASONS.ownerCompanyUnknown;
      ownerRefHash = shortHash(ownerRaw);
    } else {
      ownerCompanyId = ownerRaw;
      ownerResolved = true;
    }

    let dependencyStatus = null;
    let dependency = null;
    let dependencyReason = null;
    let dependencyResolved = false;
    if (hasDependencyField) {
      const safe = safeDependencyRef(dependencyRaw);
      const complete = safe !== null && DEPENDENCY_REF_KEYS.every((key) => safe[key] !== null);
      if (safe !== null) dependency = safe;
      if (!complete) {
        dependencyReason = OWNER_ATTRIBUTION_REASONS.dependencyRefInvalid;
      } else if (typeof currentCompanyId !== "string" || !currentCompanyId) {
        dependencyReason = OWNER_ATTRIBUTION_REASONS.currentCompanyUnknown;
      } else {
        dependencyStatus = safe.companyId === currentCompanyId ? "same-company" : "cross-company";
        dependencyResolved = true;
      }
    }

    const attribution = ownerResolved || dependencyResolved ? "resolved" : "unresolved";
    // The reason names the present-but-unusable half: an unusable owner field
    // wins because it is the attribution field; with no owner field at all the
    // dependency cause explains the row.
    const reason = hasOwnerField ? ownerReason : dependencyReason ?? ownerReason;
    const row = { entityRef, attribution, ownerCompanyId: ownerCompanyId, ownerRefHash, dependencyStatus, dependency };
    if (reason) row.reason = reason;
    return row;
  });
  rows.sort((a, b) => (a.entityRef ?? "").localeCompare(b.entityRef ?? ""));
  const summary = {
    total: rows.length,
    resolved: rows.filter((row) => row.attribution === "resolved").length,
    unresolved: rows.filter((row) => row.attribution === "unresolved").length,
    unknown: rows.filter((row) => row.attribution === "unknown").length,
    crossCompanyLinks: rows.filter((row) => row.dependencyStatus === "cross-company").length,
    noOwnerDependencyFields: rows.filter((row) => row.reason === OWNER_ATTRIBUTION_REASONS.noFields).length,
  };
  return { rows, summary };
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
 * order preserved). An optional per-object `attribution` block (OPE-12910
 * formatter output) is carried through only when the caller provided one, so
 * reports without it keep their pre-existing normalized shape.
 */
export function normalizeInventoryReport(report) {
  const normalized = { sections: report.sections, summary: report.summary };
  if (report.attribution !== undefined) normalized.attribution = report.attribution;
  return canonicalize(normalized);
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

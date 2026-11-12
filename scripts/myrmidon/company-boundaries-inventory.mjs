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
// Domain attribution is allowlisted: only the supported domain identifiers of
// the 1.7 company split (adm, bbq, life, work — ADR-0052) and the two
// sharingScope boundary markers (company, public_link — OPE-12872 chain) are
// ever copied into a result. Any other declared string collapses to the
// "unknown" marker, so an arbitrary (potentially sensitive) value in a
// `domain` / `metadata.domain` field can never leak into a summary.
//
// The attribution summary is deterministic (sorted, fixed key order) and
// contains no sensitive values: owners are ids, the literal "unknown" marker,
// or allowlisted domain identifiers. Secret-value keys are dropped
// defensively even if a caller passes a polluted row.
//
// Read-only: this module performs no network I/O of its own. Callers feed it
// the rows they already fetched with the read-only probe, or a captured
// sections file (`attribution` command below) to append the attribution
// summary to the inventory report:
//
//   node scripts/myrmidon/company-boundaries-inventory.mjs attribution \
//     --report captured-sections.json [--out attribution.json]
//
// The captured file is either `{ "sections": { "<inventory section>": [raw
// rows...] } }` (the shape the dry-run probe collects before summarizing) or
// the plain sections object itself. Only array-valued, supported inventory
// sections are attributed; everything else is ignored without invention.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const UNKNOWN_OWNER = "unknown";

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;

export const ATTRIBUTION_REPORT_SCHEMA = "company-boundaries-attribution/v1";

// Fields that must never survive into a report, even if an upstream row
// carries them. Mirrors the secret-surface allowlist in ADR-0052.
const SENSITIVE_VALUE_KEYS = new Set([
  "value", "valueCiphertext", "value_ciphertext", "material", "plaintext",
  "secret", "token", "apiKey", "api_key", "keyHash", "key_hash", "password",
  "privateKey", "private_key", "privateKeyCiphertext", "private_key_ciphertext",
  "credential", "externalCredential", "external_credential", "envValue",
]);

// Supported domain identifiers. `adm`/`bbq`/`life`/`work` are the target
// companies of the 1.7 split (ADR-0052); `company`/`public_link` are the
// sharingScope boundary markers declared by the skills-domain attribution
// (OPE-12872 chain). Declared domain values outside this set are never
// copied verbatim: they collapse to unknown, so no arbitrary string — and
// therefore no sensitive value placed in a domain field — can reach a
// summary.
export const SUPPORTED_DOMAINS = new Set([
  "adm", "bbq", "company", "life", "public_link", "work",
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

// Inventory (dry-run probe) section id -> attribution section. The
// `attribution` report command consumes captured sections under these ids;
// sections without a mapping are not attributed and are ignored.
const ATTRIBUTION_SECTION_BY_INVENTORY_SECTION = new Map([
  ["agents", "agents"],
  ["issues", "issues"],
  ["projects", "projects-documents"],
  ["secretBindings", "secrets-bindings"],
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

// Allowlist gate: a declared domain survives only if it is one of the
// supported identifiers (already normalized to lowercase). Anything else
// returns null — the domain stays unknown instead of copying an arbitrary
// source string into the result.
function normalizeSupportedDomain(value) {
  if (!isKnownId(value)) return null;
  const normalized = value.trim().toLowerCase();
  return SUPPORTED_DOMAINS.has(normalized) ? normalized : null;
}

export function isSupportedDomain(value) {
  return normalizeSupportedDomain(value) !== null;
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

  // Domain attribution: declared domain fields only, gated by the supported
  // identifier allowlist. Without a declared, supported domain the result
  // stays unknown — no inference from names, ids or company membership, and
  // no verbatim copy of an arbitrary (potentially sensitive) declared value.
  const declared = declaredDomain(cleanRow);
  const domain = declared ? normalizeSupportedDomain(declared.domain) : null;

  return {
    section,
    entityId,
    owner,
    ownerKnown: Boolean(ownerField),
    ownerSource: ownerField ? ownerField.field : null,
    ownerRef,
    domain: domain ?? UNKNOWN_OWNER,
    domainSource: declared ? declared.source : null,
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
 * Deterministic attribution summary over attributed rows. Owners and domain
 * keys are sorted alphabetically; the summary carries ids/unknown markers,
 * allowlisted domain identifiers and counts only — never titles, names or
 * any sensitive row values.
 * @param {Array<ReturnType<typeof attributeOwnership>>} entries
 * @returns {{total: number, knownOwners: number, unknownOwners: number,
 *            owners: Array<{owner: string, known: boolean, count: number}>,
 *            domains: Record<string, number>}}
 */
export function summarizeAttribution(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const owners = countByOwner(list);
  const domainCounts = {};
  for (const entry of list) {
    domainCounts[entry.domain] = (domainCounts[entry.domain] ?? 0) + 1;
  }
  const domains = {};
  for (const key of Object.keys(domainCounts).sort()) {
    domains[key] = domainCounts[key];
  }
  return {
    total: list.length,
    knownOwners: list.filter((e) => e.ownerKnown).length,
    unknownOwners: list.filter((e) => !e.ownerKnown).length,
    owners,
    domains,
  };
}

/**
 * Attribute a captured inventory sections payload (the raw rows the read-only
 * dry-run probe fetched, keyed by inventory section id). Only array-valued
 * sections with a declared mapping are attributed; everything else —
 * summaries, non-arrays, unknown section ids — is ignored without invention.
 * The result is deterministic: sections in fixed declared order, summaries
 * sorted.
 * @param {Record<string, Array<object>>} sections
 * @returns {{sections: Record<string, ReturnType<typeof summarizeAttribution>>}}
 */
export function attributeInventoryReport(sections) {
  const attributed = {};
  const source = sections && typeof sections === "object" ? sections : {};
  for (const [inventoryId, attributionSection] of ATTRIBUTION_SECTION_BY_INVENTORY_SECTION) {
    const rows = source[inventoryId];
    if (!Array.isArray(rows)) continue;
    attributed[attributionSection] = summarizeAttribution(
      rows.map((row) => attributeOwnership(attributionSection, row)),
    );
  }
  return { sections: attributed };
}

export function buildAttributionReport(sections) {
  return {
    schema: ATTRIBUTION_REPORT_SCHEMA,
    mode: "dry-run-read-only",
    attribution: attributeInventoryReport(sections),
  };
}

// ---------------------------------------------------------------------------
// CLI: append the attribution summary to the dry-run inventory report
// ---------------------------------------------------------------------------

export class UsageError extends Error {}

function parseAttributionArgs(argv) {
  const args = { cmd: null, report: null, out: null };
  let i = 0;
  if (argv[i] === "attribution") {
    args.cmd = "attribution";
    i++;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") {
      args.report = argv[++i] ?? null;
    } else if (a === "--out") {
      args.out = argv[++i] ?? null;
    } else {
      throw new UsageError(`unexpected argument: ${a}`);
    }
  }
  return args;
}

function readSectionsPayload(reportFile) {
  const parsed = JSON.parse(readFileSync(reportFile, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && parsed.sections && typeof parsed.sections === "object"
    && !Array.isArray(parsed.sections)) {
    return parsed.sections;
  }
  return parsed;
}

export async function main(argv = []) {
  try {
    const args = parseAttributionArgs(argv);
    if (args.cmd !== "attribution") {
      throw new UsageError("usage: attribution --report <captured-sections.json> [--out <file>]");
    }
    if (typeof args.report !== "string" || args.report.length === 0) {
      throw new UsageError("missing required --report");
    }
    const report = buildAttributionReport(readSectionsPayload(args.report));
    const text = JSON.stringify(report, null, 2) + "\n";
    if (typeof args.out === "string" && args.out.length > 0) {
      writeFileSync(args.out, text);
    } else {
      process.stdout.write(text);
    }
    return EXIT_OK;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return EXIT_USAGE;
  }
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}

#!/usr/bin/env node
// Attributes company ownership for inventory records so a company-boundaries
// review can tell two situations apart:
//
//   1. "unknown/unresolved" — the record declares NO owner or dependency
//      fields, so cross-company attribution cannot even be attempted.
//   2. "no cross-company link" — owner/dependency fields are declared but
//      empty, which is positive evidence that no link exists.
//
// For records that do declare fields, the summary shows only their exact
// safe identifiers (UUIDs, integer ids, slug-shaped ids). Values that are
// not identifier-shaped, and any field whose name looks secret-shaped
// (token, secret, password, api key, credential, private key, bearer), are
// printed as <redacted> — a sensitive value is never echoed into the report.
//
// Usage:
//   node scripts/myrmidon/company-boundaries-inventory.mjs [--file <path>] [--json]
//
// Input is the JSON file given with --file, or stdin when no --file is
// passed. The inventory is an array of records or { "records": [...] }.
//
// Exit code: 0 every record resolved (attributed or declared-empty),
// 1 at least one record is unknown/unresolved, 2 usage/read/parse error
// (an inventory that was not read is an error, never a clean report).

import fs from "node:fs";

const USAGE = `usage: node scripts/myrmidon/company-boundaries-inventory.mjs [--file <path>] [--json]

Input: JSON array of records, or { "records": [...] }, from --file or stdin.
Output: one attribution line per record plus a count summary (--json emits
one machine-readable JSON object instead).
Exit code: 0 all records resolved, 1 any unknown/unresolved, 2 error.`;

const REDACTED = "<redacted>";

// Recognized attribution fields, matched on the lowercased name with "_"/"-"
// stripped: an owner/company/dependency prefix plus either an id-ish suffix
// or a bare attribution name ("dependsOn", "owner"). A prefixed name without
// an id suffix and without a bare attribution name (e.g. "companyStatus") is
// ordinary data, not attribution. Secret-shaped names (ownerToken) are
// recognized too — so they show up redacted instead of being silently
// dropped or, worse, printed.
const OWNER_PREFIX_RE =
  /^(owner|company|linkedcompany|parentcompany|dependson|dependency|crosscompany|sharedwith|assignee)/;
const ID_SUFFIX_RE = /(ids|id)$/;
const SECRET_NAME_RE =
  /(password|secret|token|apikey|credential|privatekey|bearer)/;
const BARE_OWNER_NAMES = new Set([
  "owner",
  "company",
  "linkedcompany",
  "parentcompany",
  "dependson",
  "dependency",
  "crosscompany",
  "sharedwith",
  "assignee",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Identifier-shaped token: starts alphanumeric, then alphanumerics, dots,
// colons and dashes only. Underscores, spaces, "@" and over-long strings are
// deliberately excluded, so secret shapes (pcp_invite_..., user@host) and
// free text never pass as identifiers.
const SLUG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,63}$/;

/** True when the field name is an owner/dependency attribution field. */
export function isOwnershipField(name) {
  const n = String(name).toLowerCase().replace(/[_-]/g, "");
  if (!OWNER_PREFIX_RE.test(n)) return false;
  if (SECRET_NAME_RE.test(n)) return true;
  return BARE_OWNER_NAMES.has(n) || ID_SUFFIX_RE.test(n);
}

/** True when a value is an exact, safe identifier that may be printed. */
export function isSafeId(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && Number.isSafeInteger(value) && value >= 0;
  }
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 64) return false;
  return UUID_RE.test(value) || SLUG_ID_RE.test(value);
}

function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.length === 0;
  return false;
}

/** Renders one scalar value for display; empty values render as null. */
function renderScalar(value) {
  if (isEmptyValue(value)) return null;
  if (isSafeId(value)) return String(value);
  return REDACTED;
}

/**
 * Renderable form of one field value; empty values render as null. Values
 * in secret-named fields are always redacted, and inside an id array even
 * an empty entry is not a declared id, so it is redacted rather than shown
 * as null: only declared identifiers may ever be printed.
 */
function displayValue(value, fieldName) {
  const secretNamed = SECRET_NAME_RE.test(
    String(fieldName).toLowerCase().replace(/[_-]/g, ""),
  );
  if (isEmptyValue(value)) return { value: null, redacted: false };
  if (Array.isArray(value)) {
    const parts = value.map((v) =>
      secretNamed ? REDACTED : isSafeId(v) ? String(v) : REDACTED,
    );
    return { value: parts, redacted: parts.some((p) => p === REDACTED) };
  }
  if (secretNamed) return { value: REDACTED, redacted: true };
  const rendered = renderScalar(value);
  return { value: rendered, redacted: rendered === REDACTED };
}

function recordOwnershipEntries(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return [];
  }
  return Object.keys(record)
    .filter((key) => isOwnershipField(key))
    .map((name) => ({ name, value: record[name] }));
}

/**
 * Attributes ownership for one inventory record. Returns
 * { attribution: "unknown" | "none" | "attributed", fields, summary }.
 * fields carry display-safe values only: safe identifiers verbatim,
 * everything else as <redacted>.
 */
export function attributeOwnership(record) {
  const entries = recordOwnershipEntries(record);
  if (entries.length === 0) {
    return {
      attribution: "unknown",
      fields: [],
      summary:
        "ownership unknown/unresolved: record declares no owner or dependency fields",
    };
  }
  const fields = entries.map(({ name, value }) => ({
    field: name,
    ...displayValue(value, name),
  }));
  const declaredNonEmpty = entries.filter((e) => !isEmptyValue(e.value));
  if (declaredNonEmpty.length === 0) {
    return {
      attribution: "none",
      fields,
      summary:
        "no cross-company link: owner/dependency fields declared but empty",
    };
  }
  const shown = fields
    .filter((f) => f.value !== null)
    .map((f) =>
      Array.isArray(f.value)
        ? `${f.field}=${JSON.stringify(f.value)}`
        : `${f.field}=${f.value}`,
    );
  return {
    attribution: "attributed",
    fields,
    summary: `owner attribution: ${shown.join(" ")}`,
  };
}

/**
 * Stable report label for a record: its own safe id when present,
 * otherwise its index (an unsafe id value is never printed).
 */
export function recordSubject(record, index) {
  if (
    record !== null &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    isSafeId(record.id)
  ) {
    return String(record.id);
  }
  return `#${index}`;
}

const readStdinSync = () => fs.readFileSync(0, "utf8");

function parseInventory(text) {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray(parsed.records)
  ) {
    return parsed.records;
  }
  throw new Error(
    "inventory must be an array of records or an object with a records array",
  );
}

/**
 * CLI entry point. Reads the inventory, prints one attribution line per
 * record (or one JSON object with --json) and returns the exit code
 * (0 all resolved, 1 any unknown/unresolved, 2 usage/read/parse error).
 */
export function main(
  argv = process.argv.slice(2),
  log = console,
  readStdin = readStdinSync,
) {
  let file = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--file") {
      file = argv[++i];
      if (!file) {
        log.error("--file requires a path");
        return 2;
      }
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      log.log(USAGE);
      return 0;
    } else {
      log.error(`unknown argument: ${arg}`);
      return 2;
    }
  }

  let text;
  try {
    text = file ? fs.readFileSync(file, "utf8") : readStdin();
  } catch (err) {
    log.error(`Cannot read input: ${err.code ?? "read error"}`);
    return 2;
  }

  let records;
  try {
    records = parseInventory(text);
  } catch (err) {
    // Error text is reported without the offending input so a malformed
    // inventory never leaks its content into the log.
    log.error(
      err instanceof SyntaxError
        ? "Invalid inventory JSON"
        : `Invalid inventory: ${err.message}`,
    );
    return 2;
  }

  const results = records.map((record, index) => ({
    subject: recordSubject(record, index),
    ...attributeOwnership(record),
  }));
  const counts = { attributed: 0, none: 0, unknown: 0 };
  for (const result of results) counts[result.attribution] += 1;

  if (json) {
    log.log(JSON.stringify({ records: results, counts }));
  } else {
    for (const result of results) {
      log.log(`[${result.subject}] ${result.summary}`);
    }
    log.log(
      `${records.length} record(s): ${counts.attributed} attributed, ` +
        `${counts.none} none, ${counts.unknown} unknown`,
    );
  }
  return counts.unknown > 0 ? 1 : 0;
}

if (typeof process !== "undefined" && process.argv[1]) {
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = main();
  }
}

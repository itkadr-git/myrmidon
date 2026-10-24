// myrmidon(OPE-8950): pure helpers for the per-area fork catalogs
// (conflict and parity checks). Used by the catalog guard tests.
import { parseForkCatalogPath } from "./myrmidon-i18n";

export type Catalog = Record<string, unknown>;

export const PLURAL_FORMS = ["zero", "one", "two", "few", "many", "other"] as const;
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function isPlainObject(value: unknown): value is Catalog {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Flatten a nested catalog into dotted leaf keys -> string value. */
export function flattenCatalog(catalog: Catalog, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      for (const [k, v] of flattenCatalog(value, path)) out.set(k, v);
    } else {
      out.set(path, String(value));
    }
  }
  return out;
}

/**
 * Conflicts between files of the same locale: a leaf defined twice, or a
 * string in one file where another file has an object (or the reverse).
 */
export function findKeyConflicts(files: Record<string, Catalog>): string[] {
  const conflicts: string[] = [];
  const leaves = new Map<string, string>(); // locale:key -> file
  const objects = new Map<string, string>(); // locale:prefix -> file that nests under it
  for (const [path, catalog] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const parsed = parseForkCatalogPath(path);
    if (!parsed) continue;
    for (const key of flattenCatalog(catalog).keys()) {
      const id = `${parsed.locale}:${key}`;
      const owner = leaves.get(id);
      if (owner) conflicts.push(`${id} defined in ${owner} and ${path}`);
      else leaves.set(id, path);
      const parts = key.split(".");
      for (let i = 1; i < parts.length; i++) {
        const prefixId = `${parsed.locale}:${parts.slice(0, i).join(".")}`;
        if (!objects.has(prefixId)) objects.set(prefixId, path);
      }
    }
  }
  for (const [id, file] of leaves) {
    const nested = objects.get(id);
    if (nested) conflicts.push(`${id} is a string in ${file} and an object in ${nested}`);
  }
  return conflicts;
}

/** Group keys: `n_one`, `n_other`… with at least two forms fold into `n`. */
function groupKeys(flat: Map<string, string>): Map<string, { forms: Set<string>; values: string[] }> {
  const counts = new Map<string, number>();
  for (const key of flat.keys()) {
    const m = key.match(PLURAL_SUFFIX);
    if (m) counts.set(key.slice(0, -m[0].length), (counts.get(key.slice(0, -m[0].length)) ?? 0) + 1);
  }
  const groups = new Map<string, { forms: Set<string>; values: string[] }>();
  for (const [key, value] of flat) {
    const m = key.match(PLURAL_SUFFIX);
    const base = m ? key.slice(0, -m[0].length) : key;
    const isPlural = Boolean(m) && (counts.get(base) ?? 0) >= 2;
    const id = isPlural ? base : key;
    const group = groups.get(id) ?? { forms: new Set<string>(), values: [] };
    if (isPlural && m) group.forms.add(m[1]);
    group.values.push(value);
    groups.set(id, group);
  }
  return groups;
}

const REQUIRED_FORMS: Record<string, readonly string[]> = {
  en: ["one", "other"],
  ru: ["one", "few", "many", "other"],
};

const placeholders = (values: string[]) =>
  [...new Set(values.flatMap((v) => [...v.matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1])))].sort().join(",");

/**
 * Parity problems between the en and ru catalogs of one area. Plural groups
 * (two or more suffixed forms) need the full form set of the language:
 * en _one + _other, ru _one _few _many _other. Placeholders are compared per
 * group (union over its forms).
 */
export function findAreaParityProblems(en: Catalog, ru: Catalog): string[] {
  const problems: string[] = [];
  const enGroups = groupKeys(flattenCatalog(en));
  const ruGroups = groupKeys(flattenCatalog(ru));
  for (const [lang, groups, other] of [
    ["en", enGroups, ruGroups],
    ["ru", ruGroups, enGroups],
  ] as const) {
    for (const [id, group] of groups) {
      const otherLang = lang === "en" ? "ru" : "en";
      if (!other.has(id)) problems.push(`missing in ${otherLang}: ${id}`);
      if (group.forms.size > 0) {
        const missing = REQUIRED_FORMS[lang].filter((form) => !group.forms.has(form));
        if (missing.length) problems.push(`${lang} plural ${id} lacks forms: ${missing.join(", ")}`);
      }
    }
  }
  for (const [id, enGroup] of enGroups) {
    const ruGroup = ruGroups.get(id);
    if (!ruGroup) continue;
    if ((enGroup.forms.size > 0) !== (ruGroup.forms.size > 0)) problems.push(`plural in only one language: ${id}`);
    if (placeholders(enGroup.values) !== placeholders(ruGroup.values)) problems.push(`placeholders differ: ${id}`);
  }
  return problems;
}

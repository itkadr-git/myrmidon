// User-provided catalogs are restricted to the built-in UI key shape.
import { en } from "./catalogs/en";

export type CatalogEntry = string | { [key: string]: CatalogEntry };
export type CatalogObject = { [key: string]: CatalogEntry };

export interface CatalogValidation {
  catalog: CatalogObject | null;
  missingKeys: string[];
  unknownKeys: string[];
  invalidValues: string[];
  parseError: boolean;
  valid: boolean;
}

const baseCatalog = en as unknown as CatalogObject;
const MAX_CATALOG_BYTES = 256 * 1024;

function flatten(value: CatalogObject, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") result.set(path, child);
    else if (child && typeof child === "object" && !Array.isArray(child)) {
      for (const [nestedKey, nestedValue] of flatten(child, path)) result.set(nestedKey, nestedValue);
    }
  }
  return result;
}

function isRecord(value: unknown): value is CatalogObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateCatalogJson(source: string): CatalogValidation {
  const byteLength = new TextEncoder().encode(source).byteLength;
  if (byteLength > MAX_CATALOG_BYTES) {
    return { catalog: null, missingKeys: [], unknownKeys: [], invalidValues: [], parseError: true, valid: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { catalog: null, missingKeys: [], unknownKeys: [], invalidValues: [], parseError: true, valid: false };
  }
  if (!isRecord(parsed)) {
    return { catalog: null, missingKeys: [], unknownKeys: [], invalidValues: [], parseError: true, valid: false };
  }

  if (Object.keys(parsed).some((key) => ["__proto__", "constructor", "prototype"].includes(key))) {
    return { catalog: null, missingKeys: [], unknownKeys: [], invalidValues: [], parseError: true, valid: false };
  }
  const base = flatten(baseCatalog);
  const uploaded = flatten(parsed);
  const missingKeys = [...base.keys()].filter((key) => !uploaded.has(key)).sort();
  const unknownKeys = [...uploaded.keys()].filter((key) => !base.has(key)).sort();
  const invalidValues = [...uploaded].flatMap(([key, value]) => {
    const template = base.get(key);
    if (template === undefined) return [];
    const expected = [...template.matchAll(/{{\s*(\w+)\s*}}/g)].map((match) => match[1]).sort();
    const actual = [...value.matchAll(/{{\s*(\w+)\s*}}/g)].map((match) => match[1]).sort();
    return expected.join("\u0000") === actual.join("\u0000") ? [] : [key];
  }).sort();
  const valid = missingKeys.length === 0 && unknownKeys.length === 0 && invalidValues.length === 0;
  return { catalog: parsed, missingKeys, unknownKeys, invalidValues, parseError: false, valid };
}

export function previewCatalogText(source: string, limit = 8): string[] {
  const result = validateCatalogJson(source);
  if (!result.catalog) return [];
  return [...flatten(result.catalog)].slice(0, limit).map(([key, value]) => `${key}: ${value}`);
}

/** Merge a complete uploaded locale into a fresh base tree without mutating imports. */
export function mergeCatalog(base: CatalogObject, uploaded: CatalogObject): CatalogObject {
  const merged: CatalogObject = {};
  for (const [key, baseValue] of Object.entries(base)) {
    const uploadedValue = uploaded[key];
    if (typeof baseValue === "string") {
      merged[key] = typeof uploadedValue === "string" ? uploadedValue : baseValue;
    } else {
      merged[key] = mergeCatalog(baseValue as CatalogObject, (uploadedValue as CatalogObject | undefined) ?? {});
    }
  }
  return merged;
}

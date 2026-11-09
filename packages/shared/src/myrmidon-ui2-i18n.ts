// myrmidon(UI2-I18N): shared contract for the per-user board UI language
// preference (2.0 UI tree). The languages the fork ships UI catalogs for;
// English is the base and fallback. Agent-authored content (comments, run
// output) is never translated, and identifiers stay untranslated — this
// setting only selects the catalog the interface chrome renders from.
import { z } from "zod";
import ui2EnReference from "./locales/ui2-en-reference.json" with { type: "json" };

export { ui2EnReference };

export const UI2_LANGUAGES = ["en", "ru"] as const;
export type Ui2Language = (typeof UI2_LANGUAGES)[number];

export type Ui2CustomCatalogs = Partial<Record<Ui2Language, Record<string, unknown>>>;

export const ui2LanguageSchema = z.enum(UI2_LANGUAGES);
export const upsertUi2LanguageSchema = z.object({
  language: ui2LanguageSchema,
});

export function containsUnsafeKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsUnsafeKeys);
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) return true;
    if (containsUnsafeKeys(child)) return true;
  }
  return false;
}

export function flattenUi2Catalog(
  obj: Record<string, unknown>,
  prefix = ""
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      map.set(fullKey, value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [childKey, childValue] of flattenUi2Catalog(value as Record<string, unknown>, fullKey)) {
        map.set(childKey, childValue);
      }
    }
  }
  return map;
}

export interface Ui2CatalogValidationResult {
  valid: boolean;
  missingKeys: string[];
  unknownKeys: string[];
  invalidValues: string[];
  errors: string[];
}

export function validateUi2Catalog(
  candidate: unknown,
  baseCatalog: Record<string, unknown> = ui2EnReference
): Ui2CatalogValidationResult {
  const errors: string[] = [];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {
      valid: false,
      missingKeys: [],
      unknownKeys: [],
      invalidValues: [],
      errors: ["Catalog must be a JSON object"],
    };
  }

  if (containsUnsafeKeys(candidate)) {
    return {
      valid: false,
      missingKeys: [],
      unknownKeys: [],
      invalidValues: [],
      errors: ["Catalog contains unsafe keys"],
    };
  }

  const serialized = JSON.stringify(candidate);
  if (serialized.length > 256 * 1024) {
    return {
      valid: false,
      missingKeys: [],
      unknownKeys: [],
      invalidValues: [],
      errors: ["Catalog exceeds 256 KiB"],
    };
  }

  const base = flattenUi2Catalog(baseCatalog);
  const uploaded = flattenUi2Catalog(candidate as Record<string, unknown>);

  const missingKeys = [...base.keys()].filter((key) => !uploaded.has(key)).sort();
  const unknownKeys = [...uploaded.keys()].filter((key) => !base.has(key)).sort();
  const invalidValues = [...uploaded]
    .flatMap(([key, value]) => {
      const template = base.get(key);
      if (template === undefined) return [];
      const expected = [...template.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();
      const actual = [...value.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();
      return expected.join("\u0000") === actual.join("\u0000") ? [] : [key];
    })
    .sort();

  if (missingKeys.length > 0) {
    errors.push(`Missing required catalog keys: ${missingKeys.slice(0, 5).join(", ")}${missingKeys.length > 5 ? ` (+${missingKeys.length - 5} more)` : ""}`);
  }
  if (unknownKeys.length > 0) {
    errors.push(`Unknown catalog keys: ${unknownKeys.slice(0, 5).join(", ")}${unknownKeys.length > 5 ? ` (+${unknownKeys.length - 5} more)` : ""}`);
  }
  if (invalidValues.length > 0) {
    errors.push(`Placeholder mismatches in keys: ${invalidValues.slice(0, 5).join(", ")}${invalidValues.length > 5 ? ` (+${invalidValues.length - 5} more)` : ""}`);
  }

  const valid = missingKeys.length === 0 && unknownKeys.length === 0 && invalidValues.length === 0 && errors.length === 0;

  return {
    valid,
    missingKeys,
    unknownKeys,
    invalidValues,
    errors,
  };
}

export const ui2CatalogSchema = z
  .record(z.string().min(1).max(160), z.unknown())
  .refine(
    (catalog: Record<string, unknown>) => JSON.stringify(catalog).length <= 256 * 1024,
    "Catalog exceeds 256 KiB"
  )
  .refine(
    (catalog: Record<string, unknown>) => !containsUnsafeKeys(catalog),
    "Unsafe catalog key"
  )
  .refine(
    (catalog: Record<string, unknown>) => validateUi2Catalog(catalog).valid,
    "Invalid catalog structure or placeholder mismatch"
  );

export const upsertUi2CatalogSchema = z.object({
  language: ui2LanguageSchema,
  catalog: ui2CatalogSchema,
});

export type UpsertUi2Language = z.infer<typeof upsertUi2LanguageSchema>;

export interface Ui2LanguagePreference {
  language: Ui2Language;
  updatedAt: Date | null;
}

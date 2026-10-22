// myrmidon(UI2-I18N): shared contract for the per-user board UI language
// preference (2.0 UI tree). The languages the fork ships UI catalogs for;
// English is the base and fallback. Agent-authored content (comments, run
// output) is never translated, and identifiers stay untranslated — this
// setting only selects the catalog the interface chrome renders from.
import { z } from "zod";

export const UI2_LANGUAGES = ["en", "ru"] as const;
export type Ui2Language = (typeof UI2_LANGUAGES)[number];

export const ui2LanguageSchema = z.enum(UI2_LANGUAGES);
export const upsertUi2LanguageSchema = z.object({
  language: ui2LanguageSchema,
});

const ui2CatalogValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.record(z.string().min(1).max(160), ui2CatalogValueSchema),
  ]),
);

export const ui2CatalogSchema = z.record(z.string().min(1).max(160), ui2CatalogValueSchema)
  .refine((catalog: Record<string, unknown>) => JSON.stringify(catalog).length <= 256 * 1024, "Catalog exceeds 256 KiB")
  .refine((catalog: Record<string, unknown>) => !containsUnsafeKeys(catalog), "Unsafe catalog key");

function containsUnsafeKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUnsafeKeys);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    ["__proto__", "constructor", "prototype"].includes(key) || containsUnsafeKeys(child),
  );
}
export const upsertUi2CatalogSchema = z.object({
  language: ui2LanguageSchema,
  catalog: ui2CatalogSchema,
});

export type Ui2CustomCatalogs = Partial<Record<Ui2Language, Record<string, unknown>>>;

export type UpsertUi2Language = z.infer<typeof upsertUi2LanguageSchema>;

export interface Ui2LanguagePreference {
  language: Ui2Language;
  updatedAt: Date | null;
}

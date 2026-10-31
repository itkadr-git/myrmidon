// myrmidon(1.7 LOCALE-UPLOAD): locale upload types and re-exports
import { z } from \"zod\";

export * from \"./locale-validator.js\";

export const CUSTOM_LOCALES_SETTINGS_KEY = \"customLocales\";

export const storedCustomLocaleSchema = z.object({
  locale: z.string(),
  version: z.number(),
  uploadedAt: z.string(),
  uploadedBy: z.string().nullable().optional(),
  keyCount: z.number(),
  checksum: z.string(),
  catalog: z.record(z.string(), z.unknown()),
});

export type StoredCustomLocale = z.infer<typeof storedCustomLocaleSchema>;

export const storedCustomLocaleSummarySchema = z.object({
  locale: z.string(),
  version: z.number(),
  uploadedAt: z.string(),
  uploadedBy: z.string().nullable().optional(),
  keyCount: z.number(),
  checksum: z.string(),
});

export type StoredCustomLocaleSummary = z.infer<typeof storedCustomLocaleSummarySchema>;

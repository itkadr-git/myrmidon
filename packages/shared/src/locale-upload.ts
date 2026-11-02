// myrmidon(1.7 LOCALE-UPLOAD): locale upload types and persistence contracts
import { z } from "zod";

export const CUSTOM_LOCALES_SETTINGS_KEY = "customLocales";

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

export const uploadLocaleBodySchema = z.object({
  locale: z.string().min(2).max(35).regex(/^[a-zA-Z0-9_-]+$/),
  catalog: z.record(z.string(), z.unknown()).optional(),
  dryRun: z.boolean().optional(),
  strict: z.boolean().optional(),
});

export type UploadLocaleBody = z.infer<typeof uploadLocaleBodySchema>;

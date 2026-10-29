import { z } from \"zod\";

export const CUSTOM_LOCALES_SETTINGS_KEY = \"customLocales\";

export const localeKeyDiffReportSchema = z.object({
  totalBaseKeys: z.number(),
  totalCandidateKeys: z.number(),
  matchedCount: z.number(),
  missingCount: z.number(),
  extraCount: z.number(),
  coveragePercent: z.number(),
  matchedKeys: z.array(z.string()),
  missingKeys: z.array(z.string()),
  extraKeys: z.array(z.string()),
  newKeys: z.array(z.string()),
});

export type LocaleKeyDiffReport = z.infer<typeof localeKeyDiffReportSchema>;

export const localeValidationErrorCodeSchema = z.enum([
  \"INVALID_ROOT\",
  \"INVALID_TYPE\",
  \"DISALLOWED_PAYLOAD\",
  \"PLACEHOLDER_MISMATCH\",
  \"STRING_TOO_LONG\",
  \"EMPTY_KEY\",
  \"PARSE_ERROR\",
]);

export type LocaleValidationErrorCode = z.infer<typeof localeValidationErrorCodeSchema>;

export const localeValidationErrorSchema = z.object({
  path: z.string(),
  code: localeValidationErrorCodeSchema,
  message: z.string(),
});

export type LocaleValidationError = z.infer<typeof localeValidationErrorSchema>;

export const localeValidationResultSchema = z.object({
  valid: z.boolean(),
  targetLocale: z.string(),
  baseLocale: z.string(),
  report: localeKeyDiffReportSchema,
  errors: z.array(localeValidationErrorSchema),
  warnings: z.array(z.string()),
});

export type LocaleValidationResult = z.infer<typeof localeValidationResultSchema>;

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

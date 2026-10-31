import { z } from "zod";

export const installedLocaleTypeSchema = z.enum(["all", "builtin", "custom"]);
export type InstalledLocaleType = z.infer<typeof installedLocaleTypeSchema>;

export const installedLocalesQuerySchema = z.object({
  type: installedLocaleTypeSchema.optional().default("all"),
  minCoverage: z.coerce.number().min(0).max(100).optional(),
  search: z.string().trim().max(100).optional(),
});
export type InstalledLocalesQuery = z.infer<typeof installedLocalesQuerySchema>;

export const installedLocaleSummarySchema = z.object({
  locale: z.string().min(2).max(35),
  name: z.string(),
  isBuiltin: z.boolean(),
  isDefault: z.boolean(),
  version: z.number().int().positive().nullable(),
  totalKeys: z.number().int().nonnegative(),
  matchedKeysCount: z.number().int().nonnegative(),
  missingKeysCount: z.number().int().nonnegative(),
  extraKeysCount: z.number().int().nonnegative(),
  coveragePercent: z.number().min(0).max(100),
  updatedAt: z.string().nullable(),
});
export type InstalledLocaleSummary = z.infer<typeof installedLocaleSummarySchema>;

export const installedLocalesResponseSchema = z.object({
  baseLocale: z.string(),
  totalBaseKeys: z.number().int().nonnegative(),
  locales: z.array(installedLocaleSummarySchema),
  total: z.number().int().nonnegative(),
});
export type InstalledLocalesResponse = z.infer<typeof installedLocalesResponseSchema>;

export const localeCoverageDetailSchema = z.object({
  locale: z.string().min(2).max(35),
  name: z.string(),
  baseLocale: z.string(),
  isBuiltin: z.boolean(),
  isDefault: z.boolean(),
  version: z.number().int().positive().nullable(),
  totalKeys: z.number().int().nonnegative(),
  matchedKeysCount: z.number().int().nonnegative(),
  missingKeysCount: z.number().int().nonnegative(),
  extraKeysCount: z.number().int().nonnegative(),
  coveragePercent: z.number().min(0).max(100),
  missingKeys: z.array(z.string()),
  extraKeys: z.array(z.string()),
  matchedKeys: z.array(z.string()).optional(),
  updatedAt: z.string().nullable(),
});
export type LocaleCoverageDetail = z.infer<typeof localeCoverageDetailSchema>;

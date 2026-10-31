import { z } from \"zod\";

export const geoCheckOptionsSchema = z.object({
  pgHost: z.string().min(1).default(\"127.0.0.1\"),
  pgPort: z.coerce.number().int().min(1).max(65535).default(5432),
  litellmHost: z.string().min(1).default(\"127.0.0.1\"),
  litellmPort: z.coerce.number().int().min(1).max(65535).default(4000),
  secrets: z.string().default(\"DATABASE_URL,LITELLM_MASTER_KEY,LITELLM_API_KEY\"),
  mirrorConfig: z.string().optional(),
  minOsMajor: z.coerce.number().int().min(1).default(22),
  minDockerMajor: z.coerce.number().int().min(1).default(24),
  minPgMajor: z.coerce.number().int().min(1).default(14),
  timeoutMs: z.coerce.number().int().min(100).max(60000).default(2000),
  json: z.boolean().default(false),
  config: z.string().optional(),
  dataDir: z.string().optional(),
  apiUrl: z.string().url().optional(),
});

export type GeoCheckOptions = z.infer<typeof geoCheckOptionsSchema>;
export type GeoCheckInput = z.input<typeof geoCheckOptionsSchema>;

export const geoCheckItemStatusSchema = z.enum([\"pass\", \"fail\"]);
export type GeoCheckItemStatus = z.infer<typeof geoCheckItemStatusSchema>;

export const geoCheckItemSchema = z.object({
  name: z.string(),
  status: geoCheckItemStatusSchema,
  detail: z.string(),
});
export type GeoCheckItem = z.infer<typeof geoCheckItemSchema>;

export const geoCheckReportSchema = z.object({
  passed: z.boolean(),
  totalChecks: z.number().int().nonnegative(),
  passedChecks: z.number().int().nonnegative(),
  failedChecks: z.number().int().nonnegative(),
  checks: z.array(geoCheckItemSchema),
});
export type GeoCheckReport = z.infer<typeof geoCheckReportSchema>;

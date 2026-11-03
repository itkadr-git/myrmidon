import { z } from "zod";

import { validateProviderUsageWarningThresholdSchema } from "./provider-usage-settings.js";

const usageValuesSchema = z.object({
  requests: z.number().finite().nonnegative().optional(),
  tokens: z.number().finite().nonnegative().optional(),
}).strict();

export const createProviderUsageReportedEventSchema = z.object({
  schemaVersion: z.literal(1),
  companyId: z.string().uuid(),
  eventId: z.string().min(1).max(200),
  ownerIssueId: z.string().min(1).max(200).optional(),
  provider: z.string().min(1).max(100),
  credentialRef: z.string().min(1).max(200),
  observedAt: z.string().datetime(),
  window: z.object({
    kind: z.enum(["package", "rolling_5h", "rolling_7d"]),
    startedAt: z.string().datetime(),
    resetsAt: z.string().datetime(),
    used: usageValuesSchema,
    limit: usageValuesSchema,
  }).strict(),
}).strict();

export { updateProviderUsageWarningThresholdSchema } from "./provider-usage-settings.js";
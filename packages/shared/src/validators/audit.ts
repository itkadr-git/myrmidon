import { z } from "zod";

export const auditQuerySchema = z.object({
  userId: z.string().optional(),
  target: z.string().optional(),
  targetUserId: z.string().optional(),
  actorId: z.string().optional(),
  actor: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const queryAuditSchema = auditQuerySchema;

export type AuditQuery = z.infer<typeof auditQuerySchema>;
export type AuditQueryInput = AuditQuery;
export type QueryAudit = AuditQuery;
export type QueryAuditPayload = AuditQuery;

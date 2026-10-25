import { createHash } from "node:crypto";
import { z } from "zod";
import { ISSUE_RECOVERY_ACTION_KINDS } from "./constants.js";

const recoveryFactoryOwnerSchema = z.union([
  z.object({ agentId: z.string().min(1) }).strict(),
  z.object({ userId: z.string().min(1) }).strict(),
  z.object({ serviceQueue: z.string().min(1) }).strict(),
]);

export const recoveryFactoryRequestSchema = z.object({
  kind: z.enum(ISSUE_RECOVERY_ACTION_KINDS),
  sourceIssueId: z.string().min(1),
  dedupeKey: z.string().min(1),
  owner: recoveryFactoryOwnerSchema,
  slaMinutes: z.number().int().positive(),
  nextCheckAt: z.string().datetime({ offset: true }),
  runbookRef: z.string().min(1).optional(),
  evidence: z.record(z.string(), z.unknown()),
}).strict();

export type RecoveryFactoryRequest = z.infer<typeof recoveryFactoryRequestSchema>;

export interface RecoveryFactoryResult {
  outcome: "created" | "deduped";
  recoveryActionId: string;
  recoveryIssueId: string | null;
}

export interface RecoveryFactoryMetrics {
  created(kind: RecoveryFactoryRequest["kind"]): void;
  deduped(kind: RecoveryFactoryRequest["kind"]): void;
  succeeded(kind: RecoveryFactoryRequest["kind"]): void;
  age(kind: RecoveryFactoryRequest["kind"], seconds: number): void;
}

export function buildRecoveryDedupeKey(input: {
  kind: RecoveryFactoryRequest["kind"];
  scope: string;
  cause: string;
}): string {
  const canonical = JSON.stringify([input.kind, input.scope, input.cause]);
  return createHash("sha256").update(canonical).digest("hex");
}

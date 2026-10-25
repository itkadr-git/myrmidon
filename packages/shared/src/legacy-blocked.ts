import { createHash } from "node:crypto";
import { z } from "zod";

export const LEGACY_BLOCKED_IMPORT_RULE_VERSION = "1";

export const legacyBlockedClassSchema = z.enum([
  "dependency",
  "recovery",
  "human_decision",
  "external_wait",
  "resource",
  "terminal",
  "unknown",
]);

const legacyBlockedEvidenceSchema = z.string().trim().min(1).max(2000);

export const legacyBlockedReportRowSchema = z.discriminatedUnion("class", [
  z.object({
    issueId: z.string().uuid(),
    identifier: z.string().trim().min(1),
    oldStatus: z.string().trim().min(1),
    oldBlockers: z.array(z.string()),
    class: z.literal("unknown"),
    proposedOwner: z.string().trim().min(1).optional(),
    proposedSlaMinutes: z.number().int().positive().optional(),
    evidence: legacyBlockedEvidenceSchema,
    importKey: z.string().trim().min(1),
  }).strict(),
  ...(["dependency", "recovery", "human_decision", "external_wait", "resource", "terminal"] as const).map(
    (blockClass) => z.object({
      issueId: z.string().uuid(),
      identifier: z.string().trim().min(1),
      oldStatus: z.string().trim().min(1),
      oldBlockers: z.array(z.string()),
      class: z.literal(blockClass),
      proposedOwner: z.string().trim().min(1),
      proposedSlaMinutes: z.number().int().positive().optional(),
      evidence: legacyBlockedEvidenceSchema,
      importKey: z.string().trim().min(1),
    }).strict(),
  ),
]);

export type LegacyBlockedClass = z.infer<typeof legacyBlockedClassSchema>;
export type LegacyBlockedReportRow = z.infer<typeof legacyBlockedReportRowSchema>;

export function createLegacyBlockedImportKey(issueId: string): string {
  const digest = createHash("sha256")
    .update(`${LEGACY_BLOCKED_IMPORT_RULE_VERSION}:${issueId}`)
    .digest("hex");
  return `legacy-blocked:v${LEGACY_BLOCKED_IMPORT_RULE_VERSION}:${digest}`;
}


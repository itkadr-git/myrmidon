import { z } from "zod";

/** Default duplicate suppression interval for recovery journal entries. */
export const AGENT_RECOVERY_JOURNAL_DEDUP_WINDOW_MS = 15 * 60_000;
/** Default age after which recovery journal entries may be removed. */
export const AGENT_RECOVERY_JOURNAL_RETENTION_DAYS = 30;

export const AGENT_RECOVERY_JOURNAL_STEPS = [
  "probe",
  "queue_without_run",
  "retry",
  "resurrection",
  "ladder",
] as const;
export type AgentRecoveryJournalStep = (typeof AGENT_RECOVERY_JOURNAL_STEPS)[number] | (string & {});

export interface AgentRecoveryJournalEntry {
  id: string;
  companyId: string;
  agentId: string;
  step: AgentRecoveryJournalStep;
  cause: string;
  dedupKey: string;
  payload: Record<string, unknown>;
  createdAt: string | Date;
  suppressedReason: "exclusion_window" | string | null;
}

export interface AgentRecoveryJournalExclusionWindow {
  startAt: string | Date;
  endAt: string | Date;
}

export interface AppendAgentRecoveryJournalInput {
  companyId: string;
  agentId: string;
  step: AgentRecoveryJournalStep;
  cause: string;
  dedupKey: string;
  payload?: Record<string, unknown>;
  at?: Date;
  exclusionWindows?: AgentRecoveryJournalExclusionWindow[];
}

export const recoveryJournalQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(),
});

/** Stable key format shared by producers and consumers. */
export function agentRecoveryJournalDedupKey(parts: {
  agentId: string;
  step: string;
  cause: string;
  window?: string;
}): string {
  return ["agent-recovery", parts.agentId, parts.step, parts.cause, parts.window ?? "default"].join(":");
}

export function isWithinAgentRecoveryExclusionWindow(
  at: Date,
  windows: AgentRecoveryJournalExclusionWindow[],
): boolean {
  const timestamp = at.getTime();
  return windows.some((window) => {
    const start = new Date(window.startAt).getTime();
    const end = new Date(window.endAt).getTime();
    return Number.isFinite(start) && Number.isFinite(end) && start <= timestamp && timestamp < end;
  });
}

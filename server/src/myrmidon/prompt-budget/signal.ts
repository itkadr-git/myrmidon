// server/src/myrmidon/prompt-budget/signal.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET B): the system-notice comment of an
// over-threshold agent.
//
// One comment per agent per window (UTC day), written into the agent's most
// recent in_progress task — the same seam the wip-limit signal uses. The
// dedup key `prompt-budget:<agentId>:<utc day>` rides in the comment
// metadata's first section row, so the check is a single indexed read.
//
// The write is best-effort: a failed signal is logged and swallowed, because
// the sweep that calls it must never break on a comment race.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues } from "@paperclipai/db";
import {
  promptBudgetSignalKey,
  topPromptBudgetParts,
  type IssueCommentMetadata,
  type IssueCommentPresentation,
  type PromptBudgetAgentStatus,
} from "@paperclipai/shared";

/** The signal window: one UTC day. */
export const PROMPT_BUDGET_SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Ports so tests can stub the comment service boundary. */
export interface PromptBudgetSignalPorts {
  addComment(
    issueId: string,
    body: string,
    actor: Record<string, never>,
    options: {
      authorType: "system";
      presentation: IssueCommentPresentation;
      metadata: IssueCommentMetadata;
    },
  ): Promise<unknown>;
  now(): Date;
}

function buildBody(status: PromptBudgetAgentStatus, agentName: string | null): string {
  const run = status.lastRun!;
  const label = agentName ?? "This agent";
  const threshold = run.level === "crit" ? status.settings.critPct : status.settings.warnPct;
  const lines = [
    `${label}'s last run used ${run.pct}% of its prompt window (${run.total} of ${status.windowTokens} tokens) — over the ${run.level} threshold of ${threshold}%.`,
    "",
  ];
  const top = topPromptBudgetParts(run.parts, 3);
  if (top.length > 0) {
    lines.push("Biggest prompt parts:");
    for (const part of top) lines.push(`- ${part.name}: ${part.tokens} tokens`);
    lines.push("");
  }
  lines.push(
    "To resolve: trim the biggest parts (session history, wake payload, instructions) or raise the thresholds on the instance settings page. The signal repeats at most once a day while the state holds.",
  );
  return lines.join("\n");
}

function buildPresentation(level: "warn" | "crit"): IssueCommentPresentation {
  return {
    kind: "system_notice",
    tone: level === "crit" ? "danger" : "warning",
    title: "Prompt budget threshold crossed",
    detailsDefaultOpen: true,
  };
}

function buildMetadata(
  status: PromptBudgetAgentStatus,
  windowStart: Date,
  issueId: string,
): IssueCommentMetadata {
  const run = status.lastRun!;
  return {
    version: 1,
    sections: [
      {
        title: "Prompt budget signal",
        rows: [
          {
            type: "key_value",
            label: "Signal key",
            value: promptBudgetSignalKey(status.agentId, windowStart),
          },
          { type: "key_value", label: "Agent", value: status.agentId },
          { type: "key_value", label: "Run", value: run.runId ?? "unknown" },
          { type: "key_value", label: "Prompt tokens", value: String(run.total) },
          { type: "key_value", label: "Window tokens", value: String(status.windowTokens) },
          { type: "key_value", label: "Share", value: `${run.pct}%` },
          { type: "key_value", label: "Level", value: run.level },
          { type: "key_value", label: "Issue", value: issueId },
        ],
      },
    ],
  };
}

/** The agent's most recent in_progress task (visible rows only). */
export async function latestInProgressIssue(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<{ id: string; identifier: string | null } | null> {
  const rows = await db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        eq(issues.status, "in_progress"),
        sql`${issues.hiddenAt} is null`,
      ),
    )
    .orderBy(desc(issues.updatedAt), desc(issues.id))
    .limit(1);
  return rows[0] ?? null;
}

/** True when the agent already has this window's signal comment anywhere. */
export async function hasPromptBudgetSignalComment(
  db: Db,
  companyId: string,
  agentId: string,
  windowStart: Date,
): Promise<boolean> {
  const key = promptBudgetSignalKey(agentId, windowStart);
  const existing = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.authorType, "system"),
        sql`${issueComments.metadata} -> 'sections' -> 0 -> 'rows' -> 0 ->> 'value' = ${key}`,
      ),
    )
    .limit(1);
  return Boolean(existing[0]);
}

/**
 * Deliver the signal for one over-threshold agent: one comment on its latest
 * in_progress task. Never throws — the sweep logs and moves on.
 */
export async function deliverPromptBudgetSignal(
  db: Db,
  ports: PromptBudgetSignalPorts,
  input: {
    companyId: string;
    status: PromptBudgetAgentStatus;
    agentName: string | null;
  },
): Promise<{ written: boolean; issueId: string | null }> {
  const now = ports.now();
  const windowStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  try {
    if (
      await hasPromptBudgetSignalComment(db, input.companyId, input.status.agentId, windowStart)
    ) {
      return { written: false, issueId: null };
    }
    const issue = await latestInProgressIssue(db, input.companyId, input.status.agentId);
    if (!issue) return { written: false, issueId: null };
    await ports.addComment(
      issue.id,
      buildBody(input.status, input.agentName),
      {} as Record<string, never>,
      {
        authorType: "system",
        presentation: buildPresentation(input.status.lastRun!.level as "warn" | "crit"),
        metadata: buildMetadata(input.status, windowStart, issue.id),
      },
    );
    return { written: true, issueId: issue.id };
  } catch {
    return { written: false, issueId: null };
  }
}

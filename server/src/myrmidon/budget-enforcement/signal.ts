// server/src/myrmidon/budget-enforcement/signal.ts
//
// myrmidon(1.7-BUDGET-CONFIG-B): the owner signal when a crossed limit does
// NOT stop work — the `signal_only` mode of budget enforcement.
//
// The vendor (M3) signal fires on a hard-stop that paused the scope. In
// signal-only mode the incident exists and the owner must still learn that a
// limit was crossed, but nothing stopped: the signal is a notice, not an
// interruption report. One comment per (incident, issue) in the thread of
// every open issue whose spend tripped the policy — the same issue-selection
// rule `budget-signal.ts` uses (open issues of the scope), simplified: in
// signal-only mode no runs are cancelled, so the cancelled-run arm of that
// selection never applies. Dedup rides the same metadata trick (a stable
// signal key in the first metadata row), with its own prefix so a soft/hard
// stop and a signal-only trip of the same policy never collide.
//
// Delivery is best-effort and never throws: a failed signal must not fail the
// incident write that carries it.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues } from "@paperclipai/db";
import type { IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";

/** The signal dedup key: `budget-signal-only:<incidentId>:<issueId>`. */
export function budgetSignalOnlyKey(incidentId: string, issueId: string): string {
  return `budget-signal-only:${incidentId}:${issueId}`;
}

export interface BudgetSignalOnlyInput {
  companyId: string;
  incidentId: string;
  scopeType: "company" | "agent" | "project";
  scopeId: string;
  scopeName: string;
  amountLimit: number;
  amountObserved: number;
}

/** Ports so tests can stub the comment service boundary (same shape as M3). */
export interface BudgetSignalOnlyPorts {
  addComment(
    issueId: string,
    body: string,
    actor: { agentId?: string; userId?: string; runId?: string | null },
    options: {
      authorType: "system";
      presentation: IssueCommentPresentation;
      metadata: IssueCommentMetadata;
    },
  ): Promise<unknown>;
  log: Pick<typeof logger, "info" | "warn">;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function scopeLabel(scopeType: BudgetSignalOnlyInput["scopeType"]): string {
  if (scopeType === "company") return "organization";
  return scopeType;
}

/**
 * The notice text: a limit was crossed, nothing stopped, and how to make it
 * stop. English, neutral — the same register the M3 hard-stop signal uses.
 */
export function buildBudgetSignalOnlyBody(input: BudgetSignalOnlyInput): string {
  return [
    "A spend budget limit was crossed.",
    "",
    `- Scope: ${scopeLabel(input.scopeType)} "${input.scopeName}"`,
    `- Limit: ${formatUsd(input.amountLimit)} (observed spend: ${formatUsd(input.amountObserved)})`,
    "",
    "Nothing stopped: budget enforcement is in signal-only mode, so runs continue while the limit is over.",
    "To make limits stop work, switch the enforcement mode on the Instance settings page (soft pauses the scope, hard refuses new runs).",
  ].join("\n");
}

export function buildBudgetSignalOnlyPresentation(): IssueCommentPresentation {
  return {
    kind: "system_notice",
    tone: "warning",
    title: "Budget limit crossed (signal only)",
    detailsDefaultOpen: true,
  };
}

export function buildBudgetSignalOnlyMetadata(
  input: Pick<BudgetSignalOnlyInput, "incidentId" | "scopeType" | "scopeName" | "amountLimit" | "amountObserved">,
  issueId: string,
  issueIdentifier: string | null,
): IssueCommentMetadata {
  return {
    version: 1,
    sections: [
      {
        title: "Budget signal",
        rows: [
          { type: "key_value", label: "Signal key", value: budgetSignalOnlyKey(input.incidentId, issueId) },
          { type: "key_value", label: "Scope", value: `${scopeLabel(input.scopeType)}: ${input.scopeName}` },
          { type: "key_value", label: "Limit (cents)", value: String(input.amountLimit) },
          { type: "key_value", label: "Observed (cents)", value: String(input.amountObserved) },
          { type: "key_value", label: "Incident", value: input.incidentId },
          { type: "key_value", label: "Issue", value: issueIdentifier ?? issueId },
        ],
      },
    ],
  };
}

/**
 * The open issues the notice goes to: for an agent scope, its open assigned
 * issues; for a project scope, the project's open issues; for a company
 * scope, nothing (no single thread speaks for the organization — the
 * decision-inbox budget card is the company-wide notice, the same cut M3
 * makes). Read-only, bounded.
 */
export async function listBudgetSignalOnlyIssueIds(
  db: Db,
  input: Pick<BudgetSignalOnlyInput, "companyId" | "scopeType" | "scopeId">,
): Promise<string[]> {
  if (input.scopeType === "company") return [];
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        input.scopeType === "agent"
          ? eq(issues.assigneeAgentId, input.scopeId)
          : eq(issues.projectId, input.scopeId),
        inArray(issues.status, ["todo", "in_progress", "in_review"]),
      ),
    )
    .limit(50);
  return rows.map((row) => row.id);
}

/** True when an issue already carries this incident's signal comment. */
async function hasBudgetSignalOnlyComment(
  db: Db,
  companyId: string,
  incidentId: string,
  issueId: string,
): Promise<boolean> {
  const key = budgetSignalOnlyKey(incidentId, issueId);
  const existing = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        eq(issueComments.authorType, "system"),
        sql`${issueComments.metadata} -> 'sections' -> 0 -> 'rows' -> 0 ->> 'value' = ${key}`,
      ),
    )
    .limit(1);
  return Boolean(existing[0]);
}

/**
 * Deliver the notice: one comment per (incident, issue). Never throws — the
 * incident write that called it has already committed.
 */
export async function deliverBudgetSignalOnly(
  db: Db,
  ports: BudgetSignalOnlyPorts,
  input: BudgetSignalOnlyInput,
): Promise<{ issueIds: string[]; written: number }> {
  const log = ports.log;
  let written = 0;
  const issueIds: string[] = [];
  try {
    const candidates = await listBudgetSignalOnlyIssueIds(db, {
      companyId: input.companyId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
    });
    for (const issueId of candidates) {
      try {
        if (await hasBudgetSignalOnlyComment(db, input.companyId, input.incidentId, issueId)) continue;
        const [issue] = await db
          .select({ identifier: issues.identifier })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)))
          .limit(1);
        await ports.addComment(
          issueId,
          buildBudgetSignalOnlyBody(input),
          {},
          {
            authorType: "system",
            presentation: buildBudgetSignalOnlyPresentation(),
            metadata: buildBudgetSignalOnlyMetadata(input, issueId, issue?.identifier ?? null),
          },
        );
        written += 1;
        issueIds.push(issueId);
      } catch (err) {
        log.warn({ err, issueId, incidentId: input.incidentId }, "budget signal-only delivery failed for one issue");
      }
    }
    if (written > 0) {
      log.info(
        { companyId: input.companyId, incidentId: input.incidentId, issueIds, written },
        "budget signal-only notice delivered to issue threads",
      );
    }
  } catch (err) {
    log.warn({ err, incidentId: input.incidentId }, "budget signal-only signal failed");
  }
  return { issueIds, written };
}

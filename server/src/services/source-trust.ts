import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, projects } from "@paperclipai/db";
import {
  LOW_TRUST_REVIEW_PRESET,
  type SourceTrustMetadata,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { readObject } from "../lib/objects.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";

export const LOW_TRUST_QUARANTINED_BODY =
  "[Quarantined low-trust output omitted from higher-trust agent context. A trusted reviewer can inspect and promote a sanitized artifact.]";

export type SourceTrustActor = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  /**
   * How the actor authenticated. `runId` is only trustworthy as a provenance
   * proof when it came from a signed agent JWT; for `agent_key` it is an
   * unsigned request header. Omitted means "not proven signed".
   */
  actorSource?: string | null;
};

// A run-identity mismatch stays fail-closed. The only release is for a run of
// *another* agent of the same company (normal delegation: a lead creates
// subtasks from its own automation run, continuations reuse another agent's
// run row) and only when BOTH hold:
//   1. the actor's run id is authenticated (signed agent JWT `run_id` claim).
//      For agent API keys `req.actor.runId` is copied from the unsigned
//      `X-Paperclip-Run-Id` header, so a caller that ingested untrusted input
//      could name a clean run and shed the quarantine. Unsigned run ids never
//      release a quarantine.
//   2. the run's provenance is on the allowlist of provably internal sources
//      below. The list is an allowlist on purpose: external input arrives
//      through many doors (chat bridges, `issue.interaction.respond` answers
//      to questions asked in an external chat, comments, webhooks), some of
//      which erase their markers from the stored snapshot, so "no known
//      external marker" proves nothing. A new internal source must be added
//      here explicitly; until then it stays quarantined (fail-closed).
const INTERNAL_INVOCATION_SOURCES: ReadonlySet<string> = new Set([
  "assignment",
  "automation",
  "timer",
]);

// Values of context_snapshot `source` / `wakeSource` written by server-side
// scheduling and board automation only (no human or external-chat text flows
// through them). Deliberately excluded: issue.comment, comment.mention*,
// issue.interaction.*, external_chat.*, chat:*, webhook-style sources.
const INTERNAL_SNAPSHOT_SOURCES: ReadonlySet<string> = new Set([
  "automation",
  "timer",
  "scheduler",
  "assignment",
  "routine.dispatch",
  "issue.assignment_recovery",
  "issue.assigned_todo_liveness_dispatch",
  "issue.children_completed",
  "issue.blockers_resolved",
]);

export function isProvenInternalRunProvenance(input: {
  invocationSource: string | null | undefined;
  contextSnapshot: unknown;
}): boolean {
  if (
    typeof input.invocationSource !== "string" ||
    !INTERNAL_INVOCATION_SOURCES.has(input.invocationSource)
  ) {
    return false;
  }
  const context = readObject(input.contextSnapshot);
  // Defence in depth: these markers are never written by internal sources, and
  // if one is present the run is external regardless of the allowlist.
  if (context?.externalChatExecutionBound === true) return false;
  if (context?.paperclipExternalChatExecutionBound === true) return false;
  if (typeof context?.webhookSource === "string" && context.webhookSource.length > 0) return false;
  for (const key of ["source", "wakeSource"] as const) {
    const value = context?.[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !INTERNAL_SNAPSHOT_SOURCES.has(value)) return false;
  }
  return true;
}

export type SourceTrustIssueContext = {
  id: string;
  companyId: string;
  projectId?: string | null;
  executionPolicy?: unknown;
};

export function isLowTrustQuarantined(sourceTrust: SourceTrustMetadata | null | undefined): boolean {
  return sourceTrust?.preset === LOW_TRUST_REVIEW_PRESET && sourceTrust.disposition === "quarantined";
}

export function redactQuarantinedBodyForHigherTrust<T extends { body?: string | null; sourceTrust?: SourceTrustMetadata | null }>(
  value: T,
): T {
  if (!isLowTrustQuarantined(value.sourceTrust)) return value;
  return {
    ...value,
    body: LOW_TRUST_QUARANTINED_BODY,
  } as T;
}

export function sanitizeQuarantinedCommentForHigherTrust<
  T extends {
    body: string;
    presentation?: unknown;
    metadata?: unknown;
    sourceTrust?: SourceTrustMetadata | null;
  },
>(comment: T): T {
  if (!isLowTrustQuarantined(comment.sourceTrust)) return comment;
  return {
    ...comment,
    body: LOW_TRUST_QUARANTINED_BODY,
    presentation: null,
    metadata: null,
  };
}

export function buildLowTrustSourceTrust(input: {
  issueId: string;
  runId?: string | null;
  agentId?: string | null;
}): SourceTrustMetadata {
  return {
    preset: LOW_TRUST_REVIEW_PRESET,
    disposition: "quarantined",
    sourceIssueId: input.issueId,
    sourceRunId: input.runId ?? null,
    sourceAgentId: input.agentId ?? null,
  };
}

export function buildPromotedSourceTrust(input: {
  sourceIssueId: string;
  sourceArtifactKind: "comment" | "document" | "work_product" | "issue";
  sourceArtifactId: string;
  promotedByActorType: "agent" | "user" | "system";
  promotedByActorId: string;
  promotedAt?: Date;
}): SourceTrustMetadata {
  return {
    preset: LOW_TRUST_REVIEW_PRESET,
    disposition: "promoted",
    sourceIssueId: input.sourceIssueId,
    promotedFrom: {
      artifactKind: input.sourceArtifactKind,
      artifactId: input.sourceArtifactId,
      issueId: input.sourceIssueId,
    },
    promotedByActorType: input.promotedByActorType,
    promotedByActorId: input.promotedByActorId,
    promotedAt: (input.promotedAt ?? new Date()).toISOString(),
  };
}

export async function resolveActorSourceTrustForIssue(input: {
  db: Db;
  issue: SourceTrustIssueContext;
  actor: SourceTrustActor;
}): Promise<SourceTrustMetadata | null> {
  if (input.actor.actorType !== "agent" || !input.actor.agentId) return null;

  const [agent, project, run] = await Promise.all([
    input.db
      .select({
        companyId: agents.companyId,
        permissions: agents.permissions,
      })
      .from(agents)
      .where(and(eq(agents.id, input.actor.agentId), eq(agents.companyId, input.issue.companyId)))
      .then((rows) => rows[0] ?? null),
    input.issue.projectId
      ? input.db
          .select({
            companyId: projects.companyId,
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(and(eq(projects.id, input.issue.projectId), eq(projects.companyId, input.issue.companyId)))
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    input.actor.runId
      ? input.db
          .select({
            companyId: heartbeatRuns.companyId,
            agentId: heartbeatRuns.agentId,
            invocationSource: heartbeatRuns.invocationSource,
            contextSnapshot: heartbeatRuns.contextSnapshot,
          })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.id, input.actor.runId), eq(heartbeatRuns.companyId, input.issue.companyId)))
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);

  if (input.actor.runId && (!run || run.agentId !== input.actor.agentId)) {
    // Fail closed: an unknown (or foreign-company) run cannot prove higher
    // trust, so tag the write as quarantined. A run of this company owned by a
    // *different* agent is released only when the run id is authenticated
    // (signed JWT claim, not the client-supplied header) and its provenance is
    // on the internal allowlist.
    const releasable =
      input.actor.actorSource === "agent_jwt" &&
      run !== null &&
      isProvenInternalRunProvenance(run);
    if (!releasable) {
      return buildLowTrustSourceTrust({
        issueId: input.issue.id,
        runId: input.actor.runId,
        agentId: input.actor.agentId,
      });
    }
  }

  const runContext = readObject(run?.contextSnapshot);
  const runExecutionPolicy = readObject(runContext?.executionPolicy);

  const resolution = resolveCoreTrustPreset({
    companyId: input.issue.companyId,
    agent,
    project,
    issue: {
      companyId: input.issue.companyId,
      executionPolicy: input.issue.executionPolicy,
    },
    run: run
      ? {
          companyId: run.companyId,
          executionPolicy: runExecutionPolicy,
        }
      : null,
  });

  if (resolution.kind === "denied") {
    throw forbidden(resolution.detail);
  }
  if (resolution.kind !== "low_trust_review") return null;
  return buildLowTrustSourceTrust({
    issueId: input.issue.id,
    runId: input.actor.runId,
    agentId: input.actor.agentId,
  });
}

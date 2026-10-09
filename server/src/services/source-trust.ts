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
};

// A run-identity mismatch must stay fail-closed for unknown/foreign-company
// runs and for runs that demonstrably ingested *external* input, which is what
// low-trust quarantine protects against (untrusted outside content flowing
// into board data). Agent-to-agent delegation is normal board behaviour: a
// lead creates subtasks from its own automation run, continuations reuse
// another agent's run row, and new wake reasons appear over time — enumerating
// "known internal" reasons would re-quarantine legitimate tasks every time one
// is added. So the rule is inverted: same-company provenance counts as
// internal unless it carries an external-input marker. The markers are exactly
// the ones the external-chat bridge writes (heartbeat.ts
// resolveExternalChatWakeProvider: `source === "chat:<provider>"`, the
// execution-bound key) plus webhook-style invocation sources. Everything else
// is governed by the normal trust-preset policy below, same as for an agent's
// own runs.
const EXTERNAL_WAKE_SOURCES = new Set([
  "webhook",
  "external_api",
  "api",
  "discord",
  "telegram",
  "whatsapp",
]);

function isExternalInputRunProvenance(input: {
  invocationSource: string | null | undefined;
  contextSnapshot: unknown;
}): boolean {
  const context = readObject(input.contextSnapshot);
  if (context?.externalChatExecutionBound === true) return true;
  if (context?.paperclipExternalChatExecutionBound === true) return true;
  const sourceStrings = [
    typeof input.invocationSource === "string" ? input.invocationSource : null,
    typeof context?.source === "string" ? context.source : null,
    typeof context?.wakeSource === "string" ? context.wakeSource : null,
  ];
  for (const value of sourceStrings) {
    if (!value) continue;
    if (value.startsWith("chat:")) return true;
    if (EXTERNAL_WAKE_SOURCES.has(value)) return true;
  }
  return false;
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
    // *different* agent is normal internal delegation (the board wakes agents
    // onto each other's issues; a lead creates subtasks from its own run), so
    // it only quarantines when that run demonstrably ingested external input.
    const foreignSameCompanyRun = Boolean(run);
    if (!foreignSameCompanyRun || isExternalInputRunProvenance(run!)) {
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

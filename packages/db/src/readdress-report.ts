import { createDb } from "./client.js";
import { sql } from "drizzle-orm";
import {
  buildInteractionEscalationChain,
  resolveInteractionRecipient,
  type InteractionPrincipal,
  type InteractionRecipient,
  type ProjectInteractionRole,
  type ScopedInteractionPrincipal,
  interactionRecipientSchema,
} from "@myrmidon/shared";

export type PendingCard = {
  id: string;
  issueIdentifier: string | null;
  kind: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  addresseeAgentId: string | null;
  addresseeUserId: string | null;
  requestedResolverPolicy: string;
  effectiveResolverPolicy: string;
  payload: Record<string, unknown>;
  projectId: string | null;
  casteKey: string | null;
  executionPolicy: Record<string, unknown> | null;
  projectLeadAgentId: string | null;
  projectMemberships?: Record<string, boolean>;
};

export type ReaddressResult = PendingCard & {
  proposedRecipient: string | "unresolved";
  reason?: string;
  escalationChain?: Array<{ recipient: string; afterMinutes: number | null }>;
};

type AddresslessCardInput = Pick<PendingCard, "effectiveResolverPolicy"> & Partial<Omit<PendingCard, "effectiveResolverPolicy">>; // dry-run resolver accepts partial snapshots

// Keep the report resolver usable for isolated policy tests and partial snapshots.

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function recipientLabel(recipient: InteractionRecipient): string {
  if ("agentId" in recipient) return `agent:${recipient.agentId}`;
  if ("userId" in recipient) return `user:${recipient.userId}`;
  return `queue:${recipient.serviceQueue}`;
}

/** Resolve a concrete I4 participant when one is stored; otherwise explain the ambiguity. */
export function resolveAddresslessCard<T extends AddresslessCardInput>(card: T): T & {
  proposedRecipient: string | "unresolved";
  reason?: string;
  escalationChain?: Array<{ recipient: string; afterMinutes: number | null }>;
} {
  const policy = card.effectiveResolverPolicy;
  if (card.addresseeAgentId || card.addresseeUserId) {
    return { ...card, proposedRecipient: card.addresseeAgentId ?? `user:${card.addresseeUserId}` };
  }
  const executionPolicy = asObject(card.executionPolicy);
  const payloadPolicy = asObject(card.payload?.escalationPolicy);
  const reviewPolicy = payloadPolicy ?? asObject(executionPolicy?.reviewEscalationPolicy);
  const participants = asObject(reviewPolicy?.participants) as Partial<Record<ProjectInteractionRole, ScopedInteractionPrincipal | InteractionRecipient | null>> | null;
  const creator: InteractionRecipient = card.createdByAgentId
    ? { agentId: card.createdByAgentId }
    : card.createdByUserId ? { userId: card.createdByUserId } : { serviceQueue: "__unknown_creator__" };
  if (!card.createdByAgentId && !card.createdByUserId) {
    return { ...card, proposedRecipient: "unresolved", reason: "creator is missing; cannot safely exclude self-routing" };
  }
  const rawRouting = asObject(card.payload?.routing) ?? card.payload ?? {};
  const routingPolicy = asObject(rawRouting.escalationPolicy) ?? asObject(rawRouting.policy);
  const routingRoles = asObject(rawRouting.projectRoles) as Partial<Record<ProjectInteractionRole, ScopedInteractionPrincipal | InteractionRecipient | null>> | null;
  const projectMemberships = card.projectMemberships;
  const roleMembership = (principal: ScopedInteractionPrincipal | InteractionRecipient | null | undefined) => {
    if (!principal || !("type" in principal) || principal.type !== "agent" || !principal.agentId) return principal;
    const isJoinedMember = principal.agentId ? card.projectMemberships?.[principal.agentId] === true : false;
    return { ...principal, isJoinedMember };
  };
  const projectRoles = {
    lead: roleMembership(routingRoles?.lead ?? participants?.lead ?? (card.projectLeadAgentId
      ? { type: "agent" as const, agentId: card.projectLeadAgentId, projectId: card.projectId, casteKey: card.casteKey,
        projectRoles: ["lead"] as const }
      : null)),
    architect: roleMembership(routingRoles?.architect ?? participants?.architect),
    secondary_reviewer: roleMembership(routingRoles?.secondary_reviewer ?? participants?.secondary_reviewer),
  };
  const effectivePolicy = routingPolicy ?? reviewPolicy;
  const participantRoles = Array.isArray(effectivePolicy?.participantRoles)
    ? effectivePolicy.participantRoles.filter((role): role is ProjectInteractionRole =>
      role === "lead" || role === "architect" || role === "secondary_reviewer")
    : ["lead", "architect", "secondary_reviewer"] as const;
  const fallbackQueue = typeof effectivePolicy?.fallbackQueue === "string" ? effectivePolicy.fallbackQueue.trim() : "";
  const routeType = rawRouting.routeType === "code_review" || rawRouting.routeType === "approval" || rawRouting.routeType === "operator_action" || rawRouting.routeType === "human_input"
    ? rawRouting.routeType
    : "decision";
  const parsedRecipient = interactionRecipientSchema.safeParse(rawRouting.recipient);
  const explicitRecipient = parsedRecipient.success ? parsedRecipient.data : null;
  const serviceQueue = typeof rawRouting.serviceQueue === "string" ? rawRouting.serviceQueue : null;
  const stepDelayMinutes = typeof effectivePolicy?.stepDelayMinutes === "number" && Number.isFinite(effectivePolicy.stepDelayMinutes)
    ? effectivePolicy.stepDelayMinutes
    : null;
  const escalationPolicy = fallbackQueue && stepDelayMinutes !== null
    ? { participantRoles, fallbackQueue, stepDelayMinutes }
    : null;
  const escalationRoles = projectRoles;
  const escalationChain = escalationPolicy
    ? buildInteractionEscalationChain({
      routeType,
      policy: escalationPolicy,
      projectRoles: escalationRoles,
      projectId: card.projectId,
      casteScope: { projectId: card.projectId, casteKey: card.casteKey },
      creator,
    })
    : [];

  try {
    const recipient = resolveInteractionRecipient({
      routeType,
      kind: card.kind ?? "decision",
      effectiveResolverPolicy: policy,
      projectId: card.projectId,
      casteScope: { projectId: card.projectId, casteKey: card.casteKey },
      creator,
      projectRoles: escalationRoles,
      recipient: explicitRecipient,
      serviceQueue,
    });
    return {
      ...card,
      proposedRecipient: recipientLabel(recipient),
      ...(fallbackQueue && !escalationPolicy ? { reason: "Escalation chain unresolved: fallback queue or step delay missing from stored policy" } : {}),
      ...(escalationChain.length ? { escalationChain: escalationChain.map((step) => ({
        recipient: recipientLabel(step.recipient), afterMinutes: stepDelayMinutes === null ? null : step.afterMinutes,
      })) } : {}),
    }; // dry-run result includes the computed destination
  } catch (error) {
    const policyReason = policy === "human_only"
      ? "human_only requires a concrete human or configured project recipient"
      : policy === "not_creator"
        ? "not_creator excludes the creator, but no eligible independent recipient is configured"
        : policy === "anyone"
          ? "anyone defines an audience, not a deterministic recipient"
          : `unsupported effective resolver policy: ${policy}`;
    return {
      ...card,
      proposedRecipient: "unresolved",
      reason: error instanceof Error ? `${policyReason}; ${error.message}` : policyReason,
      ...(escalationChain.length ? { escalationChain: escalationChain.map((step) => ({
        recipient: recipientLabel(step.recipient), afterMinutes: stepDelayMinutes === null ? null : step.afterMinutes,
      })) } : {}),
    };
  }
}

/** Read-only snapshot; never mutates interaction rows. */
export async function loadReport(databaseUrl: string): Promise<ReaddressResult[]> {
  const db = createDb(databaseUrl);
  try {
    return await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        SELECT i.id,
               issues.identifier AS "issueIdentifier",
               i.kind,
               i.created_by_agent_id AS "createdByAgentId",
               i.created_by_user_id AS "createdByUserId",
               i.addressee_agent_id AS "addresseeAgentId",
               i.addressee_user_id AS "addresseeUserId",
               i.requested_resolver_policy AS "requestedResolverPolicy",
               i.effective_resolver_policy AS "effectiveResolverPolicy",
               i.payload,
               issues.project_id AS "projectId",
               issues.caste_key AS "casteKey",
               issues.execution_policy AS "executionPolicy",
               projects.lead_agent_id AS "projectLeadAgentId",
               COALESCE((SELECT jsonb_object_agg(a.id::text, true)
                         FROM project_memberships pm
                         JOIN agents a ON a.id::text = pm.user_id
                         WHERE pm.company_id = issues.company_id
                           AND pm.project_id = issues.project_id
                           AND pm.state = 'joined'), '{}'::jsonb) AS "projectMemberships"
        FROM issue_thread_interactions i
        LEFT JOIN issues ON issues.id = i.issue_id AND issues.company_id = i.company_id
        LEFT JOIN projects ON projects.id = issues.project_id AND projects.company_id = issues.company_id
        WHERE i.status = 'pending'
          AND i.addressee_agent_id IS NULL
          AND i.addressee_user_id IS NULL
        ORDER BY i.created_at, i.id
      `);
      return result.map((row) => resolveAddresslessCard(row as PendingCard));
    }, { accessMode: "read only" });
  } finally {
    await db.$client.end();
  }
}

function csvValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

export function formatReport(rows: ReaddressResult[], format: "json" | "csv"): string {
  if (format === "json") return `${JSON.stringify(rows, null, 2)}\n`;
  const fields = ["id", "issueIdentifier", "kind", "createdByAgentId", "createdByUserId", "requestedResolverPolicy", "effectiveResolverPolicy", "proposedRecipient", "reason", "escalationChain"] as const;
  return `${fields.join(",")}\n${rows.map((row) => fields.map((field) => csvValue(row[field])).join(",")).join("\n")}\n`;
}

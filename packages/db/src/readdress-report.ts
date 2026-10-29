import { createDb } from "./client.js";
import { sql } from "drizzle-orm";
import {
  buildEscalationChain,
  type EscalationChainPolicy,
  type EscalationRole,
  type InteractionPrincipal,
  type InteractionRecipient,
  type ProjectEscalationRoles,
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

type AddresslessCardInput = Pick<PendingCard, "effectiveResolverPolicy"> & Partial<Omit<PendingCard, "effectiveResolverPolicy">>;

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

/** Resolve a concrete recipient for dry-run readdress reporting. */
function resolveReportRecipient(params: {
  policy: string;
  routeType: string;
  creator: InteractionRecipient;
  projectRoles: Record<EscalationRole, InteractionRecipient | null>;
  participantRoles: readonly EscalationRole[];
  explicitRecipient: InteractionRecipient | null;
  serviceQueue: string | null;
}): InteractionRecipient {
  if (params.explicitRecipient) return params.explicitRecipient;
  if (params.serviceQueue) return { serviceQueue: params.serviceQueue };

  if (params.policy === "anyone" || params.policy === "not_creator") {
    throw new Error(
      params.policy === "anyone"
        ? "anyone defines an audience, not a deterministic recipient"
        : "not_creator excludes the creator, but no eligible independent recipient is configured"
    );
  }

  const sameRecipient = (a: InteractionRecipient, b: InteractionRecipient): boolean => {
    if ("agentId" in a && "agentId" in b) return a.agentId === b.agentId;
    if ("userId" in a && "userId" in b) return a.userId === b.userId;
    if ("serviceQueue" in a && "serviceQueue" in b) return a.serviceQueue === b.serviceQueue;
    return false;
  };

  for (const role of params.participantRoles) {
    const candidate = params.projectRoles[role];
    if (!candidate) continue;
    if (sameRecipient(candidate, params.creator)) continue;
    if (params.routeType === "code_review" && "userId" in candidate) continue;
    if (params.policy === "human_only" && !("userId" in candidate)) continue;
    return candidate;
  }

  throw new Error(`No eligible recipient configured for policy: ${params.policy}`);
}

/** Resolve a concrete participant when one is eligible; otherwise explain ambiguity. */
export function resolveAddresslessCard<T extends AddresslessCardInput>(card: T): T & {
  proposedRecipient: string | "unresolved";
  reason?: string;
  escalationChain?: Array<{ recipient: string; afterMinutes: number | null }>;
} {
  const policy = card.effectiveResolverPolicy;
  if (card.addresseeAgentId || card.addresseeUserId) {
    return {
      ...card,
      proposedRecipient: card.addresseeAgentId ? `agent:${card.addresseeAgentId}` : `user:${card.addresseeUserId}`,
    };
  }

  const executionPolicy = asObject(card.executionPolicy);
  const payloadPolicy = asObject(card.payload?.escalationPolicy);
  const reviewPolicy = payloadPolicy ?? asObject(executionPolicy?.reviewEscalationPolicy);
  const participants = asObject(reviewPolicy?.participants) as Partial<Record<ProjectInteractionRole, ScopedInteractionPrincipal | InteractionRecipient | null>> | null;

  const creator: InteractionRecipient = card.createdByAgentId
    ? { agentId: card.createdByAgentId }
    : card.createdByUserId
      ? { userId: card.createdByUserId }
      : { serviceQueue: "__unknown_creator__" };

  if (!card.createdByAgentId && !card.createdByUserId) {
    return { ...card, proposedRecipient: "unresolved", reason: "creator is missing; cannot safely exclude self-routing" };
  }

  const rawRouting = asObject(card.payload?.routing) ?? card.payload ?? {};
  const routingPolicy = asObject(rawRouting.escalationPolicy) ?? asObject(rawRouting.policy);
  const routingRoles = asObject(rawRouting.projectRoles) as Partial<Record<ProjectInteractionRole, ScopedInteractionPrincipal | InteractionRecipient | null>> | null;

  // Canonical project membership: lead_agent_id OR joined membership OR agent_nests (server/src/myrmidon/project-membership.ts)
  const isProjectMember = (agentId: string | null | undefined): boolean => {
    if (!agentId) return false;
    if (card.projectLeadAgentId && agentId === card.projectLeadAgentId) return true;
    return card.projectMemberships?.[agentId] === true;
  };

  const toCandidateRecipient = (principal: ScopedInteractionPrincipal | InteractionRecipient | null | undefined): InteractionRecipient | null => {
    if (!principal) return null;
    if ("agentId" in principal && principal.agentId) {
      return isProjectMember(principal.agentId) ? { agentId: principal.agentId } : null;
    }
    if ("userId" in principal && principal.userId) {
      return { userId: principal.userId };
    }
    if ("type" in principal) {
      if (principal.type === "agent" && principal.agentId) {
        return isProjectMember(principal.agentId) ? { agentId: principal.agentId } : null;
      }
      if (principal.type === "user" && principal.userId) {
        return { userId: principal.userId };
      }
    }
    if ("serviceQueue" in principal) {
      return { serviceQueue: principal.serviceQueue };
    }
    return null;
  };

  const leadSource = routingRoles?.lead ?? participants?.lead ?? (card.projectLeadAgentId
    ? { type: "agent" as const, agentId: card.projectLeadAgentId, projectId: card.projectId, casteKey: card.casteKey, projectRoles: ["lead"] as const }
    : null);

  const escalationRoles: Record<EscalationRole, InteractionRecipient | null> = {
    lead: toCandidateRecipient(leadSource),
    architect: toCandidateRecipient(routingRoles?.architect ?? participants?.architect),
    secondary_reviewer: toCandidateRecipient(routingRoles?.secondary_reviewer ?? participants?.secondary_reviewer),
  };

  const effectivePolicy = routingPolicy ?? reviewPolicy;
  const participantRoles = Array.isArray(effectivePolicy?.participantRoles)
    ? effectivePolicy.participantRoles.filter((role): role is EscalationRole =>
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

  const escalationPolicy: EscalationChainPolicy | null = fallbackQueue && stepDelayMinutes !== null
    ? { participantRoles, fallbackQueue, stepDelayMinutes }
    : null;

  const escalationChain = escalationPolicy
    ? buildEscalationChain({
      routeType,
      policy: escalationPolicy,
      projectRoles: escalationRoles,
      startAt: 0,
    })
    : [];

  try {
    const recipient = resolveReportRecipient({
      policy,
      routeType,
      creator,
      projectRoles: escalationRoles,
      participantRoles,
      explicitRecipient,
      serviceQueue,
    });
    return {
      ...card,
      proposedRecipient: recipientLabel(recipient),
      ...(fallbackQueue && !escalationPolicy ? { reason: "Escalation chain unresolved: fallback queue or step delay missing from stored policy" } : {}),
      ...(escalationChain.length ? {
        escalationChain: escalationChain.map((step) => ({
          recipient: recipientLabel(step.recipient),
          afterMinutes: stepDelayMinutes === null ? null : step.afterMinutes,
        })),
      } : {}),
    };
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
      ...(escalationChain.length ? {
        escalationChain: escalationChain.map((step) => ({
          recipient: recipientLabel(step.recipient),
          afterMinutes: stepDelayMinutes === null ? null : step.afterMinutes,
        })),
      } : {}),
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
               COALESCE((
                 SELECT jsonb_object_agg(member_id, true)
                 FROM (
                   SELECT projects.lead_agent_id::text AS member_id
                   WHERE projects.lead_agent_id IS NOT NULL
                   UNION
                   SELECT pm.user_id::text AS member_id
                   FROM project_memberships pm
                   JOIN agents a ON a.id::text = pm.user_id AND a.company_id = pm.company_id
                   WHERE pm.company_id = issues.company_id
                     AND pm.project_id = issues.project_id
                     AND pm.state = 'joined'
                   UNION
                   SELECT an.agent_id::text AS member_id
                   FROM agent_nests an
                   WHERE an.company_id = issues.company_id
                     AND an.project_id = issues.project_id
                 ) m
               ), '{}'::jsonb) AS "projectMemberships"
        FROM issue_thread_interactions i
        LEFT JOIN issues ON issues.id = i.issue_id AND issues.company_id = i.company_id
        LEFT JOIN projects ON projects.id = issues.project_id AND projects.company_id = issues.company_id
        WHERE i.status = 'pending'
          AND i.addressee_agent_id IS NULL
          AND i.addressee_user_id IS NULL
        ORDER BY i.created_at, i.id
      `);
      return (result as unknown as PendingCard[]).map((row) => resolveAddresslessCard(row));
    }, { accessMode: "read only" });
  } finally {
    await db.$client.end();
  }
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function formatReport(rows: ReaddressResult[], format: "json" | "csv"): string {
  if (format === "json") return `${JSON.stringify(rows, null, 2)}\n`;
  const fields = ["id", "issueIdentifier", "kind", "createdByAgentId", "createdByUserId", "requestedResolverPolicy", "effectiveResolverPolicy", "proposedRecipient", "reason", "escalationChain"] as const;
  return `${fields.join(",")}\n${rows.map((row) => fields.map((field) => csvValue(row[field])).join(",")).join("\n")}\n`;
}

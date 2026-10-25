import type {
  InteractionEscalationStep,
  InteractionRecipient,
  InteractionRouteType,
} from "@myrmidon/shared";

export type EscalationRole = "lead" | "architect" | "secondary_reviewer";

export interface EscalationChainPolicy {
  participantRoles: EscalationRole[];
  fallbackQueue: string;
}

export type ProjectEscalationRoles = Partial<Record<EscalationRole, InteractionRecipient | null>>;

/** Build a deterministic escalation chain, keeping the service queue as its terminal owner. */
export function buildEscalationChain(input: {
  routeType: InteractionRouteType | "code_review";
  policy: EscalationChainPolicy;
  projectRoles: ProjectEscalationRoles;
  startAt?: number;
}): InteractionEscalationStep[] {
  const { routeType, policy, projectRoles } = input;
  const startAt = input.startAt ?? 0;
  const seen = new Set<string>();
  const chain: InteractionEscalationStep[] = [];

  const recipientKey = (recipient: InteractionRecipient): string => {
    if ("agentId" in recipient) return `agent:${recipient.agentId}`;
    if ("userId" in recipient) return `user:${recipient.userId}`;
    return `queue:${recipient.serviceQueue}`;
  };

  for (const role of policy.participantRoles) {
    const recipient = projectRoles[role];
    if (!recipient || (routeType === "code_review" && "userId" in recipient)) continue;
    const key = recipientKey(recipient);
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push({ recipient, afterMinutes: startAt + chain.length });
  }

  const queue = { serviceQueue: policy.fallbackQueue } as const;
  const queueKey = recipientKey(queue);
  if (!seen.has(queueKey)) {
    chain.push({ recipient: queue, afterMinutes: startAt + chain.length });
  } else if (chain.at(-1)?.recipient.serviceQueue !== policy.fallbackQueue) {
    // A configured role may point to the fallback queue; move it to the end.
    const queueStep = chain.find((step) => step.recipient.serviceQueue === policy.fallbackQueue);
    if (queueStep) {
      chain.splice(chain.indexOf(queueStep), 1);
      chain.push({ ...queueStep, afterMinutes: startAt + chain.length });
    }
  }

  return chain;
}
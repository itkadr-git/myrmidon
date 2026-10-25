import type {
  InteractionEscalationStep,
  InteractionRecipient,
  InteractionRouteType,
} from "@myrmidon/shared";

export type EscalationRole = "lead" | "architect" | "secondary_reviewer";

export interface EscalationChainPolicy {
  participantRoles: readonly EscalationRole[];
  fallbackQueue: string;
}

export type ProjectEscalationRoles = Partial<Record<EscalationRole, InteractionRecipient | null>>;

function isQueueRecipient(recipient: InteractionRecipient): recipient is { serviceQueue: string } {
  return "serviceQueue" in recipient;
}

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
  } else {
    const queueIndex = chain.findIndex((step) =>
      isQueueRecipient(step.recipient) && step.recipient.serviceQueue === policy.fallbackQueue,
    );
    if (queueIndex >= 0 && queueIndex < chain.length - 1) {
      const [queueStep] = chain.splice(queueIndex, 1);
      if (queueStep) chain.push({ ...queueStep, afterMinutes: startAt + chain.length });
    }
  }

  return chain;
}
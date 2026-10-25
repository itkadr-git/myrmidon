import type {
  InteractionEscalationStep,
  InteractionRecipient,
  InteractionRouteType,
} from "@myrmidon/shared";

export type EscalationRole = "lead" | "architect" | "secondary_reviewer";

export interface EscalationChainPolicy {
  participantRoles: readonly EscalationRole[];
  fallbackQueue: string;
  /** Explicit delay between escalation steps; index-based timing is not a policy. */
  stepDelayMinutes: number;
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
  let fallbackQueueConfigured = false;
  let configuredQueueDelay: number | undefined;

  const recipientKey = (recipient: InteractionRecipient): string => {
    if ("agentId" in recipient) return `agent:${recipient.agentId}`;
    if ("userId" in recipient) return `user:${recipient.userId}`;
    return `queue:${recipient.serviceQueue}`;
  };

  for (const role of policy.participantRoles) {
    const recipient = projectRoles[role];
    if (!recipient || (routeType === "code_review" && "userId" in recipient)) continue;
    if ("serviceQueue" in recipient) {
      if (recipient.serviceQueue === policy.fallbackQueue && !fallbackQueueConfigured) {
        configuredQueueDelay = startAt + chain.length * policy.stepDelayMinutes;
        fallbackQueueConfigured = true;
      }
      continue;
    }
    const key = recipientKey(recipient);
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push({ recipient, afterMinutes: startAt + chain.length * policy.stepDelayMinutes });
  }

  chain.push({
    recipient: { serviceQueue: policy.fallbackQueue },
    afterMinutes: configuredQueueDelay ?? startAt + chain.length * policy.stepDelayMinutes,
  });

  return chain;
}

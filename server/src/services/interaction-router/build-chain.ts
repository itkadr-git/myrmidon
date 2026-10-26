import {
  buildInteractionEscalationChain,
  type InteractionEscalationPolicy,
  type InteractionRecipient,
  type InteractionRouteType,
} from "@myrmidon/shared";

export type EscalationRole = "lead" | "architect" | "secondary_reviewer";
export type EscalationChainPolicy = InteractionEscalationPolicy;
export type ProjectEscalationRoles = Partial<Record<EscalationRole, InteractionRecipient | null>>;

export function buildEscalationChain(input: {
  routeType: InteractionRouteType | "code_review";
  policy: EscalationChainPolicy;
  projectRoles: ProjectEscalationRoles;
  startAt?: number;
}): Array<{ recipient: InteractionRecipient; afterMinutes: number }> {
  return buildInteractionEscalationChain({
    ...input,
    projectRoles: Object.fromEntries(Object.entries(input.projectRoles).map(([role, recipient]) => [
      role,
      recipient && "agentId" in recipient
        ? { type: "agent", agentId: recipient.agentId, isJoinedMember: true }
        : recipient,
    ])) as typeof input.projectRoles,
    creator: { serviceQueue: "__no_excluded_agent__" },
  });
}

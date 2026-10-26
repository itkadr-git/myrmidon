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
    creator: { serviceQueue: "__no_excluded_agent__" },
  });
}

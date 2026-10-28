import { z } from "zod";

export const INTERACTION_ROUTE_TYPES = [
  "decision",
  "approval",
  "operator_action",
  "human_input",
] as const;

export type InteractionRouteType = (typeof INTERACTION_ROUTE_TYPES)[number];

export const interactionRecipientSchema = z.union([
  z.object({ agentId: z.string().min(1) }).strict(),
  z.object({ userId: z.string().min(1) }).strict(),
  z.object({ serviceQueue: z.string().min(1) }).strict(),
]);

export type InteractionRecipient = z.infer<typeof interactionRecipientSchema>;

export const interactionEscalationStepSchema = z.object({
  recipient: interactionRecipientSchema,
  afterMinutes: z.number().finite().nonnegative(),
}).strict();

export type InteractionEscalationStep = z.infer<typeof interactionEscalationStepSchema>;

export const interactionRoutingInputSchema = z.object({
  routeType: z.enum(INTERACTION_ROUTE_TYPES),
  recipient: interactionRecipientSchema,
  timeoutAt: z.string().datetime(),
  escalationChain: z.array(interactionEscalationStepSchema).min(1),
  dedupeKey: z.string().min(1),
}).strict();

export type InteractionRoutingInput = z.infer<typeof interactionRoutingInputSchema>;

export interface InteractionRoutingMetrics {
  pendingWithoutOwner: number;
  escalated: (level: number) => number;
  timeoutResolved: number;
}

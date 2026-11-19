import { z } from "zod";

const participant = z.object({ type: z.literal("agent"), agentId: z.string().uuid() }).strict();

export const executionParticipantsSchema = z.object({
  returnAssignee: participant.nullable().optional(),
  currentParticipant: participant.nullable().optional(),
}).strict().refine((value) => value.returnAssignee !== undefined || value.currentParticipant !== undefined, {
  message: "At least one participant must be provided",
});

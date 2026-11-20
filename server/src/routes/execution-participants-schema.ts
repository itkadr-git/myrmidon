import { z } from "zod";

const participant = z.object({ type: z.literal("agent"), agentId: z.string().uuid() }).strict();

export const executionParticipantsSchema = z.union([
  z.object({ returnAssignee: participant.nullable() }).strict(),
  z.object({ currentParticipant: participant.nullable() }).strict(),
  z.object({ returnAssignee: participant.nullable(), currentParticipant: participant.nullable() }).strict(),
]);

import { z } from "zod";

export const haStandbyCheckStatusSchema = z.enum(["ready", "unhealthy", "not_configured"]);

export const haStandbyCheckSchema = z.object({
  name: z.string().min(1),
  status: haStandbyCheckStatusSchema,
  checkedAt: z.iso.datetime(),
}).strict();

export const haStandbyStatusSchema = z.object({
  status: haStandbyCheckStatusSchema,
  checkedAt: z.iso.datetime(),
  checks: z.array(haStandbyCheckSchema),
}).strict();

export type HaStandbyStatus = z.infer<typeof haStandbyStatusSchema>;

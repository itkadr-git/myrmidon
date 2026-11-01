import { z } from "zod";

export const blockUserSchema = z.object({
  reason: z
    .string({ error: "Reason is required" })
    .trim()
    .min(1, "Reason is required")
    .max(1000, "Reason must not exceed 1000 characters"),
});

export type BlockUserInput = z.infer<typeof blockUserSchema>;

export const unblockUserSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});

export type UnblockUserInput = z.infer<typeof unblockUserSchema>;

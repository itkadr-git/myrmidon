import { z } from "zod";

export const blockUserSchema = z.object({
  reason: z
    .string({ required_error: "Reason is required" })
    .trim()
    .min(1, "Reason is required")
    .max(1000, "Reason must not exceed 1000 characters"),
});

export type BlockUser = z.infer<typeof blockUserSchema>;
export type BlockUserPayload = BlockUser;
export type BlockUserInput = BlockUser;

export const unblockUserSchema = z.object({
  reason: z.string().trim().optional(),
});

export type UnblockUser = z.infer<typeof unblockUserSchema>;
export type UnblockUserPayload = UnblockUser;

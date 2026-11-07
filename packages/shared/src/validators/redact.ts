import { z } from "zod";

/**
 * REDACT configuration contract (OPE-10221).
 *
 * Defines the validated schema for redaction rules consumed by the
 * myrmidon-redact service. The schema is strict: unknown fields are rejected.
 * Secrets are never part of the configuration; only recognizer/mode/ttl knobs.
 */

export const redactModeSchema = z.enum(["flag", "mask", "block"]);
export type RedactMode = z.infer<typeof redactModeSchema>;

export const redactMaskStyleSchema = z.enum(["irreversible", "reversible"]);
export type RedactMaskStyle = z.infer<typeof redactMaskStyleSchema>;

export const redactEntityKindSchema = z.enum([
  "pii",
  "secret",
  "bank",
  "legal",
  "custom",
]);
export type RedactEntityKind = z.infer<typeof redactEntityKindSchema>;

export const redactRecognizerSchema = z.object({
  kind: redactEntityKindSchema,
  enabled: z.boolean().default(true),
  pattern: z.string().min(1).optional(),
  priority: z.number().int().min(0).max(1000).default(100).optional(),
}).strict();
export type RedactRecognizer = z.infer<typeof redactRecognizerSchema>;

export const redactRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  mode: redactModeSchema.default("flag"),
  maskStyle: redactMaskStyleSchema.default("irreversible"),
  ttlSeconds: z.number().int().min(0).max(7 * 24 * 60 * 60).default(3600).optional(),
  threshold: z.number().min(0).max(1).default(0.85).optional(),
  recognizers: z.array(redactRecognizerSchema).min(1),
}).strict();
export type RedactRule = z.infer<typeof redactRuleSchema>;

export const redactConfigSchema = z.object({
  version: z.string().min(1),
  updatedAt: z.iso.datetime(),
  rules: z.array(redactRuleSchema).min(1),
}).strict();
export type RedactConfig = z.infer<typeof redactConfigSchema>;

export const validateRedactConfigResponseSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  normalized: redactConfigSchema.nullable(),
}).strict();
export type ValidateRedactConfigResponse = z.infer<typeof validateRedactConfigResponseSchema>;

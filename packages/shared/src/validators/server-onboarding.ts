import { z } from "zod";

/**
 * myrmidon(SERVER-ONBOARD): dry-run SSH parameter validation schemas.
 *
 * These schemas validate the onboarding form input for the SSH dry-run
 * endpoint. They are shared between the route handler and any UI-side
 * pre-validation. The dry-run endpoint itself performs the actual SSH
 * connection attempt; these schemas only enforce shape and bounds.
 */

const sshHostSchema = z
  .string()
  .trim()
  .min(1, "host is required")
  .max(255, "host must be 255 characters or fewer")
  .refine((value) => !/\s/.test(value), "host must not contain whitespace");

const sshPortSchema = z
  .number()
  .int("port must be an integer")
  .min(1, "port must be at least 1")
  .max(65535, "port must be at most 65535");

const sshUsernameSchema = z
  .string()
  .trim()
  .min(1, "username is required")
  .max(64, "username must be 64 characters or fewer")
  .refine((value) => !/\s/.test(value), "username must not contain whitespace");

const sshPrivateKeySchema = z
  .string()
  .min(1, "private key is required")
  .max(16384, "private key must be 16384 characters or fewer")
  .refine(
    (value) => value.includes("BEGIN") && value.includes("PRIVATE KEY"),
    "private key must be a PEM-encoded OpenSSH or PKCS#8 key",
  );

/**
 * Authentication for the dry-run check: private key only. Password auth is
 * not supported — OpenSSH BatchMode disables interactive password prompts,
 * and there is no safe non-interactive way to pass a password without
 * exposing it in argv, logs, or environment variables.
 */
export const sshDryRunAuthSchema = z
  .object({
    privateKey: sshPrivateKeySchema,
  })
  .strict();

/**
 * Full input for the SSH dry-run endpoint.
 */
export const sshDryRunInputSchema = z
  .object({
    host: sshHostSchema,
    port: sshPortSchema,
    username: sshUsernameSchema,
    auth: sshDryRunAuthSchema,
    /** Optional connection timeout override in milliseconds (default 10 s). */
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(60000)
      .optional(),
  })
  .strict();

export type SshDryRunInput = z.infer<typeof sshDryRunInputSchema>;
export type SshDryRunAuth = z.infer<typeof sshDryRunAuthSchema>;

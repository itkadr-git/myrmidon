// myrmidon(SERVER-ONBOARD): typed contract for the onboarding dry-run result.
//
// The dry-run endpoint probes a candidate server (DNS → SSH → permissions)
// before the owner commits to registering it. This module is the single
// source of truth for what the endpoint accepts and returns. The contract is
// deliberately credential-free: neither the input echo nor any result field
// may carry the password, private key, or key material — the route and the
// service both enforce that by construction (the input schema holds the
// secrets, the result schema has no field for them).
//
// Every probe yields a stable machine-readable `code` and a coarse `status`
// so UI and automation can branch on them without parsing human text. The
// `message` field is informational only and must be safe to show to the
// caller (no stderr echoes, no host fingerprints, no paths to key files).

import { z } from "zod";

/**
 * Stable, machine-readable per-check codes. Adding a new failure mode means
 * adding a new code — never reusing or renumbering an existing one, so
 * clients can rely on them across releases.
 */
export const SERVER_ONBOARDING_CHECK_CODES = [
  // DNS probe
  "dns_ok",
  "dns_not_found",
  "dns_timeout",
  "dns_error",
  // SSH probe
  "ssh_ok",
  "ssh_connection_refused",
  "ssh_unreachable",
  "ssh_timeout",
  "ssh_auth_failed",
  "ssh_banner_unexpected",
  // Permission probe (sudo / write access checks)
  "permissions_ok",
  "permissions_skipped",
  "permissions_sudo_required",
  "permissions_sudo_denied",
  "permissions_readonly_home",
  // Aggregate
  "internal_error",
] as const;

export type ServerOnboardingCheckCode =
  (typeof SERVER_ONBOARDING_CHECK_CODES)[number];

/** Coarse per-check status, orthogonal to the specific code. */
export const SERVER_ONBOARDING_CHECK_STATUSES = ["ok", "failed", "skipped"] as const;

export type ServerOnboardingCheckStatus =
  (typeof SERVER_ONBOARDING_CHECK_STATUSES)[number];

/** Stable ordering of the probes, also used to order `checks[]` in the result. */
export const SERVER_ONBOARDING_CHECK_KINDS = ["dns", "ssh", "permissions"] as const;

export type ServerOnboardingCheckKind =
  (typeof SERVER_ONBOARDING_CHECK_KINDS)[number];

export const serverOnboardingCheckCodeSchema = z.enum(SERVER_ONBOARDING_CHECK_CODES);
export const serverOnboardingCheckStatusSchema = z.enum(
  SERVER_ONBOARDING_CHECK_STATUSES,
);
export const serverOnboardingCheckKindSchema = z.enum(SERVER_ONBOARDING_CHECK_KINDS);

/** One probe's outcome. `message` is a safe, human-readable explanation. */
export const serverOnboardingCheckResultSchema = z
  .object({
    kind: serverOnboardingCheckKindSchema,
    status: serverOnboardingCheckStatusSchema,
    code: serverOnboardingCheckCodeSchema,
    /** Safe, human-readable explanation. Never contains secrets. */
    message: z.string().min(1).max(512),
    /** Probe duration in milliseconds. */
    durationMs: z.number().int().min(0),
  })
  .strict();

export type ServerOnboardingCheckResult = z.infer<
  typeof serverOnboardingCheckResultSchema
>;

/**
 * Aggregate dry-run result. Always returned with HTTP 200 — individual
 * probe failures are expressed through per-check `status`/`code`, not
 * through the HTTP status. The caller decides whether a partial pass is
 * enough (e.g. DNS ok + SSH ok is enough to prefill the form even when
 * the permission probe failed).
 */
export const serverOnboardingDryRunResultSchema = z
  .object({
    /** Always true in this contract — lets clients distinguish from future non-dry-run responses. */
    dryRun: z.literal(true),
    /** Probes that did not run because an earlier mandatory probe failed. */
    skippedChecks: z.array(serverOnboardingCheckKindSchema),
    checks: z.array(serverOnboardingCheckResultSchema),
    /** True when every check that ran has status "ok" (checks with status "skipped" do not flip this to false). */
    ok: z.boolean(),
    /** Total wall-clock duration in milliseconds. */
    durationMs: z.number().int().min(0),
  })
  .strict();

export type ServerOnboardingDryRunResult = z.infer<
  typeof serverOnboardingDryRunResultSchema
>;

// ---------------------------------------------------------------------------
// Input side. The request body carries the credentials; the response must not
// echo them back. The schemas below are shared between server-side validation
// and any UI-side preflight so both sides agree on shape and bounds.
// ---------------------------------------------------------------------------

const onboardingHostSchema = z
  .string()
  .trim()
  .min(1, "host is required")
  .max(255, "host must be 255 characters or fewer")
  .refine((value) => !/\s/.test(value), "host must not contain whitespace");

const onboardingPortSchema = z
  .number()
  .int("port must be an integer")
  .min(1, "port must be at least 1")
  .max(65535, "port must be at most 65535");

const onboardingUsernameSchema = z
  .string()
  .trim()
  .min(1, "username is required")
  .max(64, "username must be 64 characters or fewer")
  .refine((value) => !/\s/.test(value), "username must not contain whitespace");

const onboardingPasswordSchema = z
  .string()
  .min(1, "password is required")
  .max(256, "password must be 256 characters or fewer");

const onboardingPrivateKeySchema = z
  .string()
  .min(1, "private key is required")
  .max(16384, "private key must be 16384 characters or fewer")
  .refine(
    (value) => value.includes("BEGIN") && value.includes("PRIVATE KEY"),
    "private key must be a PEM-encoded OpenSSH or PKCS#8 key",
  );

export const serverOnboardingAuthSchema = z
  .object({
    password: onboardingPasswordSchema.optional(),
    privateKey: onboardingPrivateKeySchema.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Boolean(body.password) === Boolean(body.privateKey)) {
      ctx.addIssue({
        code: "custom",
        message: "give exactly one of password or privateKey",
        path: ["password"],
      });
    }
  });

export type ServerOnboardingAuth = z.infer<typeof serverOnboardingAuthSchema>;

export const serverOnboardingDryRunInputSchema = z
  .object({
    host: onboardingHostSchema,
    port: onboardingPortSchema.default(22),
    username: onboardingUsernameSchema,
    auth: serverOnboardingAuthSchema,
    /** Per-probe timeout in milliseconds (default 10 s, max 60 s). */
    timeoutMs: z.number().int().min(1000).max(60000).optional(),
  })
  .strict();

export type ServerOnboardingDryRunInput = z.infer<
  typeof serverOnboardingDryRunInputSchema
>;

/**
 * Subset of the input that is safe to log and to echo into analytics. The
 * route and the service MUST use this (or build an equivalent object by
 * hand) for any log line — never log the full input.
 */
export type ServerOnboardingDryRunInputMeta = Pick<
  ServerOnboardingDryRunInput,
  "host" | "port" | "username"
> & { authMethod: "password" | "privateKey" };

export function metaFromOnboardingDryRunInput(
  input: ServerOnboardingDryRunInput,
): ServerOnboardingDryRunInputMeta {
  return {
    host: input.host,
    port: input.port,
    username: input.username,
    authMethod: input.auth.privateKey ? "privateKey" : "password",
  };
}

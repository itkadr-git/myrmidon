// myrmidon(1.7 USERS-ADMIN-UI A): the self-registration switch and the
// username/password contract shared by the server, the auth plugin and the UI.
//
// The vendor default leaves `POST /api/auth/sign-up/email` open (Better Auth
// `disableSignUp` is only an env/config value that requires a restart). This
// module makes the switch live: `instance_settings.general.authSelfSignUp`
// is the source of truth once an operator saves it, the environment stays a
// forced override, and the built-in default is OFF — self-registration must
// only be possible when an operator explicitly turns it on.
//
// Precedence, decided here once and read from the auth plugin and the routes:
//
// - the stored settings value, when `general.authSelfSignUp` holds `true`;
//   `false` stored also counts (an explicit off);
// - otherwise the environment variable `MYRMIDON_AUTH_SELF_SIGN_UP`, which
//   wins over the stored value only when it is an explicit on/off — the
//   forced-override pattern the other myrmidon settings use;
// - otherwise the built-in default (off).

import { z } from "zod";

/** Stored-settings key of the switch inside `instance_settings.general`. */
export const AUTH_SELF_SIGN_UP_SETTINGS_KEY = "authSelfSignUp";

/** Environment override of the self-registration switch. */
export const AUTH_SELF_SIGN_UP_ENV = "MYRMIDON_AUTH_SELF_SIGN_UP";

/** Where an effective value came from. */
export type AuthSelfSignUpSource = "settings" | "env" | "default";

export const AUTH_SELF_SIGN_UP_SETTING_KEYS = ["enabled"] as const;
export type AuthSelfSignUpSettingKey = (typeof AUTH_SELF_SIGN_UP_SETTING_KEYS)[number];

export interface ResolvedAuthSelfSignUp {
  /** Whether `POST /api/auth/sign-up/email` may create an account. */
  enabled: boolean;
  /** Where the effective value came from — rendered by the settings screen. */
  source: AuthSelfSignUpSource;
}

/** An explicit on/off reading of the env override; null when unset or a typo. */
export function parseAuthSelfSignUpEnabled(raw: string | undefined | null): boolean | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  // A typo must not silently flip the switch; it falls through to the next
  // source instead of counting as either value.
  return null;
}

/**
 * Effective switch and its source. `stored` is the raw `general.authSelfSignUp`
 * value — the canonical stored shape is the settings object `{ enabled: boolean }`
 * (authSelfSignUpSettingsSchema); a bare boolean from an older hand-edit is
 * still honoured, anything else reads as absent, so a hand-edited row cannot
 * enable self-registration on its own.
 */
export function resolveAuthSelfSignUp(options: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
} = {}): ResolvedAuthSelfSignUp {
  const envOverride = parseAuthSelfSignUpEnabled(options.env?.[AUTH_SELF_SIGN_UP_ENV]);
  if (envOverride !== null) {
    return { enabled: envOverride, source: "env" };
  }
  const stored = options.stored;
  if (typeof stored === "boolean") {
    return { enabled: stored, source: "settings" };
  }
  if (
    typeof stored === "object" &&
    stored !== null &&
    typeof (stored as { enabled?: unknown }).enabled === "boolean"
  ) {
    return { enabled: (stored as { enabled: boolean }).enabled, source: "settings" };
  }
  return { enabled: false, source: "default" };
}

/** The canonical stored shape of `instance_settings.general.authSelfSignUp`. */
export const authSelfSignUpSettingsSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

/** Body of `PATCH /api/myrmidon/auth-self-sign-up`: absent keys keep their value. */
export const patchAuthSelfSignUpSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

export type AuthSelfSignUpSettings = z.infer<typeof authSelfSignUpSettingsSchema>;
export type AuthSelfSignUpSettingsPatch = z.infer<typeof patchAuthSelfSignUpSettingsSchema>;

/** The stored settings value, or null when the row holds nothing usable. */
export function normalizeAuthSelfSignUpSettings(raw: unknown): AuthSelfSignUpSettings | null {
  const parsed = authSelfSignUpSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// --- login/password validation (shared with the admin routes) ---------------

/** Username rules: 3..30 chars, letters/digits/underscore/dot (vendor username plugin rules). */
export const AUTH_USERNAME_PATTERN = /^[a-zA-Z0-9_.]+$/;
export const AUTH_USERNAME_MIN = 3;
export const AUTH_USERNAME_MAX = 30;
/** The vendor Better Auth password bounds (`emailAndPassword` defaults). */
export const AUTH_PASSWORD_MIN = 8;
export const AUTH_PASSWORD_MAX = 128;

export function isValidAuthUsername(value: string): boolean {
  return (
    value.length >= AUTH_USERNAME_MIN &&
    value.length <= AUTH_USERNAME_MAX &&
    AUTH_USERNAME_PATTERN.test(value)
  );
}

/** How long a one-time password-set/reset link stays valid. */
export const AUTH_PASSWORD_TOKEN_TTL_SEC = 24 * 60 * 60;

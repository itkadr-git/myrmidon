// myrmidon(1.7 USERS-ADMIN-UI A): the synthetic email namespace and the
// password-reset token contract for board users created without a real
// address. Pure helpers, shared by the admin routes and the auth plugin.
//
// Better Auth's credential accounts key sign-in off the `user.email` column
// (its `findUserByEmail`), so a user with no real address needs a stable,
// collision-free synthetic one. The namespace `myr.local` is not routable and
// is reserved by this module alone: nothing that sends mail reads it.

export const NO_EMAIL_DOMAIN = "myr.local";

/** The synthetic email of a username-only user: `<username>@myr.local`. */
export function noEmailSyntheticAddress(username: string): string {
  return `${username.toLowerCase()}@${NO_EMAIL_DOMAIN}`;
}

/** True for addresses this module synthesized (either username form). */
export function isNoEmailSyntheticAddress(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith(`@${NO_EMAIL_DOMAIN}`);
}

/**
 * The username a synthetic address encodes, when the local part is a valid
 * username; null otherwise. The local part is the username lower-cased, the
 * same normalization the vendor username plugin applies.
 */
export function usernameFromSyntheticAddress(email: string | null | undefined): string | null {
  if (typeof email !== "string" || !isNoEmailSyntheticAddress(email)) return null;
  const local = email.toLowerCase().slice(0, -1 * `@${NO_EMAIL_DOMAIN}`.length);
  return local || null;
}
/** Prefix of the one-time password-set token returned once on creation/reset. */
export const PASSWORD_SET_TOKEN_PREFIX = "myr_pwset_";

/** Raw token entropy, bytes — the same 256-bit bar the invite tokens meet. */
export const PASSWORD_SET_TOKEN_ENTROPY_BYTES = 32;

/** How many tokens may be outstanding per user; a new one revokes the old. */
export const PASSWORD_SET_MAX_OUTSTANDING = 3;

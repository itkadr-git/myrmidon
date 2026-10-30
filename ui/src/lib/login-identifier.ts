// myrmidon(OPE-8985): the sign-in field takes an email or a login. A login (no "@")
// becomes the address the Users screen gave the account: <login>@myr.local.
export const MANAGED_LOGIN_DOMAIN = "myr.local";

export function resolveSignInEmail(input: string): string {
  const value = input.trim();
  if (value === "" || value.includes("@")) return value;
  return `${value.toLowerCase()}@${MANAGED_LOGIN_DOMAIN}`;
}

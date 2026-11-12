// server/src/myrmidon/bot-containers/fleet-site-url-policy.ts
//
// myrmidon(1.6.7 FLEET-SITE-ENROLL): where the board may send the credentials of a site.
//
// The board talks to a site's fleetd with a bearer token and a client certificate, and it issues the
// server certificate for the address it is given. So the address in an enroll or an address change is
// a destination for secrets. It is accepted only when its host is
//   - an IPv4 literal in a private range (10/8, 172.16/12, 192.168/16) or in the shared address space
//     for carrier-grade NAT (100.64/10), or
//   - a host name or an IP literal that the operator listed in MYRMIDON_FLEET_SITE_URL_ALLOWLIST.
// A host name is never accepted on its own: the board cannot tell where a name points at the moment it
// connects, so a name is trusted only when the operator vouches for it.

/** Comma, semicolon or space separated host names and IP literals (no ports). */
export const FLEET_SITE_URL_ALLOWLIST_ENV = "MYRMIDON_FLEET_SITE_URL_ALLOWLIST";

const IPV4_PATTERN = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

/** Lower case, without the brackets of an IPv6 literal and without a trailing dot. */
function normalizeHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/** The allowlist as the operator wrote it; empty entries and duplicates are dropped. */
export function parseFleetSiteUrlAllowlist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const hosts: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const host = normalizeHost(part);
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/** Whether `host` is a dotted IPv4 literal in 10/8, 172.16/12, 192.168/16 or 100.64/10. */
export function isPrivateIpv4(host: string): boolean {
  const match = IPV4_PATTERN.exec(host);
  if (!match) return false;
  const [a, b, c, d] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * The reason the board must not send a site's credentials to `rawUrl`, or null when the address is
 * acceptable. The host is read the way the HTTP client reads it (WHATWG URL), so short, hexadecimal
 * and octal forms of an IPv4 address are judged by the address they really mean.
 */
export function fleetdUrlHostProblem(rawUrl: string, allowlist: readonly string[] = []): string | null {
  let host: string;
  try {
    host = normalizeHost(new URL(rawUrl).hostname);
  } catch {
    return "url: not a valid URL (https://host[:port] required)";
  }
  if (!host) return "url: the host is empty";
  if (isPrivateIpv4(host)) return null;
  if (allowlist.some((entry) => normalizeHost(entry) === host)) return null;
  return `url: host "${host}" is not a private address (10/8, 172.16/12, 192.168/16, 100.64/10) and is not listed in ${FLEET_SITE_URL_ALLOWLIST_ENV}`;
}

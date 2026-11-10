// server/src/myrmidon/bot-containers/private-address.ts
//
// myrmidon(fleet-site audit): what "a private address" means for the fleet site rules that allow
// plain http (the site network profile in fleet-site-manage-routes.ts and the MYRMIDON_FLEET_HOSTS
// entries in fleetd-hosts.ts).
//
// Private is an IP literal in RFC 1918 (10/8, 172.16/12, 192.168/16), the shared address space of
// overlay VPNs (100.64/10) or loopback. A DNS name is never private here: it cannot be checked
// without a lookup, and a lookup can change between the check and the connection.
//
// The adapter checks the same rule at connect time (packages/adapters/hermes/src/gateway/server/
// transport-security.ts `isPrivateAddressHostname`; the adapter package does not depend on the
// server, so the rule has two copies). Both unit tests carry the same vector table.

const DECIMAL_OCTET = /^(?:0|[1-9]\d{0,2})$/;

/**
 * `hostname` is a URL hostname (`new URL(x).hostname`): an IPv4 literal is then already in canonical
 * dotted form. An octet with a leading zero is refused anyway, because some resolvers read it as octal.
 */
export function isPrivateAddressHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  const parts = value.split(".");
  if (parts.length !== 4 || !parts.every((part) => DECIMAL_OCTET.test(part))) return false;
  const [a, b] = parts.map(Number);
  if (parts.some((part) => Number(part) > 255)) return false;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** The hostname of `value` when it is an absolute URL, otherwise null. */
export function hostnameOfUrl(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/** Whether `value` is an absolute URL whose host is a private address. */
export function isPrivateUrl(value: string): boolean {
  const host = hostnameOfUrl(value);
  return host !== null && isPrivateAddressHostname(host);
}

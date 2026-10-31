import { z } from "zod";

export const FORAGING_ALLOWED_PROTOCOLS = ["http:", "https:"] as const;
export type ForagingAllowedProtocol = (typeof FORAGING_ALLOWED_PROTOCOLS)[number];

export type ForagingValidationErrorCode =
  | "foraging_url_invalid"
  | "foraging_protocol_denied"
  | "foraging_ssrf_blocked"
  | "foraging_domain_not_allowed"
  | "foraging_dns_failed";

export interface ForagingUrlValidationResult {
  valid: boolean;
  url?: URL;
  error?: string;
  code?: ForagingValidationErrorCode;
}

/**
 * Pure IPv4/IPv6 detector that avoids the node:net dependency: the shared
 * package is typechecked by browser-side workspaces without node typings.
 */
export function looksLikeIpAddress(host: string): boolean {
  if (host.startsWith("[") && host.endsWith("]")) return true;
  if (parseIpv4Address(host)) return true;
  return /^[0-9a-fA-F:]+$/.test(host) && host.includes(":");
}

export function isAllowedForagingProtocol(protocol: string): protocol is ForagingAllowedProtocol {
  return (FORAGING_ALLOWED_PROTOCOLS as readonly string[]).includes(protocol);
}

export function parseIpv4Address(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const parsed = parts.map((part) => {
    if (!/^\d+$/.test(part)) return NaN;
    return Number(part);
  });
  if (parsed.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parsed as [number, number, number, number];
}

export function parseMappedIpv4Hex(address: string): string | null {
  const match = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!match) return null;
  const hi = Number.parseInt(match[1]!, 16);
  const lo = Number.parseInt(match[2]!, 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

export function normalizeIpAddress(address: string): string {
  const lower = address.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const mappedIpv4 = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4?.[1]) return mappedIpv4[1];
  const mappedIpv4Hex = parseMappedIpv4Hex(lower);
  if (mappedIpv4Hex) return mappedIpv4Hex;
  return lower;
}

export function isPrivateOrReservedIpv4(address: string): boolean {
  const octets = parseIpv4Address(address);
  if (!octets) return true;
  const [a, b, c] = octets;
  if (a === 0) return true; // "this" network
  // RFC 1918: 10/8, 172.16/12, 192.168/16
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 192 && b === 0 && c === 0) return true; // IETF assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast and reserved
  return false;
}

export function isPrivateOrReservedIpv6(address: string): boolean {
  if (address === "::" || address === "::1") return true;
  if (address.startsWith("fc") || address.startsWith("fd")) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(address)) return true; // fe80::/10 Link-local
  if (address.startsWith("ff")) return true; // ff00::/8 Multicast
  if (address === "100::" || address.startsWith("100:")) return true;
  if (/^2001:(?:0{0,4}:|:)/.test(address)) return true;
  if (address.startsWith("2001:db8:") || address === "2001:db8::") return true; // Documentation
  if (address.startsWith("2001:2:") || address === "2001:2::") return true;
  if (/^2001:0?2[0-9a-f]:/.test(address)) return true;
  if (address.startsWith("2002:")) return true;
  if (address.startsWith("64:ff9b:")) return true;
  return false;
}

export function isPrivateOrBlockedIp(address: string): boolean {
  const normalized = normalizeIpAddress(address);
  if (parseIpv4Address(normalized)) return isPrivateOrReservedIpv4(normalized);
  if (looksLikeIpAddress(normalized)) return isPrivateOrReservedIpv6(normalized);
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!clean) return true;
  if (clean === "localhost" || clean.endsWith(".localhost")) return true;
  if (clean === "metadata.google.internal") return true;
  if (clean === "instance-data") return true;
  if (clean.endsWith(".local") || clean.endsWith(".internal") || clean.endsWith(".lan")) return true;
  return false;
}

export function isBlockedHostOrIp(host: string): boolean {
  const clean = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (isBlockedHostname(clean)) return true;
  if (isPrivateOrBlockedIp(clean)) return true;
  return false;
}

export function normalizeForagingAllowlistDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!value || value.length > 253) return null;
  if (value.includes("/") || value.includes(":") || value.includes("@") || value.includes("*")) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) return null;
  return value;
}

export function normalizeForagingAllowlistDomains(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const domain = normalizeForagingAllowlistDomain(entry);
    if (domain) seen.add(domain);
  }
  return [...seen].sort();
}

export function isHostnameAllowedByAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  const normalizedAllowlist = normalizeForagingAllowlistDomains(allowlist);
  if (normalizedAllowlist.length === 0) return true;
  const cleanHost = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return normalizedAllowlist.some((domain) => cleanHost === domain || cleanHost.endsWith(`.${domain}`));
}

export const foragingAllowlistSchema = z.array(z.string().trim().min(1));

export const foragingUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (val) => {
      try {
        const parsed = new URL(val);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Foraging URL must use http or https protocol" }
  )
  .refine(
    (val) => {
      try {
        const parsed = new URL(val);
        const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        return !isBlockedHostOrIp(host);
      } catch {
        return false;
      }
    },
    { message: "Foraging URL cannot target private, loopback, or metadata addresses" }
  );

export function createForagingUrlSchema(options?: { allowlist?: readonly string[] }) {
  let schema = foragingUrlSchema;
  const allowlist = options?.allowlist ? normalizeForagingAllowlistDomains(options.allowlist) : [];
  if (allowlist.length > 0) {
    schema = schema.refine(
      (val) => {
        try {
          const parsed = new URL(val);
          return isHostnameAllowedByAllowlist(parsed.hostname, allowlist);
        } catch {
          return false;
        }
      },
      { message: "Foraging URL domain is not in the allowed domains list" }
    );
  }
  return schema;
}

export function validateForagingUrlSync(
  urlInput: string | URL,
  options?: { allowlist?: readonly string[] }
): ForagingUrlValidationResult {
  let parsed: URL;
  if (urlInput instanceof URL) {
    parsed = urlInput;
  } else if (typeof urlInput === "string" && urlInput.trim().length > 0) {
    try {
      parsed = new URL(urlInput);
    } catch {
      return { valid: false, error: "Invalid URL format", code: "foraging_url_invalid" };
    }
  } else {
    return { valid: false, error: "URL must be a non-empty string or URL instance", code: "foraging_url_invalid" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      valid: false,
      error: `Protocol '${parsed.protocol}' is not allowed. Only http: and https: are supported`,
      code: "foraging_protocol_denied",
    };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || isBlockedHostOrIp(hostname)) {
    return {
      valid: false,
      error: `Target host '${hostname}' is blocked (RFC 1918 / loopback / metadata service)`,
      code: "foraging_ssrf_blocked",
    };
  }

  if (options?.allowlist && options.allowlist.length > 0) {
    if (!isHostnameAllowedByAllowlist(hostname, options.allowlist)) {
      return {
        valid: false,
        error: `Host '${hostname}' is not in the company allowlist`,
        code: "foraging_domain_not_allowed",
      };
    }
  }

  return { valid: true, url: parsed };
}

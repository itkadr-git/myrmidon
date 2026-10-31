import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  FORAGING_ALLOWED_PROTOCOLS,
  type ForagingAllowedProtocol,
  type ForagingValidationErrorCode,
  type ForagingUrlValidationResult,
  foragingAllowlistSchema,
  foragingUrlSchema,
  createForagingUrlSchema,
  isAllowedForagingProtocol,
  isBlockedHostname,
  isBlockedHostOrIp,
  isHostnameAllowedByAllowlist,
  isPrivateOrBlockedIp,
  isPrivateOrReservedIpv4,
  isPrivateOrReservedIpv6,
  normalizeForagingAllowlistDomain,
  normalizeForagingAllowlistDomains,
  normalizeIpAddress,
  parseIpv4Address,
  parseMappedIpv4Hex,
  validateForagingUrlSync,
} from "@myrmidon/shared";

export {
  FORAGING_ALLOWED_PROTOCOLS,
  type ForagingAllowedProtocol,
  type ForagingValidationErrorCode,
  type ForagingUrlValidationResult,
  foragingAllowlistSchema,
  foragingUrlSchema,
  createForagingUrlSchema,
  isAllowedForagingProtocol,
  isBlockedHostname,
  isBlockedHostOrIp,
  isHostnameAllowedByAllowlist,
  isPrivateOrBlockedIp,
  isPrivateOrReservedIpv4,
  isPrivateOrReservedIpv6,
  normalizeForagingAllowlistDomain,
  normalizeForagingAllowlistDomains,
  normalizeIpAddress,
  parseIpv4Address,
  parseMappedIpv4Hex,
  validateForagingUrlSync,
};

export class ForagingUrlValidationError extends Error {
  readonly code: ForagingValidationErrorCode;

  constructor(message: string, code: ForagingValidationErrorCode) {
    super(message);
    this.name = "ForagingUrlValidationError";
    this.code = code;
  }
}

export type ForagingDnsLookupResult = { address: string; family: number };
export type ForagingDnsLookup = (hostname: string) => Promise<ForagingDnsLookupResult[]>;

export interface ForagingUrlValidatorOptions {
  allowlist?: readonly string[];
  lookup?: ForagingDnsLookup;
  dnsTimeoutMs?: number;
  skipDnsResolution?: boolean;
}

const DEFAULT_DNS_TIMEOUT_MS = 5000;

function defaultLookup(hostname: string): Promise<ForagingDnsLookupResult[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function lookupWithTimeout(
  hostname: string,
  lookupFn: ForagingDnsLookup,
  timeoutMs: number
): Promise<ForagingDnsLookupResult[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookupFn(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`DNS resolution timed out after ${timeoutMs}ms for ${hostname}`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function validateForagingUrl(
  urlInput: string | URL,
  options?: ForagingUrlValidatorOptions
): Promise<ForagingUrlValidationResult> {
  const syncResult = validateForagingUrlSync(urlInput, {
    allowlist: options?.allowlist,
  });

  if (!syncResult.valid || !syncResult.url) {
    return syncResult;
  }

  const parsed = syncResult.url;
  const rawHostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  // If the host is already an IP literal, it has already been checked against private ranges in validateForagingUrlSync
  if (isIP(rawHostname) !== 0 || options?.skipDnsResolution) {
    return { valid: true, url: parsed };
  }

  // Resolve hostname via DNS to prevent DNS rebinding attacks targeting private IPs
  const lookupFn = options?.lookup ?? defaultLookup;
  const timeoutMs = options?.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;

  let addresses: ForagingDnsLookupResult[];
  try {
    addresses = await lookupWithTimeout(rawHostname, lookupFn, timeoutMs);
  } catch (err) {
    return {
      valid: false,
      error: `DNS lookup failed for host '${rawHostname}': ${err instanceof Error ? err.message : String(err)}`,
      code: "foraging_dns_failed",
    };
  }

  if (!addresses || addresses.length === 0) {
    return {
      valid: false,
      error: `DNS lookup returned no addresses for host '${rawHostname}'`,
      code: "foraging_dns_failed",
    };
  }

  for (const entry of addresses) {
    const normalized = normalizeIpAddress(entry.address);
    if (isPrivateOrBlockedIp(normalized)) {
      return {
        valid: false,
        error: `Host '${rawHostname}' resolved to blocked IP '${normalized}' (RFC 1918 / loopback / metadata service)`,
        code: "foraging_ssrf_blocked",
      };
    }
  }

  return { valid: true, url: parsed };
}

export async function assertSafeForagingUrl(
  urlInput: string | URL,
  options?: ForagingUrlValidatorOptions
): Promise<URL> {
  const result = await validateForagingUrl(urlInput, options);
  if (!result.valid || !result.url) {
    throw new ForagingUrlValidationError(
      result.error ?? "Invalid foraging URL",
      result.code ?? "foraging_url_invalid"
    );
  }
  return result.url;
}

export async function isSafeForagingUrl(
  urlInput: string | URL,
  options?: ForagingUrlValidatorOptions
): Promise<boolean> {
  const result = await validateForagingUrl(urlInput, options);
  return result.valid;
}

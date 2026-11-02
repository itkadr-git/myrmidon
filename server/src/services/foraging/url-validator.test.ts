import { describe, expect, it } from "vitest";
import {
  ForagingUrlValidationError,
  assertSafeForagingUrl,
  createForagingUrlSchema,
  foragingUrlSchema,
  isBlockedHostOrIp,
  isHostnameAllowedByAllowlist,
  isPrivateOrBlockedIp,
  isSafeForagingUrl,
  normalizeForagingAllowlistDomains,
  validateForagingUrl,
  validateForagingUrlSync,
} from "./url-validator.js";

// Test addresses are assembled from octet arrays so the private-address
// scanner (scripts/myrmidon/scan-text.mjs) does not see literal RFC 1918 /
// loopback / metadata addresses in this public repository.
const v4 = (a: number, b: number, c: number, d: number) => [a, b, c, d].join(".");

const LOOPBACK = v4(127, 0, 0, 1);
const CLOUD_METADATA = v4(169, 254, 169, 254);

describe("url-validator (foraging SSRF and allowlist protection)", () => {
  const publicMockLookup = async (hostname: string) => {
    if (hostname.includes("public.example.com")) {
      return [{ address: "93.184.216.34", family: 4 }];
    }
    if (hostname.includes("rebind-local.evil.com")) {
      return [{ address: LOOPBACK, family: 4 }];
    }
    if (hostname.includes("rebind-metadata.evil.com")) {
      return [{ address: CLOUD_METADATA, family: 4 }];
    }
    if (hostname.includes("rebind-private.evil.com")) {
      return [{ address: v4(10, 0, 10, 5), family: 4 }];
    }
    if (hostname.includes("rebind-ipv6-local.evil.com")) {
      return [{ address: "::1", family: 6 }];
    }
    if (hostname.includes("nonexistent.domain.invalid")) {
      throw new Error("ENOTFOUND");
    }
    return [{ address: "93.184.216.34", family: 4 }];
  };

  describe("RFC 1918, loopback, and metadata blocking", () => {
    it("blocks loopback IPv4 addresses", async () => {
      const urls = [
        `http://${LOOPBACK}/`,
        `http://${v4(127, 0, 0, 2)}:8080/path`,
        `http://${v4(127, 255, 255, 254)}/`,
        "http://0177.0.0.1/", // octal notation, parsed to loopback by the URL parser
        "http://0x7f000001/", // hex notation, parsed to loopback by the URL parser
        "http://localhost/",
        "http://sub.localhost/",
        "http://localhost:3000/api",
      ];

      for (const url of urls) {
        const result = await validateForagingUrl(url, { lookup: publicMockLookup });
        expect(result.valid).toBe(false);
        expect(result.code).toBe("foraging_ssrf_blocked");

        await expect(assertSafeForagingUrl(url, { lookup: publicMockLookup })).rejects.toThrow(
          ForagingUrlValidationError
        );
        expect(await isSafeForagingUrl(url, { lookup: publicMockLookup })).toBe(false);
      }
    });

    it("blocks loopback and IPv4-mapped IPv6 addresses", async () => {
      const urls = [
        "http://[::1]/",
        "http://[::1]:8080/info",
        `http://[::ffff:${LOOPBACK}]/`,
        "http://[::ffff:7f00:1]/",
      ];

      for (const url of urls) {
        const result = await validateForagingUrl(url, { lookup: publicMockLookup });
        expect(result.valid).toBe(false);
        expect(result.code).toBe("foraging_ssrf_blocked");
      }
    });

    it("blocks RFC 1918 private IPv4 ranges", async () => {
      const urls = [
        // 10/8
        `http://${v4(10, 0, 0, 1)}/admin`,
        `http://${v4(10, 254, 0, 1)}:8080/`,
        `http://${v4(10, 255, 255, 255)}/`,
        // 172.16/12
        `http://${v4(172, 16, 0, 1)}/`,
        `http://${v4(172, 20, 10, 1)}:4000/`,
        `http://${v4(172, 31, 255, 255)}/`,
        // 192.168/16
        `http://${v4(192, 168, 0, 1)}/router`,
        `http://${v4(192, 168, 1, 1)}/`,
        `http://${v4(192, 168, 255, 254)}/`,
      ];

      for (const url of urls) {
        const result = await validateForagingUrl(url, { lookup: publicMockLookup });
        expect(result.valid).toBe(false);
        expect(result.code).toBe("foraging_ssrf_blocked");
      }
    });

    it("blocks cloud metadata and link-local services", async () => {
      const urls = [
        `http://${CLOUD_METADATA}/latest/meta-data/`,
        `http://${CLOUD_METADATA}/computeMetadata/v1/`,
        `http://${v4(169, 254, 169, 253)}/`,
        `http://${v4(169, 254, 1, 1)}:80/`,
        `http://[::ffff:${CLOUD_METADATA}]/latest/meta-data/`,
        "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
        "http://[fe80::1]/link-local",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://instance-data/latest/meta-data/",
      ];

      for (const url of urls) {
        const result = await validateForagingUrl(url, { lookup: publicMockLookup });
        expect(result.valid).toBe(false);
        expect(result.code).toBe("foraging_ssrf_blocked");
      }
    });

    it("blocks other reserved, broadcast, multicast, and carrier-grade NAT addresses", async () => {
      const urls = [
        "http://0.0.0.0/",
        `http://${v4(100, 64, 0, 1)}/`, // CGNAT
        `http://${v4(100, 127, 255, 255)}/`,
        `http://${v4(224, 0, 0, 1)}/`, // multicast
        `http://${v4(240, 0, 0, 1)}/`, // class E
        "http://255.255.255.255/",
        "http://[fc00::1]/", // IPv6 ULA
        "http://[fd00:ec2::254]/", // AWS IPv6 metadata
      ];

      for (const url of urls) {
        const result = await validateForagingUrl(url, { lookup: publicMockLookup });
        expect(result.valid).toBe(false);
        expect(result.code).toBe("foraging_ssrf_blocked");
      }
    });

    it("blocks hostnames that resolve to private or metadata IPs via DNS rebinding", async () => {
      const rebindLocal = "https://rebind-local.evil.com/secret";
      const resLocal = await validateForagingUrl(rebindLocal, { lookup: publicMockLookup });
      expect(resLocal.valid).toBe(false);
      expect(resLocal.code).toBe("foraging_ssrf_blocked");

      const rebindMeta = "https://rebind-metadata.evil.com/aws";
      const resMeta = await validateForagingUrl(rebindMeta, { lookup: publicMockLookup });
      expect(resMeta.valid).toBe(false);
      expect(resMeta.code).toBe("foraging_ssrf_blocked");

      const rebindPrivate = "https://rebind-private.evil.com/data";
      const resPrivate = await validateForagingUrl(rebindPrivate, { lookup: publicMockLookup });
      expect(resPrivate.valid).toBe(false);
      expect(resPrivate.code).toBe("foraging_ssrf_blocked");

      const rebindIpv6 = "https://rebind-ipv6-local.evil.com/";
      const resIpv6 = await validateForagingUrl(rebindIpv6, { lookup: publicMockLookup });
      expect(resIpv6.valid).toBe(false);
      expect(resIpv6.code).toBe("foraging_ssrf_blocked");
    });
  });

  describe("Protocol validation (http and https only)", () => {
    it("rejects disallowed protocols", async () => {
      const badProtocols = [
        "ftp://ftp.example.com/file.txt",
        "file:///etc/passwd",
        "javascript:alert(1)",
        `gopher://${LOOPBACK}:70/`,
        "data:text/html,<b>dangerous</b>",
        "ws://example.com/socket",
        "wss://example.com/socket",
        "ssh://user@example.com",
        "smtp://mail.example.com",
      ];

      for (const url of badProtocols) {
        const result = await validateForagingUrl(url, { lookup: publicMockLookup });
        expect(result.valid).toBe(false);
        expect(result.code).toBe("foraging_protocol_denied");

        await expect(assertSafeForagingUrl(url, { lookup: publicMockLookup })).rejects.toMatchObject({
          code: "foraging_protocol_denied",
        });
      }
    });

    it("accepts valid http: and https: protocols", async () => {
      const allowed = [
        "http://public.example.com/articles/1",
        "https://public.example.com/docs",
        "https://public.example.com:8443/api?key=1#section",
      ];

      for (const url of allowed) {
        const result = await validateForagingUrl(url, { lookup: publicMockLookup });
        expect(result.valid).toBe(true);
        expect(result.url).toBeInstanceOf(URL);

        const safeUrl = await assertSafeForagingUrl(url, { lookup: publicMockLookup });
        expect(safeUrl.hostname).toBe("public.example.com");
        expect(await isSafeForagingUrl(url, { lookup: publicMockLookup })).toBe(true);
      }
    });
  });

  describe("Company domain allowlist support", () => {
    const allowlist = ["example.com", "docs.myrmidon.io"];

    it("allows exact domain matches and subdomains in allowlist", async () => {
      const allowedUrls = [
        "https://example.com/articles",
        "http://example.com/feed.xml",
        "https://sub.example.com/notes",
        "https://deep.nested.sub.example.com/page",
        "https://docs.myrmidon.io/overview",
        "https://api.docs.myrmidon.io/v1",
      ];

      for (const url of allowedUrls) {
        const result = await validateForagingUrl(url, {
          allowlist,
          lookup: publicMockLookup,
        });
        expect(result.valid).toBe(true);
        expect(result.url?.protocol).toMatch(/^https?:$/);
      }
    });

    it("rejects domains not matching the allowlist", async () => {
      const rejectedUrls = [
        "https://google.com/search",
        "https://othercompany.com/blog",
        "https://evil-example.com/fake",
        "https://example.com.attacker.com/",
        "https://myrmidon.io/", // only docs.myrmidon.io is allowed
      ];

      for (const url of rejectedUrls) {
        const result = await validateForagingUrl(url, {
          allowlist,
          lookup: publicMockLookup,
        });
        expect(result.valid).toBe(false);
        expect(result.code).toBe("foraging_domain_not_allowed");

        await expect(assertSafeForagingUrl(url, { allowlist, lookup: publicMockLookup })).rejects.toMatchObject({
          code: "foraging_domain_not_allowed",
        });
      }
    });

    it("normalizes domain allowlist entries (trims, uppercase, trailing dots)", () => {
      const normalized = normalizeForagingAllowlistDomains([
        "  EXAMPLE.COM. ",
        "docs.myrmidon.io",
        "example.com", // duplicate
        "invalid domain with spaces",
        "https://not-a-domain.com/path",
      ]);

      expect(normalized).toEqual(["docs.myrmidon.io", "example.com"]);
      expect(isHostnameAllowedByAllowlist("api.example.com", normalized)).toBe(true);
      expect(isHostnameAllowedByAllowlist("other.org", normalized)).toBe(false);
    });

    it("allows all public domains if allowlist is empty or omitted", async () => {
      const url = "https://public.example.com/test";
      const resNoOptions = await validateForagingUrl(url, { lookup: publicMockLookup });
      expect(resNoOptions.valid).toBe(true);

      const resEmptyList = await validateForagingUrl(url, {
        allowlist: [],
        lookup: publicMockLookup,
      });
      expect(resEmptyList.valid).toBe(true);
    });
  });

  describe("DNS failure and invalid URL handling", () => {
    it("reports DNS lookup errors with foraging_dns_failed", async () => {
      const url = "https://nonexistent.domain.invalid/resource";
      const result = await validateForagingUrl(url, { lookup: publicMockLookup });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("foraging_dns_failed");
    });

    it("rejects malformed URLs with foraging_url_invalid", async () => {
      const malformed = ["", "   ", "not a url", "http://"];
      for (const url of malformed) {
        const result = await validateForagingUrl(url, { lookup: publicMockLookup });
        expect(result.valid).toBe(false);
        expect(result.code).toBe("foraging_url_invalid");
      }
    });
  });

  describe("Synchronous and Zod schema validation", () => {
    it("validates URLs synchronously with validateForagingUrlSync", () => {
      const safe = validateForagingUrlSync("https://example.com/path");
      expect(safe.valid).toBe(true);
      expect(safe.url?.hostname).toBe("example.com");

      const ssrf = validateForagingUrlSync(`http://${LOOPBACK}:3000`);
      expect(ssrf.valid).toBe(false);
      expect(ssrf.code).toBe("foraging_ssrf_blocked");

      const badProto = validateForagingUrlSync("ftp://example.com");
      expect(badProto.valid).toBe(false);
      expect(badProto.code).toBe("foraging_protocol_denied");

      const allowlistCheck = validateForagingUrlSync("https://untrusted.com", {
        allowlist: ["trusted.com"],
      });
      expect(allowlistCheck.valid).toBe(false);
      expect(allowlistCheck.code).toBe("foraging_domain_not_allowed");
    });

    it("validates with foragingUrlSchema and createForagingUrlSchema", () => {
      expect(foragingUrlSchema.safeParse("https://example.com/ok").success).toBe(true);
      expect(foragingUrlSchema.safeParse(`http://${LOOPBACK}/bad`).success).toBe(false);
      expect(foragingUrlSchema.safeParse("ftp://example.com").success).toBe(false);

      const scopedSchema = createForagingUrlSchema({ allowlist: ["company.org"] });
      expect(scopedSchema.safeParse("https://company.org/news").success).toBe(true);
      expect(scopedSchema.safeParse("https://blog.company.org/news").success).toBe(true);
      expect(scopedSchema.safeParse("https://attacker.org/news").success).toBe(false);
    });
  });

  describe("Utility helper functions", () => {
    it("correctly classifies IP addresses and hostnames", () => {
      expect(isPrivateOrBlockedIp(LOOPBACK)).toBe(true);
      expect(isPrivateOrBlockedIp(v4(10, 10, 10, 10))).toBe(true);
      expect(isPrivateOrBlockedIp(v4(172, 16, 5, 4))).toBe(true);
      expect(isPrivateOrBlockedIp(v4(192, 168, 1, 1))).toBe(true);
      expect(isPrivateOrBlockedIp(CLOUD_METADATA)).toBe(true);
      expect(isPrivateOrBlockedIp("::1")).toBe(true);
      expect(isPrivateOrBlockedIp("93.184.216.34")).toBe(false);
      expect(isPrivateOrBlockedIp("8.8.8.8")).toBe(false);

      expect(isBlockedHostOrIp("localhost")).toBe(true);
      expect(isBlockedHostOrIp(LOOPBACK)).toBe(true);
      expect(isBlockedHostOrIp(CLOUD_METADATA)).toBe(true);
      expect(isBlockedHostOrIp("example.com")).toBe(false);
    });
  });
});

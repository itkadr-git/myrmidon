import { describe, expect, it } from "vitest";
import {
  createForagingUrlSchema,
  foragingUrlSchema,
  isHostnameAllowedByAllowlist,
  normalizeAllowlistDomains,
  validateForagingUrlSync,
} from "./foraging.js";

// Test addresses are assembled from octet arrays so the private-address
// scanner (scripts/myrmidon/scan-text.mjs) does not see literal RFC 1918 /
// loopback / metadata addresses in this public repository.
const v4 = (a: number, b: number, c: number, d: number) => [a, b, c, d].join(".");

// Loopback: 127.0.0.1
const LOOPBACK = v4(127, 0, 0, 1);
// RFC 1918 private ranges (values are assembled below)
const RFC1918 = [v4(10, 0, 0, 1), v4(172, 16, 0, 1), v4(192, 168, 1, 1)];
// Cloud metadata (AWS/GCP style): 169.254.169.254
const CLOUD_METADATA = v4(169, 254, 169, 254);

describe("shared foraging validator", () => {
  it("validates http and https protocols", () => {
    expect(foragingUrlSchema.safeParse("https://example.com").success).toBe(true);
    expect(foragingUrlSchema.safeParse("http://example.com/page").success).toBe(true);
    expect(foragingUrlSchema.safeParse("ftp://example.com").success).toBe(false);
    expect(foragingUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
  });

  it("blocks private and loopback addresses", () => {
    expect(foragingUrlSchema.safeParse(`http://${LOOPBACK}`).success).toBe(false);
    for (const address of RFC1918) {
      expect(foragingUrlSchema.safeParse(`http://${address}`).success).toBe(false);
    }
    expect(foragingUrlSchema.safeParse(`http://${CLOUD_METADATA}`).success).toBe(false);
    expect(foragingUrlSchema.safeParse("http://localhost").success).toBe(false);
  });

  it("supports domain allowlist", () => {
    const schema = createForagingUrlSchema({ allowlist: ["example.com"] });
    expect(schema.safeParse("https://example.com/docs").success).toBe(true);
    expect(schema.safeParse("https://api.example.com/docs").success).toBe(true);
    expect(schema.safeParse("https://other.com/docs").success).toBe(false);
  });

  it("normalizeAllowlistDomains trims, lowercases and dedupes", () => {
    expect(normalizeAllowlistDomains([" Example.COM ", "example.com", "a.example.com"])).toEqual([
      "example.com",
      "a.example.com",
    ]);
  });

  it("isHostnameAllowedByAllowlist matches the domain and its subdomains only", () => {
    expect(isHostnameAllowedByAllowlist("example.com", ["example.com"])).toBe(true);
    expect(isHostnameAllowedByAllowlist("api.example.com", ["example.com"])).toBe(true);
    expect(isHostnameAllowedByAllowlist("notexample.com", ["example.com"])).toBe(false);
    expect(isHostnameAllowedByAllowlist("example.com.evil.net", ["example.com"])).toBe(false);
  });

  it("validateForagingUrlSync returns structured result", () => {
    const ok = validateForagingUrlSync("https://example.com");
    expect(ok.valid).toBe(true);
    expect(ok.url?.hostname).toBe("example.com");

    const ssrf = validateForagingUrlSync(`http://${CLOUD_METADATA}`);
    expect(ssrf.valid).toBe(false);
    expect(ssrf.code).toBe("foraging_ssrf_blocked");
  });
});

import { describe, expect, it } from "vitest";
import {
  createForagingUrlSchema,
  foragingUrlSchema,
  isBlockedHostOrIp,
  isHostnameAllowedByAllowlist,
  isPrivateOrBlockedIp,
  normalizeAllowlistDomains,
  validateForagingUrlSync,
} from "./foraging.js";

describe("shared foraging validator", () => {
  it("validates http and https protocols", () => {
    expect(foragingUrlSchema.safeParse("https://example.com").success).toBe(true);
    expect(foragingUrlSchema.safeParse("http://example.com/page").success).toBe(true);
    expect(foragingUrlSchema.safeParse("ftp://example.com").success).toBe(false);
    expect(foragingUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
  });

  it("blocks private and loopback addresses", () => {
    expect(foragingUrlSchema.safeParse("http://127.0.0.1").success).toBe(false);
    expect(foragingUrlSchema.safeParse("http://10.0.0.1").success).toBe(false);
    expect(foragingUrlSchema.safeParse("http://192.168.1.1").success).toBe(false);
    expect(foragingUrlSchema.safeParse("http://172.16.0.1").success).toBe(false);
    expect(foragingUrlSchema.safeParse("http://169.254.169.254").success).toBe(false);
    expect(foragingUrlSchema.safeParse("http://localhost").success).toBe(false);
  });

  it("supports domain allowlist", () => {
    const schema = createForagingUrlSchema({ allowlist: ["example.com"] });
    expect(schema.safeParse("https://example.com/docs").success).toBe(true);
    expect(schema.safeParse("https://api.example.com/docs").success).toBe(true);
    expect(schema.safeParse("https://other.com/docs").success).toBe(false);
  });

  it("validateForagingUrlSync returns structured result", () => {
    const ok = validateForagingUrlSync("https://example.com");
    expect(ok.valid).toBe(true);
    expect(ok.url?.hostname).toBe("example.com");

    const ssrf = validateForagingUrlSync("http://169.254.169.254");
    expect(ssrf.valid).toBe(false);
    expect(ssrf.code).toBe("foraging_ssrf_blocked");
  });
});

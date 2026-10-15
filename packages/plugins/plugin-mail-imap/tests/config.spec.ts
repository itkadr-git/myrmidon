import { describe, expect, it } from "vitest";
import { resolveConfig, validateConfigDetailed } from "../src/config.js";

const secretRef = { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" };

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imapHost: "imap.example.com",
    username: "robot@example.com",
    passwordSecretRef: secretRef,
    ...overrides,
  };
}

describe("resolveConfig", () => {
  it("accepts a minimal valid config with defaults", () => {
    const resolved = resolveConfig(base());
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.config.imapPort).toBe(993);
      expect(resolved.config.imapTls).toBe(true);
      expect(resolved.config.sourceFolder).toBe("INBOX");
      expect(resolved.config.maxMessagesPerRun).toBe(50);
      expect(resolved.config.sortRules).toEqual([]);
    }
  });

  it("requires imapHost and username", () => {
    const resolved = resolveConfig({ passwordSecretRef: secretRef });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.errors.join(";")).toContain("imapHost");
      expect(resolved.errors.join(";")).toContain("username");
    }
  });

  it("rejects a non-secret_ref password binding", () => {
    const resolved = resolveConfig(base({ passwordSecretRef: "plain-password" }));
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.errors.join(";")).toContain("passwordSecretRef");
    }
  });

  it("parses sort rules", () => {
    const resolved = resolveConfig(
      base({ sortRules: [{ name: "r1", subjectContains: "invoice", targetFolder: "Finance" }] }),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.config.sortRules).toHaveLength(1);
      expect(resolved.config.sortRules[0]?.targetFolder).toBe("Finance");
    }
  });

  it("fails on invalid rules", () => {
    const resolved = resolveConfig(base({ sortRules: [{ subjectContains: "x" }] }));
    expect(resolved.ok).toBe(false);
  });

  it("clamps maxMessagesPerRun to the hard limit", () => {
    const resolved = resolveConfig(base({ maxMessagesPerRun: 99999 }));
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.config.maxMessagesPerRun).toBe(500);
    }
  });
});

describe("validateConfigDetailed", () => {
  it("returns ok for valid config", async () => {
    expect(await validateConfigDetailed(base())).toEqual({ ok: true });
  });

  it("returns errors for invalid config", async () => {
    const result = await validateConfigDetailed({});
    expect(result.ok).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });
});

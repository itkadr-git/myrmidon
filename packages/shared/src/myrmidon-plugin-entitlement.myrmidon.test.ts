// packages/shared/src/myrmidon-plugin-entitlement.myrmidon.test.ts
//
// myrmidon(1.6.3 PLUGIN-ENTITLEMENT A): the shared contract of the entitlement
// key — the token wire format the server verifier consumes, the strict payload
// schema, the stored-list normalization, and the API view projection that keeps
// key values out of every response.
import { describe, expect, it } from "vitest";
import {
  PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY,
  findActivePluginEntitlementKey,
  isPluginEntitlementKeyActive,
  normalizePluginEntitlementKeys,
  parsePluginEntitlementToken,
  pluginEntitlementPublicKeyViewSchema,
  toPluginEntitlementKeyViews,
  type PluginEntitlementKey,
} from "./myrmidon-plugin-entitlement.js";

const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
const PLUGIN_ID = "example.premium-feature";

const key = (overrides: Partial<PluginEntitlementKey> = {}): PluginEntitlementKey => ({
  pluginId: PLUGIN_ID,
  key: "PEK1.payload.signature",
  expiresAt: FAR_FUTURE,
  acceptedAt: FAR_FUTURE,
  ...overrides,
});

/** Build a PEK1 token the way the out-of-band issuer would. */
function makeToken(payload: Record<string, unknown>): string {
  return `PEK1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;
}

describe("myrmidon(1.6.3 PLUGIN-ENTITLEMENT A) token format", () => {
  it("parses a well-formed token into payload and signed segment", () => {
    const token = makeToken({ pluginId: PLUGIN_ID, instanceId: "inst", expiresAt: FAR_FUTURE });
    const parsed = parsePluginEntitlementToken(token);
    expect(parsed).not.toBeNull();
    expect(parsed!.payload).toEqual({ pluginId: PLUGIN_ID, instanceId: "inst", expiresAt: FAR_FUTURE });
    // The signature covers exactly the base64url payload segment.
    expect(parsed!.signedPayload).toBe(token.split(".")[1]);
    expect(parsed!.signatureB64).toBe("c2ln");
  });

  it("rejects anything that is not PEK1 with a complete, valid payload", () => {
    expect(parsePluginEntitlementToken("PC-example-123")).toBeNull();
    expect(parsePluginEntitlementToken("PEK1.onlyonepart")).toBeNull();
    expect(parsePluginEntitlementToken("PEK1....")).toBeNull();
    expect(parsePluginEntitlementToken(`PEK1.${Buffer.from("not json").toString("base64url")}.sig`)).toBeNull();
    // The payload schema is strict: every field is required.
    expect(parsePluginEntitlementToken(makeToken({ pluginId: PLUGIN_ID }))).toBeNull();
    expect(parsePluginEntitlementToken(makeToken({ instanceId: "inst", expiresAt: FAR_FUTURE }))).toBeNull();
    expect(parsePluginEntitlementToken(makeToken({ pluginId: PLUGIN_ID, instanceId: "inst" }))).toBeNull();
    expect(
      parsePluginEntitlementToken(
        makeToken({ pluginId: PLUGIN_ID, instanceId: "inst", expiresAt: FAR_FUTURE, extra: 1 }),
      ),
    ).toBeNull();
  });
});

describe("myrmidon(PLUGIN-ENTITLEMENT C) stored list and activity", () => {
  it("normalizes a malformed or absent stored list to no keys (fail closed)", () => {
    expect(normalizePluginEntitlementKeys(undefined)).toEqual([]);
    expect(normalizePluginEntitlementKeys("nope")).toEqual([]);
    expect(normalizePluginEntitlementKeys([{ pluginId: PLUGIN_ID }])).toEqual([]);
    expect(normalizePluginEntitlementKeys([key()])).toEqual([key()]);
    expect(PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY).toBe("pluginEntitlementKeys");
  });

  it("matches the active key by exact plugin id", () => {
    const keys = [key({ pluginId: "other.plugin" }), key()];
    expect(findActivePluginEntitlementKey(keys, PLUGIN_ID, new Date("2026-10-04T00:00:00.000Z"))).toEqual(key());
    expect(findActivePluginEntitlementKey(keys, "example.other", new Date())).toBeNull();
    expect(isPluginEntitlementKeyActive(key({ expiresAt: PAST }), new Date("2026-10-04T00:00:00.000Z"))).toBe(false);
  });
});

describe("myrmidon(1.6.3 PLUGIN-ENTITLEMENT A) key values never leave the API", () => {
  it("the view projection drops the key from every entry", () => {
    const views = toPluginEntitlementKeyViews([key(), key({ pluginId: "example.other" })]);
    expect(views).toEqual([
      { pluginId: PLUGIN_ID, expiresAt: FAR_FUTURE, acceptedAt: FAR_FUTURE },
      { pluginId: "example.other", expiresAt: FAR_FUTURE, acceptedAt: FAR_FUTURE },
    ]);
    expect(JSON.stringify(views)).not.toContain("PEK1.");
  });

  it("the verification-key view carries the value and its source, and nothing else", () => {
    expect(pluginEntitlementPublicKeyViewSchema.parse({ publicKey: "pem", source: "settings" })).toEqual({
      publicKey: "pem",
      source: "settings",
    });
    expect(pluginEntitlementPublicKeyViewSchema.safeParse({ publicKey: null, source: "none" }).success).toBe(true);
    // The source is a closed set; an unexpected one is a contract break.
    expect(pluginEntitlementPublicKeyViewSchema.safeParse({ publicKey: "pem", source: "elsewhere" }).success).toBe(
      false,
    );
    expect(pluginEntitlementPublicKeyViewSchema.safeParse({ publicKey: "pem", source: "env", extra: 1 }).success).toBe(
      false,
    );
  });
});
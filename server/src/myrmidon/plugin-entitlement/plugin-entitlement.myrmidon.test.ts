// server/src/myrmidon/plugin-entitlement/plugin-entitlement.myrmidon.test.ts
//
// myrmidon(PLUGIN-ENTITLEMENT C / 1.6.3 A): the acceptance tests of the
// entitlement gate and the ed25519 token verifier. Repo style: no database,
// neutral data, decisions pinned at the domain seams (the shared key
// helpers, the store with a fake settings port, the verifier, the
// loader-side resolver, the route with a fake settings port). The decisions
// the ticket names:
//
//   1. a manifest with `requiresEntitlement: true` is not activated while no
//      active key exists for its exact plugin id;
//   2. accepting a key entitles the plugin without a restart (the resolver
//      reads whatever the settings row currently holds);
//   3. an expired key does not entitle; a null expiry never expires;
//   4. a stored list that is malformed normalizes to "no keys" (fail closed);
//   5. a re-accepted key replaces the previous one for the same plugin;
//   6. the manifest field is optional and defaults to "not gated";
//   7. the token verifier: a correct ed25519 signature passes; a foreign
//      signature, an expired token, a token for another instance, and a
//      token for another plugin are all rejected;
//   8. the API never returns key values: every route response goes through
//      the view projection, and the route 400 messages carry no key material;
//   9. a stored key whose signature no longer verifies (rotated public key)
//      does not entitle — expiry alone is not the verdict.

import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY,
  PLUGIN_ENTITLEMENT_PUBLIC_KEY_SETTINGS_KEY,
  findActivePluginEntitlementKey,
  isPluginEntitlementKeyActive,
  normalizePluginEntitlementKeys,
  parsePluginEntitlementToken,
  toPluginEntitlementKeyViews,
  type PluginEntitlementKey,
} from "@paperclipai/shared";
import {
  acceptPluginEntitlementKey,
  preservePluginEntitlementKeysGeneralKey,
  preservePluginEntitlementPublicKeyGeneralKey,
  readPluginEntitlementKeys,
  readPluginEntitlementPublicKey,
  readPluginEntitlementPublicKeyWithSource,
  removePluginEntitlementKey,
  writePluginEntitlementPublicKey,
  type PluginEntitlementSettingsService,
} from "./store.js";
import { resolvePluginActivation } from "../../services/plugin-entitlement-enforcement.js";
import {
  validateIncomingKey,
  verifyEntitlementToken,
  entitlementTokenErrorMessage,
  acceptKeyRequestSchema,
  setPublicKeyRequestSchema,
  isValidEd25519PublicKey,
} from "./validation.js";

const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
const PLUGIN_ID = "example.premium-feature";
const INSTANCE_ID = "test-instance";

const signing = generateKeyPairSync("ed25519");
const foreign = generateKeyPairSync("ed25519");

const signingPublicPem = signing.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const foreignPublicPem = foreign.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

/** Build a PEK1 token the way the (out-of-band) issuer would. */
function makeToken(input: {
  pluginId?: string;
  instanceId?: string;
  expiresAt?: string;
  keyPair?: typeof signing;
}): string {
  const pair = input.keyPair ?? signing;
  const payload = {
    pluginId: input.pluginId ?? PLUGIN_ID,
    instanceId: input.instanceId ?? INSTANCE_ID,
    expiresAt: input.expiresAt ?? FAR_FUTURE,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = cryptoSign(
    null,
    Buffer.from(payloadB64, "utf8"),
    pair.privateKey,
  ).toString("base64url");
  return `PEK1.${payloadB64}.${signature}`;
}

const validToken = makeToken({});
const foreignToken = makeToken({ keyPair: foreign });
const expiredToken = makeToken({ expiresAt: PAST });
const otherInstanceToken = makeToken({ instanceId: "other-instance" });
const otherPluginToken = makeToken({ pluginId: "other.plugin" });

const verifyContext = {
  publicKeyPem: signingPublicPem,
  instanceId: INSTANCE_ID,
  pluginId: PLUGIN_ID,
  now: new Date("2026-10-04T00:00:00.000Z"),
};

function key(overrides: Partial<PluginEntitlementKey> = {}): PluginEntitlementKey {
  return {
    pluginId: PLUGIN_ID,
    key: "PC-example-123",
    expiresAt: null,
    acceptedAt: null,
    ...overrides,
  };
}

/** Fake settings port capturing updateGeneral calls. */
function fakeSettings(general: Record<string, unknown> = {}) {
  const writes: Record<string, unknown>[] = [];
  const service: PluginEntitlementSettingsService = {
    getGeneral: async () => general,
    updateGeneral: async (patch: never) => {
      writes.push(patch);
      return {} as never;
    },
  } as unknown as PluginEntitlementSettingsService;
  return { service, writes, general };
}

describe("myrmidon(1.6.3 PLUGIN-ENTITLEMENT A) token parsing", () => {
  it("parses a well-formed PEK1 token", () => {
    const token = parsePluginEntitlementToken(validToken);
    expect(token).not.toBeNull();
    expect(token!.payload.pluginId).toBe(PLUGIN_ID);
    expect(token!.payload.instanceId).toBe(INSTANCE_ID);
  });

  it("rejects non-PEK1 strings, wrong part counts, and bad payloads", () => {
    expect(parsePluginEntitlementToken("PC-example-123")).toBeNull();
    expect(parsePluginEntitlementToken("PEK1.onlyonepart")).toBeNull();
    expect(parsePluginEntitlementToken("PEK1....")).toBeNull();
    expect(parsePluginEntitlementToken(`PEK1.${Buffer.from("not json").toString("base64url")}.sig`)).toBeNull();
    // A payload missing required fields does not parse.
    const badPayload = Buffer.from(JSON.stringify({ pluginId: "x" })).toString("base64url");
    expect(parsePluginEntitlementToken(`PEK1.${badPayload}.sig`)).toBeNull();
  });
});

describe("myrmidon(1.6.3 PLUGIN-ENTITLEMENT A) signature verification", () => {
  it("a token with a correct signature for this instance and plugin verifies", () => {
    expect(verifyEntitlementToken(validToken, verifyContext)).toEqual({
      valid: true,
      pluginId: PLUGIN_ID,
      expiresAt: FAR_FUTURE,
    });
  });

  it("a token signed by another key is rejected (bad_signature)", () => {
    const verdict = verifyEntitlementToken(foreignToken, verifyContext);
    expect(verdict).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("a token verified against another public key is rejected", () => {
    const verdict = verifyEntitlementToken(validToken, {
      publicKeyPem: foreignPublicPem,
      instanceId: INSTANCE_ID,
      pluginId: PLUGIN_ID,
      now: verifyContext.now,
    });
    expect(verdict).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("an expired token is rejected (expired)", () => {
    const verdict = verifyEntitlementToken(expiredToken, verifyContext);
    expect(verdict).toEqual({ valid: false, reason: "expired" });
  });

  it("a token for another instance is rejected (wrong_instance)", () => {
    const verdict = verifyEntitlementToken(otherInstanceToken, verifyContext);
    expect(verdict).toEqual({ valid: false, reason: "wrong_instance" });
  });

  it("a token for another plugin is rejected (wrong_plugin)", () => {
    const verdict = verifyEntitlementToken(otherPluginToken, verifyContext);
    expect(verdict).toEqual({ valid: false, reason: "wrong_plugin" });
  });

  it("no configured public key fails closed", () => {
    const verdict = verifyEntitlementToken(validToken, { ...verifyContext, publicKeyPem: "" });
    expect(verdict).toEqual({ valid: false, reason: "no_public_key" });
  });

  it("an unparseable stored public key fails closed", () => {
    const verdict = verifyEntitlementToken(validToken, { ...verifyContext, publicKeyPem: "not a pem" });
    expect(verdict.valid).toBe(false);
  });

  it("the error messages carry a reason and no key material", () => {
    for (const verdict of [
      verifyEntitlementToken("garbage", verifyContext),
      verifyEntitlementToken(foreignToken, verifyContext),
      verifyEntitlementToken(expiredToken, verifyContext),
      verifyEntitlementToken(otherInstanceToken, verifyContext),
    ]) {
      if (verdict.valid) throw new Error("expected invalid");
      const message = entitlementTokenErrorMessage(verdict);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(validToken);
      expect(message).not.toContain(foreignToken);
    }
  });
});

describe("myrmidon(PLUGIN-ENTITLEMENT C) key activity", () => {
  it("a null expiry never expires; a past expiry is expired; a future one is active", () => {
    const now = new Date("2026-10-04T00:00:00.000Z");
    expect(isPluginEntitlementKeyActive(key(), now)).toBe(true);
    expect(isPluginEntitlementKeyActive(key({ expiresAt: PAST }), now)).toBe(false);
    expect(isPluginEntitlementKeyActive(key({ expiresAt: FAR_FUTURE }), now)).toBe(true);
  });

  it("the active key is matched by exact plugin id", () => {
    const keys = [key({ pluginId: "other.plugin" }), key()];
    expect(findActivePluginEntitlementKey(keys, PLUGIN_ID)?.key).toBe("PC-example-123");
    expect(findActivePluginEntitlementKey(keys, "no.such.plugin")).toBeNull();
  });

  it("a malformed stored list fails closed to no keys", () => {
    expect(normalizePluginEntitlementKeys(undefined)).toEqual([]);
    expect(normalizePluginEntitlementKeys("nope")).toEqual([]);
    expect(normalizePluginEntitlementKeys([{ pluginId: "x" }])).toEqual([]);
  });
});

describe("myrmidon(1.6.3 PLUGIN-ENTITLEMENT A) activation gate with verification", () => {
  const manifest = { id: PLUGIN_ID, requiresEntitlement: true } as const;

  it("a gated manifest without a key is not activated", () => {
    const decision = resolvePluginActivation(manifest, [], verifyContext);
    expect(decision).toEqual({ activate: false, reason: "no_active_key" });
  });

  it("a gated manifest with an active, correctly signed key is activated", () => {
    const decision = resolvePluginActivation(manifest, [key({ key: validToken, expiresAt: FAR_FUTURE })], verifyContext);
    expect(decision).toEqual({ activate: true, reason: "entitled" });
  });

  it("a stored key signed by another key does not entitle (bad signature beats expiry)", () => {
    const decision = resolvePluginActivation(manifest, [key({ key: foreignToken, expiresAt: FAR_FUTURE })], verifyContext);
    expect(decision).toEqual({ activate: false, reason: "invalid_key" });
  });

  it("a stored expired key does not entitle", () => {
    const decision = resolvePluginActivation(manifest, [key({ key: expiredToken, expiresAt: PAST })], verifyContext);
    expect(decision.activate).toBe(false);
  });

  it("a stored key for another instance does not entitle", () => {
    const decision = resolvePluginActivation(manifest, [key({ key: otherInstanceToken, expiresAt: FAR_FUTURE })], verifyContext);
    expect(decision).toEqual({ activate: false, reason: "invalid_key" });
  });

  it("without a configured public key nothing entitles", () => {
    const decision = resolvePluginActivation(manifest, [key({ key: validToken, expiresAt: FAR_FUTURE })], {
      publicKeyPem: null,
      instanceId: INSTANCE_ID,
    });
    expect(decision).toEqual({ activate: false, reason: "invalid_key" });
  });

  it("a manifest without the flag is never gated", () => {
    expect(resolvePluginActivation({ id: "vendor.plugin" }, [])).toEqual({
      activate: true,
      reason: "no_entitlement_required",
    });
    expect(resolvePluginActivation({ id: "vendor.plugin", requiresEntitlement: false }, [key()])).toEqual({
      activate: true,
      reason: "no_entitlement_required",
    });
  });
});

describe("myrmidon(PLUGIN-ENTITLEMENT C) store", () => {
  it("reads the keys from the general row and normalizes malformed rows", async () => {
    const { service } = fakeSettings({ [PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]: [key()] });
    expect(await readPluginEntitlementKeys(service)).toHaveLength(1);
    const empty = fakeSettings({});
    expect(await readPluginEntitlementKeys(empty.service)).toEqual([]);
  });

  it("accepting a key writes the list and replaces a previous key for the same plugin", async () => {
    const { service, writes } = fakeSettings({ [PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]: [key()] });
    const next = await acceptPluginEntitlementKey(service, {
      pluginId: PLUGIN_ID,
      key: "PC-new-456",
    });
    expect(next).toHaveLength(1);
    expect(next[0]!.key).toBe("PC-new-456");
    const written = writes.at(-1) as Record<string, unknown>;
    expect(written[PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]).toEqual(next);
  });

  it("removing a key filters the plugin id and is a no-op for an absent id", async () => {
    const { service, writes } = fakeSettings({ [PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]: [key(), key({ pluginId: "other.plugin" })] });
    const next = await removePluginEntitlementKey(service, PLUGIN_ID);
    expect(next.map((entry) => entry.pluginId)).toEqual(["other.plugin"]);
    const untouched = writes.length;
    await removePluginEntitlementKey(service, "absent.plugin");
    // A no-op removal still writes the same list (PUT semantics).
    expect(writes.length).toBe(untouched + 1);
  });

  it("preserve keeps the stored key list and public key across vendor general writes", () => {
    const row = {
      censorUsernameInLogs: false,
      [PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]: [key()],
      [PLUGIN_ENTITLEMENT_PUBLIC_KEY_SETTINGS_KEY]: signingPublicPem,
    };
    expect(preservePluginEntitlementKeysGeneralKey(row)).toEqual({
      [PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]: [key()],
    });
    expect(preservePluginEntitlementPublicKeyGeneralKey(row)).toEqual({
      [PLUGIN_ENTITLEMENT_PUBLIC_KEY_SETTINGS_KEY]: signingPublicPem,
    });
    expect(preservePluginEntitlementKeysGeneralKey({})).toEqual({});
    expect(preservePluginEntitlementPublicKeyGeneralKey(null)).toEqual({});
  });

  it("reads the verification public key from the settings row; env applies only without a stored row", async () => {
    const stored = fakeSettings({ [PLUGIN_ENTITLEMENT_PUBLIC_KEY_SETTINGS_KEY]: signingPublicPem });
    // Normalized on read (whitespace around a pasted value is dropped).
    expect(await readPluginEntitlementPublicKey(stored.service, {})).toBe(signingPublicPem.trim());
    const unset = fakeSettings({});
    expect(await readPluginEntitlementPublicKey(unset.service, {})).toBeNull();
    expect(
      await readPluginEntitlementPublicKey(unset.service, {
        MYRMIDON_PLUGIN_ENTITLEMENT_PUBLIC_KEY: foreignPublicPem,
      }),
    ).toBe(foreignPublicPem.trim());
  });
});

describe("myrmidon(1.6.3 PLUGIN-ENTITLEMENT A) verification public key settings", () => {
  it("reports the effective public key and its source", async () => {
    const stored = fakeSettings({ [PLUGIN_ENTITLEMENT_PUBLIC_KEY_SETTINGS_KEY]: signingPublicPem });
    expect(await readPluginEntitlementPublicKeyWithSource(stored.service, {})).toEqual({
      publicKey: signingPublicPem.trim(),
      source: "settings",
    });
    // The env override applies only while the settings row has no value.
    expect(await readPluginEntitlementPublicKeyWithSource(stored.service, {
      MYRMIDON_PLUGIN_ENTITLEMENT_PUBLIC_KEY: foreignPublicPem,
    })).toEqual({ publicKey: signingPublicPem.trim(), source: "settings" });
    const unset = fakeSettings({});
    expect(await readPluginEntitlementPublicKeyWithSource(unset.service, {
      MYRMIDON_PLUGIN_ENTITLEMENT_PUBLIC_KEY: foreignPublicPem,
    })).toEqual({ publicKey: foreignPublicPem.trim(), source: "env" });
    expect(await readPluginEntitlementPublicKeyWithSource(unset.service, {})).toEqual({
      publicKey: null,
      source: "none",
    });
  });

  it("accepts a raw base64 32-byte key as the env override", async () => {
    const raw = signing.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    const { publicKey } = await readPluginEntitlementPublicKeyWithSource(fakeSettings({}).service, {
      MYRMIDON_PLUGIN_ENTITLEMENT_PUBLIC_KEY: raw,
    });
    // The wrapped SPKI form verifies the same tokens as the PEM form.
    expect(verifyEntitlementToken(validToken, { ...verifyContext, publicKeyPem: publicKey ?? "" })).toEqual({
      valid: true,
      pluginId: PLUGIN_ID,
      expiresAt: FAR_FUTURE,
    });
  });

  it("writes the public key to the general row and clears it with null", async () => {
    const settings = fakeSettings({});
    await writePluginEntitlementPublicKey(settings.service, `  ${signingPublicPem}  `);
    expect(settings.writes).toEqual([{ [PLUGIN_ENTITLEMENT_PUBLIC_KEY_SETTINGS_KEY]: signingPublicPem.trim() }]);
    await writePluginEntitlementPublicKey(settings.service, null);
    expect(settings.writes[1]).toEqual({ [PLUGIN_ENTITLEMENT_PUBLIC_KEY_SETTINGS_KEY]: undefined });
    await writePluginEntitlementPublicKey(settings.service, "   ");
    expect(settings.writes[2]).toEqual({ [PLUGIN_ENTITLEMENT_PUBLIC_KEY_SETTINGS_KEY]: undefined });
  });

  it("accepts only ed25519 public keys", () => {
    expect(isValidEd25519PublicKey(signingPublicPem)).toBe(true);
    expect(isValidEd25519PublicKey("")).toBe(false);
    expect(isValidEd25519PublicKey("not a pem")).toBe(false);
    expect(isValidEd25519PublicKey(signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toBe(false);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(isValidEd25519PublicKey(rsa.publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(false);
  });

  it("the public key request schema accepts a string or null and rejects anything else (strict)", () => {
    expect(setPublicKeyRequestSchema.safeParse({ publicKey: signingPublicPem }).success).toBe(true);
    expect(setPublicKeyRequestSchema.safeParse({ publicKey: null }).success).toBe(true);
    expect(setPublicKeyRequestSchema.safeParse({ publicKey: 5 }).success).toBe(false);
    expect(setPublicKeyRequestSchema.safeParse({ publicKey: null, extra: 1 }).success).toBe(false);
  });
});

describe("myrmidon(1.6.3 PLUGIN-ENTITLEMENT A) key values never leave the API", () => {
  it("the view projection strips the key from every entry", () => {
    const views = toPluginEntitlementKeyViews([
      key({ key: validToken, expiresAt: FAR_FUTURE, acceptedAt: FAR_FUTURE }),
    ]);
    expect(views).toEqual([
      { pluginId: PLUGIN_ID, expiresAt: FAR_FUTURE, acceptedAt: FAR_FUTURE },
    ]);
    expect(JSON.stringify(views)).not.toContain("PEK1.");
    expect(JSON.stringify(views)).not.toContain("PC-example-123");
  });

  it("the accept request schema rejects unknown fields (strict)", () => {
    expect(
      acceptKeyRequestSchema.safeParse({ pluginId: "p", key: "k", extra: 1 }).success,
    ).toBe(false);
    expect(acceptKeyRequestSchema.safeParse({ pluginId: "p", key: "k" }).success).toBe(true);
  });
});

describe("myrmidon(PLUGIN-ENTITLEMENT C) incoming key checks", () => {
  it("an empty plugin id or key is rejected with a clear error", () => {
    expect(validateIncomingKey({ pluginId: "  ", key: "k" })).toEqual({ ok: false, error: "pluginId is required" });
    expect(validateIncomingKey({ pluginId: "p", key: "" })).toEqual({ ok: false, error: "key is required" });
  });

  it("a well-formed key passes", () => {
    expect(validateIncomingKey({ pluginId: PLUGIN_ID, key: validToken })).toEqual({ ok: true });
  });
});

// Import smoke: the route module and the barrel must resolve in the server
// package graph (the suite above covers their units). A broken import path is
// a guaranteed CI red that unit tests on helpers cannot see.
import * as pluginEntitlementRoutes from "./routes.js";
import * as pluginEntitlementIndex from "./index.js";
import * as pluginEntitlementEnforcement from "../../services/plugin-entitlement-enforcement.js";

describe("myrmidon(PLUGIN-ENTITLEMENT C) module wiring", () => {
  it("exports the route router", () => {
    expect(typeof pluginEntitlementRoutes.pluginEntitlementRoutes).toBe("function");
  });
  it("exports the enforcement resolver", () => {
    expect(typeof pluginEntitlementEnforcement.resolvePluginActivation).toBe("function");
  });
  it("re-exports from the barrel", () => {
    expect(pluginEntitlementIndex.pluginEntitlementRoutes).toBe(pluginEntitlementRoutes.pluginEntitlementRoutes);
  });
  it("route smoke: the router is an express Router instance", () => {
    const router = pluginEntitlementRoutes.pluginEntitlementRoutes({} as never);
    expect(typeof router.get).toBe("function");
    expect(typeof router.post).toBe("function");
  });
});


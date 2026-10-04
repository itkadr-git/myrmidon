// server/src/myrmidon/plugin-entitlement/plugin-entitlement.myrmidon.test.ts
//
// myrmidon(PLUGIN-ENTITLEMENT C): the acceptance tests of the entitlement
// gate. Repo style: no database, neutral data, decisions pinned at the domain
// seams (the shared key helpers, the store with a fake settings port, the
// loader-side resolver). The decisions the ticket names:
//
//   1. a manifest with `requiresEntitlement: true` is not activated while no
//      active key exists for its exact plugin id;
//   2. accepting a key entitles the plugin without a restart (the resolver
//      reads whatever the settings row currently holds);
//   3. an expired key does not entitle; a null expiry never expires;
//   4. a stored list that is malformed normalizes to "no keys" (fail closed);
//   5. a re-accepted key replaces the previous one for the same plugin;
//   6. the manifest field is optional and defaults to "not gated".

import { describe, expect, it } from "vitest";
import {
  PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY,
  findActivePluginEntitlementKey,
  isPluginEntitlementKeyActive,
  normalizePluginEntitlementKeys,
  type PluginEntitlementKey,
} from "@paperclipai/shared";
import {
  acceptPluginEntitlementKey,
  preservePluginEntitlementKeysGeneralKey,
  readPluginEntitlementKeys,
  removePluginEntitlementKey,
  type PluginEntitlementSettingsService,
} from "./store.js";
import { resolvePluginActivation } from "../../services/plugin-entitlement-enforcement.js";
import { validateIncomingKey } from "./validation.js";

const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

function key(overrides: Partial<PluginEntitlementKey> = {}): PluginEntitlementKey {
  return {
    pluginId: "example.premium-feature",
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

describe("myrmidon(PLUGIN-ENTITLEMENT C) key activity", () => {
  it("a null expiry never expires; a past expiry is expired; a future one is active", () => {
    const now = new Date("2026-10-04T00:00:00.000Z");
    expect(isPluginEntitlementKeyActive(key(), now)).toBe(true);
    expect(isPluginEntitlementKeyActive(key({ expiresAt: PAST }), now)).toBe(false);
    expect(isPluginEntitlementKeyActive(key({ expiresAt: FAR_FUTURE }), now)).toBe(true);
  });

  it("the active key is matched by exact plugin id", () => {
    const keys = [key({ pluginId: "other.plugin" }), key()];
    expect(findActivePluginEntitlementKey(keys, "example.premium-feature")?.key).toBe("PC-example-123");
    expect(findActivePluginEntitlementKey(keys, "no.such.plugin")).toBeNull();
  });

  it("a malformed stored list fails closed to no keys", () => {
    expect(normalizePluginEntitlementKeys(undefined)).toEqual([]);
    expect(normalizePluginEntitlementKeys("nope")).toEqual([]);
    expect(normalizePluginEntitlementKeys([{ pluginId: "x" }])).toEqual([]);
  });
});

describe("myrmidon(PLUGIN-ENTITLEMENT C) activation gate", () => {
  it("a gated manifest without a key is not activated", () => {
    const decision = resolvePluginActivation(
      { id: "example.premium-feature", requiresEntitlement: true },
      [],
    );
    expect(decision).toEqual({ activate: false, reason: "no_active_key" });
  });

  it("a gated manifest with an active key is activated (no restart needed — the resolver reads current keys)", () => {
    const decision = resolvePluginActivation(
      { id: "example.premium-feature", requiresEntitlement: true },
      [key()],
    );
    expect(decision).toEqual({ activate: true, reason: "entitled" });
  });

  it("an expired key does not entitle", () => {
    const decision = resolvePluginActivation(
      { id: "example.premium-feature", requiresEntitlement: true },
      [key({ expiresAt: PAST })],
    );
    expect(decision.activate).toBe(false);
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
      pluginId: "example.premium-feature",
      key: "PC-new-456",
    });
    expect(next).toHaveLength(1);
    expect(next[0]!.key).toBe("PC-new-456");
    const written = writes.at(-1) as Record<string, unknown>;
    expect(written[PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]).toEqual(next);
  });

  it("removing a key filters the plugin id and is a no-op for an absent id", async () => {
    const { service, writes } = fakeSettings({ [PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]: [key(), key({ pluginId: "other.plugin" })] });
    const next = await removePluginEntitlementKey(service, "example.premium-feature");
    expect(next.map((entry) => entry.pluginId)).toEqual(["other.plugin"]);
    const untouched = writes.length;
    await removePluginEntitlementKey(service, "absent.plugin");
    // A no-op removal still writes the same list (PUT semantics).
    expect(writes.length).toBe(untouched + 1);
  });

  it("preserve keeps the stored key list across vendor general writes", () => {
    const row = { censorUsernameInLogs: false, [PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]: [key()] };
    expect(preservePluginEntitlementKeysGeneralKey(row)).toEqual({
      [PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]: [key()],
    });
    expect(preservePluginEntitlementKeysGeneralKey({})).toEqual({});
    expect(preservePluginEntitlementKeysGeneralKey(null)).toEqual({});
  });
});

describe("myrmidon(PLUGIN-ENTITLEMENT C) incoming key checks", () => {
  it("an empty plugin id or key is rejected with a clear error", () => {
    expect(validateIncomingKey({ pluginId: "  ", key: "k" })).toEqual({ ok: false, error: "pluginId is required" });
    expect(validateIncomingKey({ pluginId: "p", key: "" })).toEqual({ ok: false, error: "key is required" });
  });

  it("a well-formed key passes", () => {
    expect(validateIncomingKey({ pluginId: "example.premium-feature", key: "PC-example-123" })).toEqual({ ok: true });
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
});

// server/src/myrmidon/corpus/embed-key-cache.myrmidon.test.ts
//
// OPE-12272 (second hot-path change): the embedder key is resolved through the secrets service once
// per TTL, not on every cold question. The spies below stand for the secrets service (`resolveValue`)
// and for the lookup of the secret row (`findSecret`).

import { describe, expect, it } from "vitest";
import {
  CORPUS_EMBED_KEY_CACHE_TTL_ENV,
  DEFAULT_EMBED_KEY_CACHE_TTL_SEC,
  createEmbedderKeyCache,
  createEmbedderKeyResolver,
  readCacheTtlMs,
  type EmbedderSecretRef,
} from "./hot-path-cache.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const TTL = 60_000;

function harness() {
  let now = 1_000;
  const spy = { findSecret: 0, resolveValue: 0 };
  const state: { secrets: Map<string, EmbedderSecretRef | null>; value: string; failNext: boolean } = {
    secrets: new Map([[COMPANY, { id: "secret-1", latestVersion: 1 }]]),
    value: "key-v1",
    failNext: false,
  };
  const cache = createEmbedderKeyCache({ now: () => now });
  const resolver = createEmbedderKeyResolver({
    cache,
    async findSecret(companyId) {
      spy.findSecret += 1;
      return state.secrets.get(companyId) ?? null;
    },
    async resolveValue(companyId, secretId) {
      spy.resolveValue += 1;
      if (state.failNext) {
        state.failNext = false;
        throw new Error("secrets service unavailable");
      }
      return `${state.value}:${companyId.slice(0, 2)}:${secretId}`;
    },
  });
  return { spy, state, cache, resolver, advance: (ms: number) => { now += ms; } };
}

describe("embedder key cache", () => {
  it("defaults to 60 s, and reads the setting like the other cache TTLs", () => {
    expect(DEFAULT_EMBED_KEY_CACHE_TTL_SEC).toBe(60);
    expect(readCacheTtlMs(undefined, DEFAULT_EMBED_KEY_CACHE_TTL_SEC)).toBe(60_000);
    expect(readCacheTtlMs("0", DEFAULT_EMBED_KEY_CACHE_TTL_SEC)).toBe(0);
    expect(CORPUS_EMBED_KEY_CACHE_TTL_ENV).toBe("MYRMIDON_CORPUS_EMBED_KEY_CACHE_TTL_SEC");
  });

  it("resolves the key through the secrets service once within the TTL", async () => {
    const { spy, resolver, advance } = harness();

    const first = await resolver.resolve(COMPANY, TTL);
    advance(30_000);
    const second = await resolver.resolve(COMPANY, TTL);
    advance(29_000);
    const third = await resolver.resolve(COMPANY, TTL);

    expect(first).toEqual({ present: true, apiKey: "key-v1:11:secret-1" });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(spy.resolveValue).toBe(1);
    // The cheap lookup of the secret row still runs on every question.
    expect(spy.findSecret).toBe(3);
  });

  it("resolves again after the TTL", async () => {
    const { spy, resolver, advance, state } = harness();
    await resolver.resolve(COMPANY, TTL);
    advance(61_000);
    state.value = "key-v1-refreshed";

    const after = await resolver.resolve(COMPANY, TTL);

    expect(spy.resolveValue).toBe(2);
    expect(after.apiKey).toBe("key-v1-refreshed:11:secret-1");
  });

  it("resolves again after the cache is cleared", async () => {
    const { spy, resolver, cache } = harness();
    await resolver.resolve(COMPANY, TTL);
    cache.clear();
    await resolver.resolve(COMPANY, TTL);
    expect(spy.resolveValue).toBe(2);
  });

  it("does not serve an older key after the secret is rotated or replaced", async () => {
    const { spy, resolver, state } = harness();
    await resolver.resolve(COMPANY, TTL);

    state.secrets.set(COMPANY, { id: "secret-1", latestVersion: 2 }); // rotated
    state.value = "key-v2";
    expect((await resolver.resolve(COMPANY, TTL)).apiKey).toBe("key-v2:11:secret-1");
    expect(spy.resolveValue).toBe(2);

    state.secrets.set(COMPANY, { id: "secret-2", latestVersion: 1 }); // replaced by another secret
    expect((await resolver.resolve(COMPANY, TTL)).apiKey).toBe("key-v2:11:secret-2");
    expect(spy.resolveValue).toBe(3);
  });

  it("does not serve a key once the secret is gone, and keeps nothing for a company without one", async () => {
    const { spy, resolver, state } = harness();
    await resolver.resolve(COMPANY, TTL);

    state.secrets.set(COMPANY, null); // deactivated or deleted
    expect(await resolver.resolve(COMPANY, TTL)).toEqual({ present: false, apiKey: undefined });
    expect(await resolver.resolve(OTHER_COMPANY, TTL)).toEqual({ present: false, apiKey: undefined });
    expect(spy.resolveValue).toBe(1);

    state.secrets.set(OTHER_COMPANY, { id: "secret-9", latestVersion: 1 }); // added later: seen at once
    expect((await resolver.resolve(OTHER_COMPANY, TTL)).present).toBe(true);
    expect(spy.resolveValue).toBe(2);
  });

  it("keeps the key of one company away from another", async () => {
    const { spy, resolver, state } = harness();
    state.secrets.set(OTHER_COMPANY, { id: "secret-1", latestVersion: 1 });

    const first = await resolver.resolve(COMPANY, TTL);
    const second = await resolver.resolve(OTHER_COMPANY, TTL);

    expect(first.apiKey).not.toBe(second.apiKey);
    expect(spy.resolveValue).toBe(2);
  });

  it("resolves on every question when the TTL is 0", async () => {
    const { spy, resolver } = harness();
    await resolver.resolve(COMPANY, 0);
    await resolver.resolve(COMPANY, 0);
    expect(spy.resolveValue).toBe(2);
  });

  it("shares one resolution between questions that arrive together", async () => {
    const { spy, resolver } = harness();
    const [a, b, c] = await Promise.all([
      resolver.resolve(COMPANY, TTL),
      resolver.resolve(COMPANY, TTL),
      resolver.resolve(COMPANY, TTL),
    ]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(spy.resolveValue).toBe(1);
  });

  it("does not keep a failed resolution", async () => {
    const { spy, resolver, state } = harness();
    state.failNext = true;
    await expect(resolver.resolve(COMPANY, TTL)).rejects.toThrow("secrets service unavailable");

    expect((await resolver.resolve(COMPANY, TTL)).present).toBe(true);
    expect(spy.resolveValue).toBe(2);
  });
});

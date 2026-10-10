import { describe, expect, it } from "vitest";
import {
  ATTENTION_FEED_BOUNDS,
  ATTENTION_FAILED_RUN_HORIZON_DEFAULT_DAYS,
  ATTENTION_FEED_CACHE_TTL_DEFAULT_SECONDS,
  attentionFeedSettingsSchema,
  attentionFeedStoredPatch,
  mergeAttentionFeedSettings,
  patchAttentionFeedSettingsSchema,
  resolveAttentionFeedSettings,
} from "./myrmidon-attention-feed.js";

describe("resolveAttentionFeedSettings", () => {
  it("falls back to the built-in defaults when the row holds nothing", () => {
    const resolved = resolveAttentionFeedSettings({});
    expect(resolved.settings).toEqual({
      failedRunHorizonDays: ATTENTION_FAILED_RUN_HORIZON_DEFAULT_DAYS,
      feedCacheTtlSeconds: ATTENTION_FEED_CACHE_TTL_DEFAULT_SECONDS,
    });
    expect(resolved.sources).toEqual({
      failedRunHorizonDays: "default",
      feedCacheTtlSeconds: "default",
    });
  });

  it("reads a saved row and reports it as the settings source", () => {
    const resolved = resolveAttentionFeedSettings({
      attentionFailedRunHorizonDays: 14,
      attentionFeedCacheTtlSeconds: 0,
    });
    expect(resolved.settings).toEqual({ failedRunHorizonDays: 14, feedCacheTtlSeconds: 0 });
    expect(resolved.sources).toEqual({
      failedRunHorizonDays: "settings",
      feedCacheTtlSeconds: "settings",
    });
  });

  it("treats a hand-edited value outside the bounds as the default, per key", () => {
    const resolved = resolveAttentionFeedSettings({
      attentionFailedRunHorizonDays: 366,
      attentionFeedCacheTtlSeconds: 120,
    });
    expect(resolved.settings).toEqual({
      failedRunHorizonDays: ATTENTION_FAILED_RUN_HORIZON_DEFAULT_DAYS,
      feedCacheTtlSeconds: 120,
    });
    expect(resolved.sources).toEqual({
      failedRunHorizonDays: "default",
      feedCacheTtlSeconds: "settings",
    });
  });

  it("rejects a fractional, string or negative stored value", () => {
    expect(resolveAttentionFeedSettings({ attentionFailedRunHorizonDays: 7.5 }).sources)
      .toEqual({ failedRunHorizonDays: "default", feedCacheTtlSeconds: "default" });
    expect(resolveAttentionFeedSettings({ attentionFailedRunHorizonDays: "7" }).sources)
      .toEqual({ failedRunHorizonDays: "default", feedCacheTtlSeconds: "default" });
    expect(resolveAttentionFeedSettings({ attentionFeedCacheTtlSeconds: -1 }).sources)
      .toEqual({ failedRunHorizonDays: "default", feedCacheTtlSeconds: "default" });
  });

  it("accepts the exact bounds of both windows", () => {
    expect(
      resolveAttentionFeedSettings({
        attentionFailedRunHorizonDays: ATTENTION_FEED_BOUNDS.failedRunHorizonDays.min,
        attentionFeedCacheTtlSeconds: ATTENTION_FEED_BOUNDS.feedCacheTtlSeconds.max,
      }).sources,
    ).toEqual({ failedRunHorizonDays: "settings", feedCacheTtlSeconds: "settings" });
  });
});

describe("attentionFeedSettingsSchema / patchAttentionFeedSettingsSchema", () => {
  it("keeps the schema bounds equal to the exported bounds", () => {
    expect(
      attentionFeedSettingsSchema.safeParse({
        failedRunHorizonDays: ATTENTION_FEED_BOUNDS.failedRunHorizonDays.max,
        feedCacheTtlSeconds: ATTENTION_FEED_BOUNDS.feedCacheTtlSeconds.max,
      }).success,
    ).toBe(true);
    expect(
      attentionFeedSettingsSchema.safeParse({
        failedRunHorizonDays: ATTENTION_FEED_BOUNDS.failedRunHorizonDays.max + 1,
        feedCacheTtlSeconds: 0,
      }).success,
    ).toBe(false);
  });

  it("takes a partial patch and rejects an out-of-bounds or unknown field", () => {
    expect(patchAttentionFeedSettingsSchema.safeParse({}).success).toBe(true);
    expect(patchAttentionFeedSettingsSchema.safeParse({ failedRunHorizonDays: 1 }).success).toBe(true);
    expect(patchAttentionFeedSettingsSchema.safeParse({ feedCacheTtlSeconds: 300 }).success).toBe(true);
    expect(patchAttentionFeedSettingsSchema.safeParse({ failedRunHorizonDays: 0 }).success).toBe(false);
    expect(patchAttentionFeedSettingsSchema.safeParse({ feedCacheTtlSeconds: 301 }).success).toBe(false);
    expect(patchAttentionFeedSettingsSchema.safeParse({ feedCacheTtlSeconds: 1.5 }).success).toBe(false);
    expect(patchAttentionFeedSettingsSchema.safeParse({ horizonDays: 7 }).success).toBe(false);
  });
});

describe("mergeAttentionFeedSettings / attentionFeedStoredPatch", () => {
  it("merges a partial patch over the effective values", () => {
    const base = { failedRunHorizonDays: 7, feedCacheTtlSeconds: 45 };
    expect(mergeAttentionFeedSettings(base, { feedCacheTtlSeconds: 90 })).toEqual({
      failedRunHorizonDays: 7,
      feedCacheTtlSeconds: 90,
    });
    expect(mergeAttentionFeedSettings(base, {})).toEqual(base);
  });

  it("writes only the keys the patch carried, so the other row keeps its shape", () => {
    expect(attentionFeedStoredPatch({ failedRunHorizonDays: 3, feedCacheTtlSeconds: 0 }, {})).toEqual({});
    expect(
      attentionFeedStoredPatch({ failedRunHorizonDays: 3, feedCacheTtlSeconds: 60 }, {
        feedCacheTtlSeconds: 60,
      }),
    ).toEqual({ attentionFeedCacheTtlSeconds: 60 });
    expect(
      attentionFeedStoredPatch({ failedRunHorizonDays: 3, feedCacheTtlSeconds: 60 }, {
        failedRunHorizonDays: 3,
        feedCacheTtlSeconds: 60,
      }),
    ).toEqual({ attentionFailedRunHorizonDays: 3, attentionFeedCacheTtlSeconds: 60 });
  });
});
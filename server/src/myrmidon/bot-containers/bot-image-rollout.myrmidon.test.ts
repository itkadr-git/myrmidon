// myrmidon(BOT-ROLLOUT): unit tests of the rollout status resolution and the
// env→settings resolver — no docker, no database (pure functions of shared).

import { describe, expect, it } from "vitest";
import {
  hasReleaseBotImage,
  normalizeBotImageRolloutSettings,
  resolveBotImageRolloutSettings,
  resolveBotImageRolloutStatus,
} from "@paperclipai/shared";

const RELEASE_DIGEST = `ghcr.io/example/myrmidon-hermes@sha256:${"c".repeat(64)}`;

describe("resolveBotImageRolloutStatus (BOT-ROLLOUT)", () => {
  it("names every reason a bot is not on the release image", () => {
    expect(
      resolveBotImageRolloutStatus({
        tracking: { category: "tracks_release", image: RELEASE_DIGEST },
        agentStatus: "running",
        hasReleaseImage: true,
      }),
    ).toEqual({
      onReleaseImage: false,
      targetImage: null,
      reason: "agent busy (status running): переключится при освобождении",
    });
    expect(
      resolveBotImageRolloutStatus({
        tracking: { category: "tracks_release", image: RELEASE_DIGEST },
        agentStatus: null,
        hasReleaseImage: true,
      }).reason,
    ).toContain("agent busy (status unknown)");
    // a switchable bot without a known release image reports it (busy wins over it)
    expect(
      resolveBotImageRolloutStatus({
        tracking: { category: "tracks_release", image: RELEASE_DIGEST },
        agentStatus: "idle",
        hasReleaseImage: false,
      }).reason,
    ).toBe("no release image configured");
    expect(
      resolveBotImageRolloutStatus({
        tracking: { category: "pinned", image: "other/thing:1", reason: "not a digest" },
        agentStatus: "idle",
        hasReleaseImage: true,
      }).reason,
    ).toContain("pinned");
    expect(
      resolveBotImageRolloutStatus({
        tracking: { category: "not_applicable", image: null, reason: "adapterConfig.container is not set" },
        agentStatus: "idle",
        hasReleaseImage: true,
      }).reason,
    ).toBe("not_applicable: adapterConfig.container is not set");
    expect(
      resolveBotImageRolloutStatus({
        tracking: { category: "tracks_release", image: RELEASE_DIGEST },
        agentStatus: "paused",
        hasReleaseImage: true,
      }),
    ).toEqual({ onReleaseImage: true, targetImage: null, reason: null });
  });
});

describe("resolveBotImageRolloutSettings (BOT-ROLLOUT): env → settings override", () => {
  it("env is the default and the upper bound; a stored value wins only inside it", () => {
    const env = {
      MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC: "600",
      MYRMIDON_BOT_IMAGE_ROLLOUT_BATCH_SIZE: "4",
      MYRMIDON_BOT_IMAGE_ROLLOUT_BUSY_SOFT_PAUSE_SEC: "30",
    };
    // defaults from env
    const resolved = resolveBotImageRolloutSettings(env, undefined);
    expect(resolved.botTimeoutSec).toEqual({ value: 600, source: "env", envCap: 600 });
    expect(resolved.batchSize).toEqual({ value: 4, source: "env", envCap: 4 });
    expect(resolved.busySoftPauseSec).toEqual({ value: 30, source: "env", envCap: 30 });
    // stored overrides inside the env cap
    const overridden = resolveBotImageRolloutSettings(env, { botTimeoutSec: 300, batchSize: 2 });
    expect(overridden.botTimeoutSec).toEqual({ value: 300, source: "settings", envCap: 600 });
    expect(overridden.batchSize).toEqual({ value: 2, source: "settings", envCap: 4 });
    // a stored value past the env cap reads as the cap
    expect(resolveBotImageRolloutSettings(env, { botTimeoutSec: 900 }).botTimeoutSec).toEqual({
      value: 600,
      source: "settings",
      envCap: 600,
    });
    // a batch over the module cap is unreadable and falls back to env
    expect(resolveBotImageRolloutSettings({}, { batchSize: 50 }).batchSize).toEqual({ value: 5, source: "default", envCap: 5 });
  });

  it("module defaults when nothing is set; corrupt stored rows read as absent", () => {
    const resolved = resolveBotImageRolloutSettings({}, undefined);
    expect(resolved.botTimeoutSec).toEqual({ value: 900, source: "default", envCap: 900 });
    expect(resolved.batchSize).toEqual({ value: 5, source: "default", envCap: 5 });
    expect(resolved.busySoftPauseSec).toEqual({ value: 0, source: "default", envCap: 0 });
    expect(normalizeBotImageRolloutSettings("not an object")).toEqual({});
    expect(normalizeBotImageRolloutSettings({ botTimeoutSec: "soon" })).toEqual({});
  });

  it("hasReleaseBotImage: only a non-empty MYRMIDON_BOT_RELEASE_IMAGE counts", () => {
    expect(hasReleaseBotImage({})).toBe(false);
    expect(hasReleaseBotImage({ MYRMIDON_BOT_RELEASE_IMAGE: "  " })).toBe(false);
    expect(hasReleaseBotImage({ MYRMIDON_BOT_RELEASE_IMAGE: RELEASE_DIGEST })).toBe(true);
  });
});

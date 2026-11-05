import { describe, expect, it } from "vitest";
import { sharedMountSettingsSchema } from "./myrmidon-shared-mount.js";

describe("shared mount settings", () => {
  const base = { enabled: true, writable: false, allowedBots: [] };

  it("accepts the dedicated default directory and an empty all-bots allowlist", () => {
    expect(sharedMountSettingsSchema.safeParse(base).success).toBe(true);
    expect(sharedMountSettingsSchema.safeParse({ ...base, allowedBots: ["bot-1", "bot_2"] }).success).toBe(true);
  });

  it("rejects malformed and duplicate bot IDs at the API boundary", () => {
    for (const allowedBots of [["../bot"], ["bot id"], ["bot-1", "bot-1"], [""]]) {
      expect(sharedMountSettingsSchema.safeParse({ ...base, allowedBots }).success).toBe(false);
    }
  });
});

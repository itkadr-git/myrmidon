import { describe, expect, it } from "vitest";
import { buildSharedMountPatch, toSharedMountDraft } from "./SharedMountSettingsPanel";

describe("shared mount settings", () => {
  it("starts disabled and interprets an empty allowlist as all bots", () => {
    expect(toSharedMountDraft()).toEqual({ enabled: false, writable: false, allowedBots: "" });
    expect(buildSharedMountPatch({ enabled: true, writable: false, allowedBots: "" })).toEqual({
      enabled: true, writable: false, allowedBots: [],
    });
  });

  it("preserves stored host path for display but never sends it in a patch", () => {
    const draft = toSharedMountDraft({ enabled: true, hostPath: "/srv/shared", writable: true, allowedBots: ["bot-a"] });
    expect(buildSharedMountPatch(draft)).toEqual({ enabled: true, writable: true, allowedBots: ["bot-a"] });
  });

  it("rejects duplicate or malformed bot IDs", () => {
    expect(buildSharedMountPatch({ enabled: true, writable: false, allowedBots: "a, a" })).toBeNull();
    expect(buildSharedMountPatch({ enabled: true, writable: false, allowedBots: "../../etc" })).toBeNull();
  });
});

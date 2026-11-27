import { describe, expect, it } from "vitest";
import { createDiscordAdapterLazy } from "./discord-adapter-loader.js";

describe("Discord adapter loader", () => {
  it("loads the pinned adapter synchronously on demand", () => {
    const adapter = createDiscordAdapterLazy({
      applicationId: "123456789012345678",
      botToken: "test-token",
      userName: "test-agent",
      webhookVerifier: async () => false,
    });
    expect(adapter.name).toBe("discord");
    expect(adapter).toMatchObject({ paperclipCompatibilityRevision: "paperclip-discord-v6" });
  });
});

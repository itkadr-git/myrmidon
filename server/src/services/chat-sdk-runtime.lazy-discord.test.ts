import { afterEach, describe, expect, it, vi } from "vitest";

describe("Discord runtime loading", () => {
  afterEach(() => {
    vi.doUnmock("@chat-adapter/discord");
    vi.resetModules();
  });

  it("does not load Discord when importing the chat runtime", async () => {
    vi.resetModules();
    const load = vi.fn(() => ({ createDiscordAdapter: vi.fn() }));
    vi.doMock("@chat-adapter/discord", load);
    await import("./chat-sdk-runtime.js");
    expect(load).not.toHaveBeenCalled();
  });
});

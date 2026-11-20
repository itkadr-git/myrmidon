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

  it("does not install a Discord endpoint removed while its adapter loads", async () => {
    vi.resetModules();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const loading = vi.fn();
    let hold = false;
    vi.doMock("@chat-adapter/discord", async (importOriginal) => {
      if (hold) {
        loading();
        await gate;
      }
      return await importOriginal();
    });
    const { createChatSdkRuntime } = await import("./chat-sdk-runtime.js");
    hold = true;
    const registry = createChatSdkRuntime();
    const replacement = registry.replaceEndpoint({
      companyId: "company", endpointId: "endpoint", logger: "silent",
      callbacks: { onMessage() {} }, enableDiscordGateway: false,
      persistence: {
        async read() { return null; },
        async compareAndSet() { return true; },
        async deleteIfVersion() { return true; },
      },
      providerConfig: {
        provider: "discord", userName: "agent",
        credentials: { applicationId: "123456789012345678", guildId: "1457808928258658549", botToken: "token" },
      },
    });
    const outcome = replacement.then(() => "installed", (error: Error) => error.message);
    try {
      await vi.waitFor(() => expect(loading).toHaveBeenCalled());
      const removal = registry.removeEndpoint("endpoint");
      release();
      expect(await outcome).toMatch(/superseded/);
      await removal;
      expect(registry.get("endpoint")).toBeNull();
    } finally {
      release();
      await registry.shutdown();
    }
  });
});

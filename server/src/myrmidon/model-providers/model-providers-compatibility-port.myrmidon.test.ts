import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelProviderCatalogPort } from "./service.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("model provider HTTP tool-call probe port", () => {
  const input = {
    baseUrl: "https://provider.invalid/v1",
    apiKey: "test-provider-key",
    model: "vendor-model",
  };

  it("normalizes provider_http_N without exposing the provider body or headers", async () => {
    const providerBody = { error: { message: "Authorization: Bearer leaked-secret" } };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(providerBody), {
        status: 429,
        headers: { "x-provider-debug": "private-header" },
      }),
    );
    const catalog = createModelProviderCatalogPort();

    let error: unknown;
    try {
      await catalog.probeToolCall!(input);
    } catch (caught) {
      error = caught;
    }
    expect(JSON.stringify(providerBody)).toContain("leaked-secret");
    expect(error).toMatchObject({
      code: "provider_http_429",
      message: "the provider answered 429",
    });
    expect(String(error)).not.toContain("leaked-secret");
    expect(String(error)).not.toContain("private-header");
  });

  it("normalizes provider_unreachable without exposing exception details", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Authorization: Bearer leaked-secret; response body: private-body"),
    );
    const catalog = createModelProviderCatalogPort();

    let error: unknown;
    try {
      await catalog.probeToolCall!(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "provider_unreachable",
      message: "the provider could not be reached",
    });
    expect(String(error)).not.toContain("leaked-secret");
    expect(String(error)).not.toContain("private-body");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes a successful HTTP response without the requested tool call", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "not a tool call" } }] })),
    );
    const catalog = createModelProviderCatalogPort();

    await expect(catalog.probeToolCall!(input)).rejects.toMatchObject({
      code: "no_tool_call",
      message: "the provider answered without the requested tool call",
    });
  });
});

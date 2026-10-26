import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@myrmidon/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createSttGigaamPlugin, PLUGIN_ID, PLUGIN_VERSION } from "../src/plugin.js";
import type { FetchLike } from "../src/client.js";

const tokenValue = "secret-token-value";
const serviceHealth = { ready: true, model_loaded: true, vad_loaded: false, fallback_mode: false };
const serviceMetrics = { transcriptions_total: 12, transcription_latency_p50_seconds: 0.31 };

function makeFetch(): FetchLike {
  return vi.fn(async (url: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${tokenValue}`);
    return new Response(JSON.stringify(url.endsWith("/health") ? serviceHealth : serviceMetrics), { status: 200 });
  });
}

describe("GigaAM plugin", () => {
  it("discovers health and metrics and returns only safe operator diagnostics", async () => {
    const fetchImpl = makeFetch();
    const harness = createTestHarness({ manifest, plugin: createSttGigaamPlugin({ fetchImpl }) });
    harness.config = { baseUrl: "https://stt.example.test", authTokenRef: { type: "secret_ref", secretId: "stt-token" } };
    harness.secrets.resolve = vi.fn(async () => tokenValue);
    await harness.setup();
    const result = await harness.plugin.definition.onHealth?.();
    expect(result).toEqual({
      status: "ok",
      message: "GigaAM STT ready",
      details: {
        ready: true,
        modelLoaded: true,
        vadLoaded: false,
        fallbackMode: false,
        transcriptionsTotal: 12,
        transcriptionLatencyP50Seconds: 0.31,
      },
    });
    expect(JSON.stringify(result)).not.toContain(tokenValue);
    expect(JSON.stringify(result)).not.toContain("transcript");
  });

  it("reports degraded health for service fallback mode", async () => {
    const fetchImpl: FetchLike = async (url) => new Response(JSON.stringify(
      url.endsWith("/health") ? { ...serviceHealth, fallback_mode: true } : serviceMetrics,
    ));
    const harness = createTestHarness({ manifest, plugin: createSttGigaamPlugin({ fetchImpl }) });
    await harness.setup();
    const result = await harness.plugin.definition.onHealth?.();
    expect(result?.status).toBe("degraded");
    expect(result?.details).toMatchObject({ fallbackMode: true });
  });

  it("reports unavailable endpoints without exposing backend response details", async () => {
    const fetchImpl: FetchLike = async () => new Response(
      JSON.stringify({ transcript: "private content", credential: tokenValue }), { status: 500 },
    );
    const harness = createTestHarness({ manifest, plugin: createSttGigaamPlugin({ fetchImpl }) });
    await harness.setup();
    const result = await harness.plugin.definition.onHealth?.();
    expect(result?.status).toBe("error");
    expect(result?.message).toBe("GigaAM STT health or metrics are unavailable");
    expect(JSON.stringify(result)).not.toContain(tokenValue);
    expect(JSON.stringify(result)).not.toContain("private content");
  });

  it("validates configuration against the exact candidate endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(serviceHealth)));
    const harness = createTestHarness({ manifest, plugin: createSttGigaamPlugin({ fetchImpl }) });
    await harness.setup();
    const result = await harness.plugin.definition.onValidateConfig?.({
      baseUrl: "https://candidate.example.test",
      authTokenRef: { type: "secret_ref", secretId: "stt-token" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["GigaAM STT health or metrics are unavailable"]);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("declares authenticated discovery capability without secret values in the manifest", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(manifest.capabilities).toContain("http.outbound");
    expect(JSON.stringify(manifest)).not.toContain(tokenValue);
  });
});

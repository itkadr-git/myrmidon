import { describe, expect, it, vi } from "vitest";
import { GigaamClient } from "../src/client.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const health = { ready: true, model_loaded: true, vad_loaded: false, fallback_mode: false };
const metrics = { transcriptions_total: 19, transcription_latency_p50_seconds: 0.42 };

describe("GigaamClient", () => {
  it("discovers authenticated health and metrics from the runtime", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-value");
      return response(url.endsWith("/health") ? health : metrics);
    });

    const result = await new GigaamClient("https://stt.example.test", "secret-value", fetchImpl).snapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ health, metrics });
  });

  it("rejects an oversized response without retaining its contents", async () => {
    const fetchImpl = vi.fn(async () => new Response("x".repeat(70_000)));
    await expect(new GigaamClient("https://stt.example.test", undefined, fetchImpl).snapshot())
      .rejects.toThrow("exceeds size limit");
  });

  it("allows cleartext only on loopback and rejects URL credentials", () => {
    expect(() => new GigaamClient("http://stt.example.test")).toThrow("HTTPS");
    expect(() => new GigaamClient("https://user:pass@stt.example.test")).toThrow("credentials");
    expect(() => new GigaamClient("http://127.0.0.1:8765")).not.toThrow();
  });

  it("rejects non-success endpoint responses without leaking response content", async () => {
    const fetchImpl = vi.fn(async () => response({ transcript: "private words", token: "secret-value" }, 503));
    await expect(new GigaamClient("https://stt.example.test", undefined, fetchImpl).snapshot())
      .rejects.toThrow("HTTP 503");
  });
});

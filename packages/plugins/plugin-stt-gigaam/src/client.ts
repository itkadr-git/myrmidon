import type { EnvSecretRefBinding } from "@myrmidon/plugin-sdk";

export interface GigaamConfig { baseUrl: string; authTokenRef?: EnvSecretRefBinding }
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface GigaamHealth { ready: boolean; model_loaded: boolean; vad_loaded: boolean; fallback_mode: boolean }
export interface GigaamMetrics { transcriptions_total: number; transcription_latency_p50_seconds: number }
export interface GigaamSnapshot { health: GigaamHealth; metrics: GigaamMetrics }
const MAX_RESPONSE_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
async function readText(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`STT endpoint returned HTTP ${response.status}`);
  const size = Number(response.headers.get("content-length"));
  if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) throw new Error("STT response exceeds size limit");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("STT response exceeds size limit");
  return text;
}
function parseHealth(value: unknown): GigaamHealth {
  if (!isRecord(value) || typeof value.ready !== "boolean" || typeof value.model_loaded !== "boolean" || typeof value.vad_loaded !== "boolean" || typeof value.fallback_mode !== "boolean") throw new Error("Invalid STT health response");
  return { ready: value.ready, model_loaded: value.model_loaded, vad_loaded: value.vad_loaded, fallback_mode: value.fallback_mode };
}
function parseMetrics(value: unknown): GigaamMetrics {
  const samples = new Map<string, number>();
  if (typeof value === "string") for (const line of value.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([0-9.eE+-]+)(?:\s+\d+)?$/);
    if (match) samples.set(match[1], Number(match[2]));
  }
  const obj = isRecord(value) ? value : {};
  const total = obj.transcriptions_total ?? obj.stt_transcriptions_total ?? samples.get("stt_transcriptions_total") ?? samples.get("transcriptions_total");
  const p50 = obj.transcription_latency_p50_seconds ?? obj.stt_transcription_latency_p50_seconds ?? obj.transcription_latency_seconds_p50 ?? samples.get("stt_transcription_latency_p50_seconds") ?? samples.get("transcription_latency_p50_seconds");
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0 || typeof p50 !== "number" || !Number.isFinite(p50) || p50 < 0) throw new Error("Required STT metrics are invalid");
  return { transcriptions_total: total, transcription_latency_p50_seconds: p50 };
}
export class GigaamClient {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly token?: string, private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") throw new Error("STT baseUrl must use HTTPS unless it targets loopback");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("STT baseUrl must not contain credentials, query, or fragment");
    this.baseUrl = parsed.toString().replace(/\/$/, "");
  }
  private async get(path: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try { return await this.fetchImpl(this.baseUrl + path, { method: "GET", headers: { Accept: path === "/health" ? "application/json" : "text/plain", ...(this.token ? { Authorization: "Bearer " + this.token } : {}) }, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }
  async snapshot(): Promise<GigaamSnapshot> {
    const [healthResponse, metricsResponse] = await Promise.all([this.get("/health"), this.get("/metrics")]);
    let health: unknown; try { health = JSON.parse(await readText(healthResponse)) as unknown; } catch { throw new Error("Invalid STT health JSON"); }
    const text = await readText(metricsResponse);
    let metrics: unknown; try { metrics = JSON.parse(text) as unknown; } catch { metrics = text; }
    return { health: parseHealth(health), metrics: parseMetrics(metrics) };
  }
}

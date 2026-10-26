import { definePlugin, type EnvSecretRefBinding } from "@myrmidon/plugin-sdk";
import { GigaamClient, type FetchLike } from "./client.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "./manifest.js";

interface PluginConfig {
  baseUrl?: string;
  authTokenRef?: EnvSecretRefBinding;
}

interface PluginDependencies {
  fetchImpl?: FetchLike;
}

function isSecretRef(value: unknown): value is EnvSecretRefBinding {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === "secret_ref" && typeof candidate.secretId === "string" && candidate.secretId.length > 0;
}

function safeBaseUrl(config: PluginConfig): string | null {
  if (typeof config.baseUrl !== "string" || !config.baseUrl.trim()) return null;
  try {
    const url = new URL(config.baseUrl);
    if ((url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
      url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function createSttGigaamPlugin(deps: PluginDependencies = {}) {
  let ctx: { config: { get(companyId?: string): Promise<Record<string, unknown> | null> }; secrets: { resolve(ref: string | EnvSecretRefBinding, options?: { companyId?: string }): Promise<string | null> } } | undefined;

  async function snapshot(configInput?: Record<string, unknown>, companyId?: string) {
    if (!ctx) throw new Error("STT plugin is not initialized");
    const config = (configInput ?? await ctx.config.get(companyId) ?? {}) as PluginConfig;
    const baseUrl = safeBaseUrl(config);
    if (!baseUrl) throw new Error("STT baseUrl is missing or invalid");
    const token = config.authTokenRef ? await ctx.secrets.resolve(config.authTokenRef, { companyId }) : undefined;
    return new GigaamClient(baseUrl, token ?? undefined, deps.fetchImpl).snapshot();
  }

  return definePlugin({
    async setup(pluginContext) {
      ctx = pluginContext;
    },

    async onHealth() {
      try {
        const current = await snapshot();
        const { ready, model_loaded, vad_loaded, fallback_mode } = current.health;
        const healthy = ready && !fallback_mode;
        return {
          status: healthy ? "ok" as const : "degraded" as const,
          message: healthy ? "GigaAM STT ready" : "GigaAM STT is not ready or running in fallback mode",
          details: {
            ready,
            modelLoaded: model_loaded,
            vadLoaded: vad_loaded,
            fallbackMode: fallback_mode,
            transcriptionsTotal: current.metrics.transcriptions_total,
            transcriptionLatencyP50Seconds: current.metrics.transcription_latency_p50_seconds,
          },
        };
      } catch {
        return { status: "error" as const, message: "GigaAM STT health or metrics are unavailable" };
      }
    },

    async onValidateConfig(config) {
      if (!safeBaseUrl(config as PluginConfig)) return { ok: false, errors: ["baseUrl must be HTTPS or loopback HTTP"] };
      const authTokenRef = (config as PluginConfig).authTokenRef;
      if (authTokenRef !== undefined && !isSecretRef(authTokenRef)) {
        return { ok: false, errors: ["authTokenRef must be a secret_ref"] };
      }
      try {
        const current = await snapshot(config);
        if (!current.health.ready) return { ok: false, errors: ["GigaAM STT is not ready"] };
        return { ok: true };
      } catch {
        return { ok: false, errors: ["GigaAM STT health or metrics are unavailable"] };
      }
    },
  });
}

export default createSttGigaamPlugin();

// server/src/myrmidon/litellm-channels/client.ts
//
// myrmidon(1.6.7 OPE-9854): LiteLLM channel management client.
// Calls LiteLLM /model/new, /model/update, /model/delete, /model/block,
// /model/unblock, /model/info.
//
// What LiteLLM v1.104.1 actually does with a channel (verified in its code):
//  - It has no secret manager on our deployments: `api_key` is sent as a VALUE.
//    The board resolves a company secret name to its value before it gets here
//    (service.ts); a `secrets/<name>` reference is refused, never forwarded.
//  - `/model/update` persists `litellm_params` only (merged over the stored
//    ones); `model_info` is ignored. So routing order is `litellm_params.order`
//    (lowest first; a deployment WITHOUT an order is only used when no ordered
//    deployment of the group is healthy) and `weight` is `litellm_params.weight`.
//    `priority`, `disabled` and `provider` are not LiteLLM parameters: never sent.
//  - There is no `disabled` flag in `litellm_params`. A channel is switched off
//    with `POST /model/block { model_id }` and back on with `/model/unblock`:
//    the router filters blocked deployments out before it picks one (order
//    filtering included), the definition and the stored key stay in the
//    gateway, and `/model/info` reports `model_info.blocked`. Only deployments
//    stored in the gateway database can be paused (not static config ones), and
//    the admin key must be a proxy admin key.

import { randomUUID } from "node:crypto";
import { badGateway, unprocessable } from "../../errors.js";
import type {
  AddChannelInput,
  LitellmChannelView,
  LitellmChannelsPort,
  ReorderChannelInput,
  UpdateChannelInput,
} from "./types.js";

export interface LitellmChannelsClientDeps {
  litellmBaseUrl: string;
  litellmAdminKey: string;
}

const SECRET_REFERENCE_PREFIX = "secrets/";

/** The params the board hands back to callers: never a credential, not even a masked one. */
function withoutApiKey(params: Record<string, unknown>): Record<string, unknown> {
  const visible = { ...params };
  delete visible.api_key;
  return visible;
}

function extractSecretName(apiKey: string | undefined | null): string | null {
  if (!apiKey || typeof apiKey !== "string") {
    return null;
  }
  const match = apiKey.match(/^secrets\/(.+)$/);
  return match ? match[1] : null;
}

/** The upstream model id: as given, or prefixed with the provider when only a bare name and a provider are known. */
function upstreamModelOf(input: { providerModel?: string; modelName?: string; providerType?: string }): string | undefined {
  const model = input.providerModel || input.modelName;
  if (!model) return undefined;
  if (input.providerType && !model.includes("/")) return `${input.providerType}/${model}`;
  return model;
}

/** A credential must travel as a value: LiteLLM would store a reference verbatim and send it upstream. */
function assertCredentialValue(apiKey: string | null | undefined): void {
  if (apiKey && apiKey.startsWith(SECRET_REFERENCE_PREFIX)) {
    throw unprocessable("LiteLLM has no secret manager: send the credential value, not a secrets/<name> reference", {
      code: "litellm_credential_reference",
    });
  }
}

export function createLitellmChannelsClient(deps: LitellmChannelsClientDeps): LitellmChannelsPort {
  function url(path: string): string {
    const base = deps.litellmBaseUrl.replace(/\/+$/, "");
    return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  async function callLiteLLM<T>(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: Record<string, unknown>;
    } = {},
  ): Promise<T> {
    const method = options.method ?? "POST";
    let response: Response;

    try {
      response = await fetch(url(path), {
        method,
        headers: {
          Authorization: `Bearer ${deps.litellmAdminKey}`,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw badGateway(`Failed to connect to LiteLLM: ${message}`, {
        code: "litellm_connection_failed",
      });
    }

    if (!response.ok) {
      let detail: string | undefined;
      try {
        const text = await response.text();
        try {
          const parsed = JSON.parse(text);
          detail = parsed?.error?.message ?? parsed?.detail ?? parsed?.message ?? text;
        } catch {
          detail = text;
        }
      } catch {
        // ignore read error
      }

      const message = detail
        ? `LiteLLM ${path} failed (${response.status}): ${detail}`
        : `LiteLLM ${path} answered ${response.status}`;

      throw unprocessable(message, {
        code: "litellm_request_failed",
        status: response.status,
        detail,
      });
    }

    try {
      return (await response.json()) as T;
    } catch {
      return {} as T;
    }
  }

  function parseChannelFromDeployment(model: Record<string, any>): LitellmChannelView {
    const modelInfo = (model.model_info && typeof model.model_info === "object" ? model.model_info : {}) as Record<string, any>;
    const litellmParams = (model.litellm_params && typeof model.litellm_params === "object" ? model.litellm_params : {}) as Record<string, any>;

    const id = String(modelInfo.id || model.id || model.model_name || "");
    const modelName = String(model.model_name || model.id || "");
    const providerModel = String(litellmParams.model || model.model_name || "");
    const upstreamPrefix = providerModel.includes("/") ? providerModel.split("/")[0] : "";
    const providerRaw = litellmParams.provider || litellmParams.custom_llm_provider || upstreamPrefix;
    const providerType = providerRaw ? String(providerRaw) : null;
    const baseUrl = litellmParams.api_base ? String(litellmParams.api_base) : null;
    const credentialSecretName = extractSecretName(litellmParams.api_key);

    // The router reads `litellm_params` first and `model_info` only as a
    // fallback for dynamically added models.
    const rawOrder = litellmParams.order ?? modelInfo.order ?? 0;
    const order = Number.isFinite(Number(rawOrder)) ? Number(rawOrder) : 0;

    const rawWeight = litellmParams.weight ?? modelInfo.weight ?? 0;
    const weight = Number.isFinite(Number(rawWeight)) ? Number(rawWeight) : 0;

    // The only switch-off the router honors is the deployment's `blocked` flag.
    const disabled = modelInfo.blocked === true;

    return {
      id,
      modelName,
      providerModel,
      providerType,
      baseUrl,
      credentialSecretName,
      order,
      weight,
      disabled,
      litellmParams: withoutApiKey(litellmParams),
      modelInfo,
    };
  }

  async function listAll(): Promise<LitellmChannelView[]> {
    const data = await callLiteLLM<any>("/model/info", { method: "GET" });
    const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    return list.map((item: Record<string, any>) => parseChannelFromDeployment(item));
  }

  /** The `litellm_params` an update writes: only what the caller set, only keys LiteLLM understands. */
  function updateParams(input: UpdateChannelInput): Record<string, unknown> {
    assertCredentialValue(input.apiKey);
    const model = upstreamModelOf(input);
    return {
      ...(model ? { model } : {}),
      ...(input.baseUrl ? { api_base: input.baseUrl } : {}),
      ...(input.apiKey ? { api_key: input.apiKey } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
      ...(input.weight !== undefined ? { weight: input.weight } : {}),
      ...input.additionalConfig,
    };
  }

  /** Writes the parameter changes of one channel (`/model/update`), without re-reading it. */
  async function applyUpdate(input: UpdateChannelInput): Promise<void> {
    const litellmParams = updateParams(input);
    if (Object.keys(litellmParams).length > 0 || input.modelName) {
      await callLiteLLM("/model/update", {
        method: "POST",
        body: {
          model_info: { id: input.channelId },
          ...(input.modelName ? { model_name: input.modelName } : {}),
          ...(Object.keys(litellmParams).length > 0 ? { litellm_params: litellmParams } : {}),
        },
      });
    }
    if (input.disabled !== undefined) {
      await setBlocked(input.channelId, input.disabled);
    }
  }

  async function setBlocked(channelId: string, blocked: boolean): Promise<void> {
    await callLiteLLM(blocked ? "/model/block" : "/model/unblock", {
      method: "POST",
      body: { model_id: channelId },
    });
  }

  /** One channel as the gateway reports it now; null when `/model/info` does not list it. */
  async function readChannel(channelId: string): Promise<LitellmChannelView | null> {
    return (await listAll()).find((channel) => channel.id === channelId) ?? null;
  }

  async function updateChannel(input: UpdateChannelInput): Promise<LitellmChannelView> {
    await applyUpdate(input);
    const current = await readChannel(input.channelId);
    if (current) return current;
    // The gateway accepted the change but does not list the deployment (a
    // lagging read): answer what was written rather than failing a success.
    return {
      id: input.channelId,
      modelName: input.modelName ?? "",
      providerModel: upstreamModelOf(input) ?? "",
      providerType: input.providerType ?? null,
      baseUrl: input.baseUrl ?? null,
      credentialSecretName: input.credentialSecretName ?? null,
      order: input.order ?? 0,
      weight: input.weight ?? 0,
      disabled: input.disabled ?? false,
      modelInfo: { id: input.channelId },
    };
  }

  return {
    async listChannels(): Promise<LitellmChannelView[]> {
      return listAll();
    },

    async addChannel(input: AddChannelInput): Promise<LitellmChannelView> {
      assertCredentialValue(input.apiKey);
      // A channel created paused needs its id before the first call, so the
      // pause can never miss the deployment it belongs to.
      const channelId = input.channelId || (input.disabled ? randomUUID() : null);
      const litellmParams: Record<string, unknown> = {
        model: upstreamModelOf(input),
        ...(input.baseUrl ? { api_base: input.baseUrl } : {}),
        ...(input.apiKey ? { api_key: input.apiKey } : {}),
        ...(input.order !== undefined ? { order: input.order } : {}),
        ...(input.weight !== undefined ? { weight: input.weight } : {}),
        ...input.additionalConfig,
      };

      const payload = {
        model_name: input.modelName,
        litellm_params: litellmParams,
        model_info: channelId ? { id: channelId } : {},
      };

      const res = await callLiteLLM<any>("/model/new", {
        method: "POST",
        body: payload,
      });

      const returnedId = String(
        channelId ||
          res?.data?.model_info?.id ||
          res?.data?.id ||
          res?.model_info?.id ||
          res?.model_id ||
          res?.id ||
          input.modelName,
      );

      if (input.disabled) {
        try {
          await setBlocked(returnedId, true);
        } catch (err) {
          // Never leave a channel that was meant to be off serving traffic.
          try {
            await callLiteLLM("/model/delete", { method: "POST", body: { id: returnedId } });
          } catch {
            // the original failure is the one worth reporting
          }
          throw err;
        }
      }

      return {
        id: returnedId,
        modelName: input.modelName,
        providerModel: String(litellmParams.model ?? input.modelName),
        providerType: input.providerType ?? null,
        baseUrl: input.baseUrl ?? null,
        credentialSecretName: input.credentialSecretName ?? null,
        order: input.order ?? 0,
        weight: input.weight ?? 0,
        disabled: Boolean(input.disabled),
        litellmParams: withoutApiKey(litellmParams),
        modelInfo: { id: returnedId, ...(input.disabled ? { blocked: true } : {}) },
      };
    },

    updateChannel,

    async disableChannel(channelId: string): Promise<LitellmChannelView> {
      return updateChannel({ channelId, disabled: true });
    },

    async enableChannel(channelId: string): Promise<LitellmChannelView> {
      return updateChannel({ channelId, disabled: false });
    },

    async deleteChannel(channelId: string): Promise<void> {
      await callLiteLLM("/model/delete", {
        method: "POST",
        body: { id: channelId },
      });
    },

    async reorderChannels(orders: ReorderChannelInput[]): Promise<LitellmChannelView[]> {
      for (const item of orders) {
        await applyUpdate({ channelId: item.channelId, order: item.order });
      }
      // One read for the whole batch.
      const ids = new Set(orders.map((item) => item.channelId));
      return (await listAll()).filter((channel) => ids.has(channel.id));
    },
  };
}

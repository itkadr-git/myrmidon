// server/src/myrmidon/litellm-sync/port.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): the LiteLLM admin API surface.
//
// LiteLLM (with STORE_MODEL_IN_DB) accepts /model/new, /model/delete, /model/info
// calls to register models dynamically. This module provides the client surface
// for those calls, abstracting the HTTP transport and credential handling.

export interface LitellmChannelView {
  /** Gateway deployment/channel id (`model_info.id`), when reported. */
  id: string | null;
  /** The model group name in LiteLLM (`model_name`). */
  group: string;
  /** The upstream provider type (e.g. 'openai', 'azure', 'dashscope'). */
  provider: string;
  /** The provider's model identifier (e.g. 'openai/gpt-4o', 'gpt-4o'). */
  providerModel: string;
  /** Routing fallback order / priority, if set. */
  order: number | null;
  /** Routing weight for load balancing, if set. */
  weight: number | null;
}

export interface LitellmSyncPort {
  /**
   * Registers a deployment in LiteLLM (`POST /model/new`).
   *
   * LiteLLM has no secret manager on our deployments, so the credential is
   * sent as a VALUE (`credentialValue`), resolved on the board from the
   * company secrets. A `secrets/<name>` reference would be stored verbatim and
   * sent upstream as the API key. Routing order goes through
   * `litellm_params.order`: `/model/update` persists only `litellm_params`, and
   * `priority`, `disabled` and `provider` are not LiteLLM parameters at all
   * (the router has no per-deployment disabled flag), so none of them is sent.
   */
  registerModel(input: {
    /** The model name (group) LiteLLM will recognize; the board's registry name. */
    litellmModelName: string;
    /**
     * The upstream model identifier without the provider prefix (`gpt-4o`).
     * Defaults to `litellmModelName`; set it whenever the registry name is not
     * the provider's own spelling (`kimi/kimi-for-coding` -> `kimi-for-coding`).
     */
    providerModel?: string;
    /** The provider type (e.g., 'openai', 'dashscope'). */
    providerType: string;
    /** The provider's base URL; null means default. */
    baseUrl: string | null;
    /** The credential value; LiteLLM encrypts it in its own database. */
    credentialValue?: string;
    /** @deprecated retained for adapter compatibility; production wiring sends credentialValue. */
    credentialSecretName?: string;
    /** Routing order of the channel within the model group (`litellm_params.order`; lowest first). */
    order?: number;
    /** Routing weight for load balancing (`litellm_params.weight`). */
    weight?: number;
    /** Additional LiteLLM-specific configuration. */
    additionalConfig?: Record<string, unknown>;
  }): Promise<void>;

  /**
   * Removes the deployments registered under a model name from LiteLLM.
   *
   * `/model/delete` takes only a deployment id (`{ id }`), so the client looks
   * the deployments up in `/model/info` and deletes each by `model_info.id`.
   * With `match.baseUrl` set (a string, or `null` for "no api_base") only the
   * deployments with that api_base are removed, so a deployment the board does
   * not own under the same name stays. Deployments that live in the static
   * gateway config cannot be deleted through the API and are never targeted.
   * A name with no deployment is a no-op: the call is safe to repeat.
   */
  unregisterModel(litellmModelName: string, match?: { baseUrl?: string | null }): Promise<void>;

  /**
   * Updates an existing deployment in place (`POST /model/update`, addressed by
   * deployment id; LiteLLM merges `litellm_params` and ignores `model_info`).
   * No second deployment is created and the model is never absent from the
   * gateway.
   */
  updateDeployment(input: {
    modelId: string;
    litellmModelName: string;
    /** The upstream model identifier without the provider prefix; defaults to `litellmModelName`. */
    providerModel?: string;
    providerType: string;
    baseUrl: string | null;
    /** The credential value to pass to LiteLLM; LiteLLM encrypts it in its DB. Omitted: the stored key is kept. */
    credentialValue?: string;
    /** @deprecated retained for adapter compatibility; never sent by production wiring. */
    credentialSecretName?: string;
    /** Routing order of the channel within the model group (`litellm_params.order`). */
    order?: number;
    /** Routing weight for load balancing (`litellm_params.weight`). */
    weight?: number;
    additionalConfig?: Record<string, unknown>;
  }): Promise<void>;

  /** Removes one deployment by its id (`POST /model/delete` with `{ id }`). */
  deleteDeployment(modelId: string): Promise<void>;

  /**
   * Drops gateway-side cached responses and resolved routing/credential state.
   * Optional because older LiteLLM deployments may not expose cache deletion.
   */
  invalidateCache?(): Promise<void>;

  /**
   * Fetches the list of currently registered models from LiteLLM.
   */
  listRegisteredModels(): Promise<Array<{
    /** The gateway deployment id (`model_info.id`), when the gateway reports one. */
    modelId?: string;
    /** The model name as registered in LiteLLM. */
    litellmModelName: string;
    /** The provider type. */
    providerType: string;
    /** The base URL used. */
    baseUrl: string | null;
    /** The credential secret name reference; empty when the key is stored as a value (the gateway never reveals it). */
    credentialSecretName: string;
  }>>;

  /**
   * Fetches the model groups and channels from LiteLLM /model/info.
   * Returns key-free channel views (group, provider, providerModel, order, weight).
   */
  listChannels(): Promise<LitellmChannelView[]>;
}
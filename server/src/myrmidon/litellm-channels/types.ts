// server/src/myrmidon/litellm-channels/types.ts
//
// myrmidon(1.6.7 OPE-9854): LiteLLM channel management types.

export interface LitellmChannelView {
  /** The gateway deployment id (`model_info.id`). */
  id: string;
  modelName: string;
  providerModel: string;
  providerType: string | null;
  baseUrl: string | null;
  /** Set when the channel was written with a board secret reference; the gateway never reveals a stored key. */
  credentialSecretName: string | null;
  /** Routing order within the model group (`litellm_params.order`, lowest first); 0 when the deployment has none. */
  order: number;
  /** Routing weight (`litellm_params.weight`). */
  weight: number;
  /** True when the deployment is paused in the gateway (`model_info.blocked`): the router never picks it. */
  disabled: boolean;
  /** The deployment's `litellm_params` without the credential. */
  litellmParams?: Record<string, unknown>;
  modelInfo?: Record<string, unknown>;
}

export interface AddChannelInput {
  modelName: string;
  providerModel?: string;
  providerType?: string;
  baseUrl?: string | null;
  /** The company secret the key comes from. The service resolves it to `apiKey`; it is never sent to the gateway. */
  credentialSecretName?: string | null;
  /** The credential VALUE the gateway stores (it has no secret manager). */
  apiKey?: string | null;
  channelId?: string | null;
  order?: number;
  weight?: number;
  /** Create the channel paused (`/model/block` right after creation). */
  disabled?: boolean;
  additionalConfig?: Record<string, unknown>;
}

export interface UpdateChannelInput {
  channelId: string;
  modelName?: string;
  providerModel?: string;
  providerType?: string;
  baseUrl?: string | null;
  /** The company secret the key comes from. The service resolves it to `apiKey`; it is never sent to the gateway. */
  credentialSecretName?: string | null;
  /** The credential VALUE the gateway stores (it has no secret manager). */
  apiKey?: string | null;
  order?: number;
  weight?: number;
  /** true pauses the deployment (`/model/block`), false resumes it (`/model/unblock`). */
  disabled?: boolean;
  additionalConfig?: Record<string, unknown>;
}

export interface ReorderChannelInput {
  channelId: string;
  order: number;
}

export interface LitellmChannelsPort {
  listChannels(): Promise<LitellmChannelView[]>;
  addChannel(input: AddChannelInput): Promise<LitellmChannelView>;
  updateChannel(input: UpdateChannelInput): Promise<LitellmChannelView>;
  disableChannel(channelId: string): Promise<LitellmChannelView>;
  enableChannel(channelId: string): Promise<LitellmChannelView>;
  deleteChannel(channelId: string): Promise<void>;
  reorderChannels(orders: ReorderChannelInput[]): Promise<LitellmChannelView[]>;
}

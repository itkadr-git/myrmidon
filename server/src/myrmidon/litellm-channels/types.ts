// server/src/myrmidon/litellm-channels/types.ts
//
// myrmidon(1.6.7 OPE-9854): LiteLLM channel management types.

export interface LitellmChannelView {
  id: string;
  modelName: string;
  providerModel: string;
  providerType: string | null;
  baseUrl: string | null;
  credentialSecretName: string | null;
  order: number;
  weight: number;
  disabled: boolean;
  litellmParams?: Record<string, unknown>;
  modelInfo?: Record<string, unknown>;
}

export interface AddChannelInput {
  modelName: string;
  providerModel?: string;
  providerType?: string;
  baseUrl?: string | null;
  credentialSecretName?: string | null;
  apiKey?: string | null;
  channelId?: string | null;
  order?: number;
  weight?: number;
  disabled?: boolean;
  additionalConfig?: Record<string, unknown>;
}

export interface UpdateChannelInput {
  channelId: string;
  modelName?: string;
  providerModel?: string;
  providerType?: string;
  baseUrl?: string | null;
  credentialSecretName?: string | null;
  apiKey?: string | null;
  order?: number;
  weight?: number;
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

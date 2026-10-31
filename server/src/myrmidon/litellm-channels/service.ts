// server/src/myrmidon/litellm-channels/service.ts
//
// myrmidon(1.6.7 OPE-9854): Server command layer for LiteLLM channel operations.

import type { Db } from "@myrmidon/db";
import { readGatewayKeySettings } from "@myrmidon/shared";
import { serviceUnavailable, unprocessable, badRequest } from "../../errors.js";
import { createLitellmChannelsClient, type LitellmChannelsClientDeps } from "./client.js";
import type {
  AddChannelInput,
  LitellmChannelView,
  LitellmChannelsPort,
  ReorderChannelInput,
  UpdateChannelInput,
} from "./types.js";

export interface LitellmChannelsDeps {
  db: Db;
  readSecretValue: (companyId: string, secretName: string) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  clientFactory?: (deps: LitellmChannelsClientDeps) => LitellmChannelsPort;
  resolvePort?: (companyId: string) => Promise<LitellmChannelsPort | null>;
}

export interface LitellmChannelsService {
  listChannels(companyId: string): Promise<LitellmChannelView[]>;
  addChannel(companyId: string, input: AddChannelInput): Promise<LitellmChannelView>;
  updateChannel(companyId: string, input: UpdateChannelInput): Promise<LitellmChannelView>;
  disableChannel(companyId: string, channelId: string): Promise<LitellmChannelView>;
  enableChannel(companyId: string, channelId: string): Promise<LitellmChannelView>;
  deleteChannel(companyId: string, channelId: string): Promise<void>;
  reorderChannels(companyId: string, orders: ReorderChannelInput[]): Promise<LitellmChannelView[]>;
}

export function createLitellmChannelsService(deps: LitellmChannelsDeps): LitellmChannelsService {
  const env = deps.env ?? process.env;

  async function getPort(companyId: string): Promise<LitellmChannelsPort> {
    if (deps.resolvePort) {
      const customPort = await deps.resolvePort(companyId);
      if (customPort) return customPort;
    }

    const settings = readGatewayKeySettings(env);
    const baseUrl = env.MYRMIDON_LITELLM_BASE_URL || settings.baseUrl;
    const directKey = env.LITELLM_ADMIN_KEY || env.LITELLM_MASTER_KEY;

    if (!baseUrl) {
      throw serviceUnavailable("LLM gateway channel management is not enabled (missing base URL)");
    }

    let adminKey = directKey || null;
    if (!adminKey && settings.adminKeySecret) {
      adminKey = await deps.readSecretValue(companyId, settings.adminKeySecret);
    }

    if (!adminKey) {
      throw serviceUnavailable("LLM gateway channel management is not enabled (missing admin key)");
    }

    const factory = deps.clientFactory ?? createLitellmChannelsClient;
    return factory({
      litellmBaseUrl: baseUrl,
      litellmAdminKey: adminKey,
    });
  }

  return {
    async listChannels(companyId: string): Promise<LitellmChannelView[]> {
      const port = await getPort(companyId);
      return port.listChannels();
    },

    async addChannel(companyId: string, input: AddChannelInput): Promise<LitellmChannelView> {
      if (!input.modelName || typeof input.modelName !== "string" || !input.modelName.trim()) {
        throw badRequest("modelName is required and must not be empty");
      }
      const providerModel = input.providerModel || input.modelName;
      if (!providerModel || typeof providerModel !== "string" || !providerModel.trim()) {
        throw badRequest("providerModel is required and must not be empty");
      }
      if (input.order !== undefined && (!Number.isFinite(input.order) || input.order < 0)) {
        throw badRequest("order must be a non-negative number");
      }
      if (input.weight !== undefined && (!Number.isFinite(input.weight) || input.weight < 0)) {
        throw badRequest("weight must be a non-negative number");
      }

      const port = await getPort(companyId);
      return port.addChannel({
        ...input,
        modelName: input.modelName.trim(),
        providerModel: providerModel.trim(),
      });
    },

    async updateChannel(companyId: string, input: UpdateChannelInput): Promise<LitellmChannelView> {
      if (!input.channelId || typeof input.channelId !== "string" || !input.channelId.trim()) {
        throw badRequest("channelId is required");
      }
      if (input.order !== undefined && (!Number.isFinite(input.order) || input.order < 0)) {
        throw badRequest("order must be a non-negative number");
      }
      if (input.weight !== undefined && (!Number.isFinite(input.weight) || input.weight < 0)) {
        throw badRequest("weight must be a non-negative number");
      }

      const port = await getPort(companyId);
      return port.updateChannel(input);
    },

    async disableChannel(companyId: string, channelId: string): Promise<LitellmChannelView> {
      if (!channelId || typeof channelId !== "string" || !channelId.trim()) {
        throw badRequest("channelId is required");
      }
      const port = await getPort(companyId);
      return port.disableChannel(channelId.trim());
    },

    async enableChannel(companyId: string, channelId: string): Promise<LitellmChannelView> {
      if (!channelId || typeof channelId !== "string" || !channelId.trim()) {
        throw badRequest("channelId is required");
      }
      const port = await getPort(companyId);
      return port.enableChannel(channelId.trim());
    },

    async deleteChannel(companyId: string, channelId: string): Promise<void> {
      if (!channelId || typeof channelId !== "string" || !channelId.trim()) {
        throw badRequest("channelId is required");
      }
      const port = await getPort(companyId);
      return port.deleteChannel(channelId.trim());
    },

    async reorderChannels(companyId: string, orders: ReorderChannelInput[]): Promise<LitellmChannelView[]> {
      if (!Array.isArray(orders) || orders.length === 0) {
        throw badRequest("orders must be a non-empty array");
      }
      for (const item of orders) {
        if (!item.channelId || typeof item.channelId !== "string") {
          throw badRequest("Each order item must contain a valid channelId");
        }
        if (item.order === undefined || !Number.isFinite(item.order) || item.order < 0) {
          throw badRequest("Each order item must contain a non-negative order");
        }
      }
      const port = await getPort(companyId);
      return port.reorderChannels(orders);
    },
  };
}

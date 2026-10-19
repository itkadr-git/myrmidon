// packages/shared/src/myrmidon-model-providers.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS): names, defaults and payload schemas of the
// company model-provider settings API.
//
// Pure data and pure functions only — no addresses, no key values. The server,
// the compiler and the tests read one source of truth:
//
//  - the secret-store NAME a provider credential lives under (derived from the
//    provider row id, so two providers can never collide on one secret and a
//    rename cannot orphan a key);
//  - the default base URL per provider type (a base URL is not a secret);
//  - the request/response contracts of the settings API as zod schemas.
//
// The key value itself is accepted by POST/PATCH, stored in the secret store,
// and NEVER answered back — the API answers `has_key` only.

import { z } from "zod";

/** Prefix of a model-provider credential name in the company secret store. */
export const MODEL_PROVIDER_SECRET_PREFIX = "model-provider-key-";

/** Built-in provider kinds supported out of the box without external connectors. */
export const BUILTIN_MODEL_PROVIDER_TYPES = [
  "openai",
  "dashscope",
  "google",
  "openai-compatible",
] as const;
export type BuiltinModelProviderType = (typeof BUILTIN_MODEL_PROVIDER_TYPES)[number];

/** Statically known provider kinds for type safety. */
export const MODEL_PROVIDER_TYPES = [
  ...BUILTIN_MODEL_PROVIDER_TYPES,
  "chatgpt-pool",
] as const;
export type ModelProviderType = (typeof MODEL_PROVIDER_TYPES)[number];

/** Default base URL per built-in provider type; null means the provider's own default. */
export const MODEL_PROVIDER_DEFAULT_BASE_URLS: Readonly<
  Record<string, string | null>
> = {
  openai: "https://api.openai.com/v1",
  dashscope: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  google: "https://generativelanguage.googleapis.com/v1beta-openai",
  "openai-compatible": null,
};

/** Connector specification for closed/paid or plugin-based model providers. */
export interface ModelProviderConnectorRegistration {
  type: string;
  name?: string;
  pluginKey?: string;
  defaultBaseUrl?: string | null;
  defaultModels?: readonly string[];
  supportsChannels?: boolean;
}

const registeredModelProviderConnectors = new Map<string, ModelProviderConnectorRegistration>();

export function registerModelProviderConnector(reg: ModelProviderConnectorRegistration): void {
  registeredModelProviderConnectors.set(reg.type, reg);
}

export function unregisterModelProviderConnector(type: string): void {
  registeredModelProviderConnectors.delete(type);
}

export function unregisterModelProviderConnectorsByPlugin(pluginKey: string): void {
  for (const [type, reg] of registeredModelProviderConnectors.entries()) {
    if (reg.pluginKey === pluginKey) {
      registeredModelProviderConnectors.delete(type);
    }
  }
}

export function getModelProviderConnector(type: string): ModelProviderConnectorRegistration | null {
  return registeredModelProviderConnectors.get(type) ?? null;
}

export function clearModelProviderConnectors(): void {
  registeredModelProviderConnectors.clear();
}

/** Lists provider types currently available (built-in + active registered connectors). */
export function listAvailableModelProviderTypes(): string[] {
  return [...BUILTIN_MODEL_PROVIDER_TYPES, ...registeredModelProviderConnectors.keys()];
}

export function isModelProviderTypeAvailable(type: string): boolean {
  return listAvailableModelProviderTypes().includes(type);
}

/** Default models for the closed chatgpt-pool connector (provided on registration). */
export const DEFAULT_CHATGPT_POOL_MODELS = [
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

/** The models-list path every supported provider speaks (OpenAI-compatible). */
export const MODEL_PROVIDER_MODELS_PATH = "/models";

/** Account state in the Codex / ChatGPT subscription pool. */
export type PoolAccountState =
  | "active"
  | "rate_limited"
  | "token_expired"
  | "banned"
  | "login_pending"
  | "login_expired"
  | "not_logged_in";

/** A quota window on a subscription account (e.g. 5-hour rolling or weekly). */
export interface PoolAccountLimitWindow {
  usedPct: number | null;
  windowMin: number | null;
  resetsAt: number | null;
}

/** Usage metrics observed on a subscription account. */
export interface PoolAccountUsage {
  primary: PoolAccountLimitWindow | null;
  secondary: PoolAccountLimitWindow | null;
  plan?: string | null;
  limitReached?: boolean;
  requests24h?: number;
  requests7d?: number;
  tokens24h?: { input: number; output: number };
  tokens7d?: { input: number; output: number };
  lastLimitAt?: number | null;
  recentErrors?: Array<{ at: number; status: number; message: string }>;
}

/** One account in the provider's channel registry (OPE-7189 ч.A). */
export interface PoolAccountChannelView {
  n: number;
  label: string;
  email?: string | null;
  state: PoolAccountState | string;
  stateRu?: string;
  plan?: string | null;
  limitedUntil: number | null;
  lastOk: number | null;
  windows: {
    primary: PoolAccountLimitWindow | null;
    secondary: PoolAccountLimitWindow | null;
  };
  usage?: PoolAccountUsage;
  isBanned: boolean;
  isExhausted: boolean;
  error?: string | null;
}

/** Role notification signal when an account is banned or limit-exhausted. */
export interface PoolAccountRoleSignal {
  dedupKey: string;
  providerId?: string;
  accountNumber: number;
  label: string;
  kind: "banned" | "exhausted";
  severity: "critical" | "high" | "medium";
  title: string;
  whyNow: string;
  summaryExcerpt: string;
  resetsAt: number | null;
  activityAt: string;
}

/** Channels and active signals of a model provider. */
export interface ModelProviderChannelsView {
  providerId: string;
  providerType: ModelProviderType;
  channels: PoolAccountChannelView[];
  signals: PoolAccountRoleSignal[];
}

/**
 * The secret-store name that carries one provider's credential.
 *
 * Derived from the provider row id, not its display name: a display name is
 * editable and enforced unique per company, so a rename would orphan the key
 * under a name-derived secret. The id is stable and unique.
 */
export function modelProviderSecretName(providerId: string): string {
  const id = providerId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return `${MODEL_PROVIDER_SECRET_PREFIX}${id}`;
}

/** Whether a secret name is one this feature manages. */
export function isModelProviderSecretName(name: string): boolean {
  return name.startsWith(MODEL_PROVIDER_SECRET_PREFIX);
}

/** POST /providers body. `key` is accepted, validated and never echoed back. */
export const createModelProviderSchema = z
  .object({
    type: z.enum(MODEL_PROVIDER_TYPES),
    name: z.string().trim().min(1).max(160),
    baseUrl: z.string().trim().url().max(2048).optional().nullable(),
    key: z.string().min(1).max(4096),
    free: z.boolean().optional(),
    expiresAt: z.string().datetime().optional().nullable(),
    packageName: z.string().trim().max(160).optional().nullable(),
    rpmLimit: z.number().int().positive().optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "openai-compatible" && !value.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: "baseUrl is required for an openai-compatible provider",
      });
    }
  });
export type CreateModelProviderInput = z.infer<typeof createModelProviderSchema>;

/** PATCH /providers/{id} body: the rotation (and optional metadata edits). */
export const patchModelProviderSchema = z.object({
  key: z.string().min(1).max(4096).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  baseUrl: z.string().trim().url().max(2048).optional().nullable(),
  free: z.boolean().optional(),
  expiresAt: z.string().datetime().optional().nullable(),
  packageName: z.string().trim().max(160).optional().nullable(),
  rpmLimit: z.number().int().positive().optional().nullable(),
});
export type PatchModelProviderInput = z.infer<typeof patchModelProviderSchema>;

/** POST /providers/{id}/models body: the per-model enable/disable switches. */
export const setModelProviderModelsSchema = z.object({
  models: z
    .array(
      z.object({
        modelName: z.string().trim().min(1).max(512),
        enabled: z.boolean().optional(),
        free: z.boolean().optional(),
      }),
    )
    .max(500),
});
export type SetModelProviderModelsInput = z.infer<typeof setModelProviderModelsSchema>;

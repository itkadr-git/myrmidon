// myrmidon(1.6.1 MODEL-PROVIDERS C): API client for the "Model providers"
// settings screen. Speaks the Part A contract (branch
// myr/1.6.1-model-providers-store) against
// /api/myrmidon/companies/:id/model-providers:
//   POST   /providers            (add; key write-only, never returned)
//   GET    /providers            (list without the key, hasKey flag)
//   PATCH  /providers/:pid       (rotate key)
//   DELETE /providers/:pid
//   GET    /providers/:pid/models (cached model list from validation)
//   POST   /providers/:pid/models (enable/disable models)
// The screen is written against this contract while Part A merges; the
// response types carry only key-free fields.
import { api } from "@/api/client";

export const BUILTIN_MODEL_PROVIDER_TYPES = [
  "dashscope",
  "openai",
  "google",
  "openai-compatible",
] as const;

export const MODEL_PROVIDER_TYPES = [
  ...BUILTIN_MODEL_PROVIDER_TYPES,
  "chatgpt-pool",
  "antigravity-pool",
  "google-ai-pool",
] as const;

export type BuiltinModelProviderType = (typeof BUILTIN_MODEL_PROVIDER_TYPES)[number];
export type ModelProviderType = (typeof MODEL_PROVIDER_TYPES)[number];

export interface ModelProviderView {
  id: string;
  type: ModelProviderType;
  name: string;
  baseUrl: string | null;
  /** The key is write-only: the API answers only whether one is stored. */
  hasKey: boolean;
  free: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProviderModelView {
  modelName: string;
  litellmModelName: string;
  enabled: boolean;
  free: boolean;
}

export interface ModelProviderModelsView {
  providerId: string;
  models: ModelProviderModelView[];
}

export interface ModelProviderChangeLogEntry {
  id: string;
  at: string;
  // myrmidon(OPE-12361): the server carries the author display name when known.
  actor: { type: "board" | "agent" | "system" | string; id: string; name?: string | null };
  action: "provider_added" | "provider_rotated" | "provider_removed" | "models_updated" | string;
  summary: string;
  category?: "models" | "fallbacks" | "keys" | string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  canRollback?: boolean;
}

export type PoolAccountState =
  | "active"
  | "rate_limited"
  | "token_expired"
  | "banned"
  | "login_pending"
  | "login_expired"
  | "not_logged_in";

export interface PoolAccountLimitWindow {
  usedPct: number | null;
  windowMin: number | null;
  resetsAt: number | null;
}

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

export interface PoolAccountChannelView {
  n: number;
  label: string;
  email?: string | null;
  state: PoolAccountState | string;
  stateRu?: string;
  plan?: string | null;
  models?: string[];
  limitedUntil: number | null;
  lastOk: number | null;
  error?: string | null;
  windows: {
    primary: PoolAccountLimitWindow | null;
    secondary: PoolAccountLimitWindow | null;
  };
  usage?: PoolAccountUsage;
  isBanned: boolean;
  isExhausted: boolean;
  isDisabled?: boolean;
  isExcluded?: boolean;
  oauthState?: string;
  oauthExpiresAt?: number | null;
}

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

export interface ModelProviderChannelsView {
  providerId: string;
  providerType: ModelProviderType;
  channels: PoolAccountChannelView[];
  signals: PoolAccountRoleSignal[];
  // myrmidon(OPE-12361): keep in sync with ModelProviderChannelsView in
  // @myrmidon/shared (error-account counter and pool reset passthrough).
  summary?: {
    total: number;
    live: number;
    exhausted: number;
    banned: number;
    error: number;
    disabled?: number;
    nextResetAt: number | null;
    nextResetText: string | null;
  };
}

export interface LitellmChannelView {
  id: string | null;
  group: string;
  provider: string;
  providerModel: string;
  order: number | null;
  weight: number | null;
}

export interface LitellmChannelsResponse {
  channels: LitellmChannelView[];
  enabled?: boolean;
  error?: string | null;
  message?: string | null;
}

export interface ModelProvidersView {
  providers: ModelProviderView[];
  availableTypes?: ModelProviderType[] | string[];
  changeLog: ModelProviderChangeLogEntry[];
}

/** POST body — carries the raw key once, only on the wire to the server. */
export interface AddModelProviderInput {
  type: ModelProviderType;
  name: string;
  baseUrl: string | null;
  key: string;
  free: boolean;
}

export interface RotateModelProviderInput {
  key: string;
}

export interface UpdateModelsInput {
  /** Full desired state: the models to keep enabled, each with its free flag. */
  models: Array<{ modelName: string; litellmModelName: string; enabled: boolean; free: boolean }>;
}

export interface PoolAccountOAuthBeginInput {
  accountNumber?: number;
  label?: string;
  plan?: string;
}

export interface PoolAccountOAuthBeginResult {
  accountNumber: number;
  userCode: string;
  verificationUri: string;
  expiresInSec: number;
  intervalSec: number;
}

export interface PoolAccountOAuthStatusResult {
  accountNumber: number;
  status: "pending" | "success" | "expired" | "failed";
  error?: string | null;
}

export interface PoolAccountOAuthCompleteInput {
  accountNumber: number;
  code?: string;
  token?: string;
}

export interface PoolAccountOAuthRefreshInput {
  accountNumber: number;
}

const base = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/model-providers`;

export const modelProvidersQueryKey = (companyId: string) =>
  ["myrmidon", "model-providers", companyId] as const;

export const modelProviderModelsQueryKey = (companyId: string, providerId: string) =>
  ["myrmidon", "model-providers", companyId, "models", providerId] as const;

export const modelProviderChannelsQueryKey = (companyId: string, providerId: string) =>
  ["myrmidon", "model-providers", companyId, "channels", providerId] as const;

export const litellmChannelsQueryKey = (companyId: string) =>
  ["myrmidon", "model-providers", companyId, "litellm-channels"] as const;

export const modelProvidersApi = {
  /** GET /providers → { providers, changeLog } (no key values ever). */
  view: (companyId: string) => api.get<ModelProvidersView>(`${base(companyId)}/providers`),

  /** POST /providers — validates the key and returns the provider with its
   * discovered models; the key itself is not part of any response. */
  add: (companyId: string, input: AddModelProviderInput) =>
    api.post<{ provider: ModelProviderView; models: ModelProviderModelView[] }>(
      `${base(companyId)}/providers`,
      input,
    ),

  /** PATCH /providers/:pid — rotate the stored key. */
  rotate: (companyId: string, providerId: string, input: RotateModelProviderInput) =>
    api.patch<{ provider: ModelProviderView; models: ModelProviderModelView[] }>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}`,
      input,
    ),

  /** DELETE /providers/:pid — remove the provider and its models. */
  remove: (companyId: string, providerId: string) =>
    api.delete<{ ok: true }>(`${base(companyId)}/providers/${encodeURIComponent(providerId)}`),

  /** GET /providers/:pid/models — the cached model list. */
  models: (companyId: string, providerId: string) =>
    api.get<ModelProviderModelsView>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}/models`,
    ),

  /** POST /providers/:pid/models — enable/disable models. */
  updateModels: (companyId: string, providerId: string, input: UpdateModelsInput) =>
    api.post<{ models: ModelProviderModelView[] }>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}/models`,
      input,
    ),

  /** GET /providers/:pid/channels — accounts and signals for a chatgpt-pool provider. */
  channels: (companyId: string, providerId: string) =>
    api.get<ModelProviderChannelsView>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}/channels`,
    ),

  /** POST /providers/:pid/channels — add a Codex/ChatGPT account to the pool. */
  addAccount: (
    companyId: string,
    providerId: string,
    input: { label: string; plan?: string; email?: string | null },
  ) =>
    api.post<{ ok: true; account: PoolAccountChannelView }>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}/channels`,
      input,
    ),

  /** DELETE /providers/:pid/channels/:accountNumber — remove an account from the pool. */
  deleteAccount: (companyId: string, providerId: string, accountNumber: number) =>
    api.delete<{ ok: true }>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}/channels/${encodeURIComponent(accountNumber)}`,
    ),

  /** POST /providers/:pid/oauth/start — initiate OAuth authorization flow for Codex account. */
  startOAuth: (
    companyId: string,
    providerId: string,
    input?: { plan?: string; label?: string },
  ) =>
    api.post<{
      authUrl: string;
      userCode?: string;
      verificationUri?: string;
      state: string;
      expiresIn: number;
    }>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}/oauth/start`,
      input ?? {},
    ),

  /** POST /providers/:pid/oauth/complete — complete OAuth authorization flow. */
  completeOAuth: (
    companyId: string,
    providerId: string,
    input: {
      state?: string;
      code?: string;
      plan?: string;
      label?: string;
      email?: string;
    },
  ) =>
    api.post<{ ok: true; account: PoolAccountChannelView }>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}/oauth/complete`,
      input,
    ),

  /** GET /litellm/channels — model groups and routed channels from LiteLLM. */
  litellmChannels: (companyId: string) =>
    api.get<LitellmChannelsResponse>(
      `${base(companyId)}/litellm/channels`,
    ),

  /** POST /providers/:pid/oauth/begin — starts OAuth device authorization (OPE-10810). */
  oauthBegin: (companyId: string, providerId: string, input?: PoolAccountOAuthBeginInput) =>
    api.post<PoolAccountOAuthBeginResult>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}/oauth/begin`,
      input || {},
    ),

  /** GET /providers/:pid/oauth/status — checks OAuth device authorization status. */
  oauthStatus: (companyId: string, providerId: string, accountNumber: number) =>
    api.get<PoolAccountOAuthStatusResult>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}/oauth/status?accountNumber=${accountNumber}`,
    ),

  /** POST /providers/:pid/oauth/complete — completes authorization, storing tokens strictly in secret store. */
  oauthComplete: (companyId: string, providerId: string, input: PoolAccountOAuthCompleteInput) =>
    api.post<{ ok: true; accountNumber: number }>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}/oauth/complete`,
      input,
    ),

  /** POST /providers/:pid/oauth/refresh — refreshes pool account OAuth token via secret store. */
  oauthRefresh: (companyId: string, providerId: string, input: PoolAccountOAuthRefreshInput) =>
    api.post<{ ok: true; accountNumber: number }>(
      `${base(companyId)}/providers/${encodeURIComponent(providerId)}/oauth/refresh`,
      input,
    ),
};

export const litellmAuditApi = {
  list: (companyId: string, category?: string) => {
    const q = category ? `?category=${encodeURIComponent(category)}` : "";
    return api.get<{ entries: ModelProviderChangeLogEntry[] }>(
      `/api/myrmidon/companies/${encodeURIComponent(companyId)}/litellm/audit${q}`,
    );
  },
  rollback: (companyId: string, auditId: string) =>
    api.post<{ success: boolean; result: unknown }>(
      `/api/myrmidon/companies/${encodeURIComponent(companyId)}/litellm/audit/${encodeURIComponent(auditId)}/rollback`,
      {},
    ),
};

/**
 * The owner's rule: free models first, and among the free ones the free
 * DashScope models come before everything else. Stable alphabetical order
 * inside each group so the list never reorders on re-render.
 */
export function sortModels(models: ModelProviderModelView[]): ModelProviderModelView[] {
  return [...models].sort((a, b) => {
    const aFree = a.free ? 0 : 1;
    const bFree = b.free ? 0 : 1;
    if (aFree !== bFree) return aFree - bFree;
    if (aFree === 0) {
      // Both free: DashScope free models are the owner's first pick. The
      // provider type is not on the model row, so the rule keys on the
      // model-name prefix the LiteLLM names carry ("dashscope/…").
      const aDash = a.litellmModelName.startsWith("dashscope/") ? 0 : 1;
      const bDash = b.litellmModelName.startsWith("dashscope/") ? 0 : 1;
      if (aDash !== bDash) return aDash - bDash;
    }
    return a.modelName.localeCompare(b.modelName);
  });
}

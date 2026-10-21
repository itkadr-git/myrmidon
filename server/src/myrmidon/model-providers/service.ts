// server/src/myrmidon/model-providers/service.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS A): the company model-provider store.
//
// Owns these rules:
//
//  - The provider key value lives in exactly one place: the company secret
//    store, under a name derived from the provider row id. The database keeps
//    only the secret NAME. No read path of this module returns the value; the
//    settings API answers `has_key` (and the provider row's `credential_secret_name`
//    reference) — write-only by construction.
//  - A key is ACCEPTED only after the provider confirmed it: creating or
//    rotating a provider fetches the provider's model list over its own
//    /models endpoint with that key. An unauthorized answer is a 4xx back to
//    the caller and leaves both the store and the database untouched.
//  - The model list captured at validation becomes the provider's model cache
//    (model_provider_models): the snapshot the settings screen lists, with the
//    litellm model name part B will register in the gateway.
//  - add / rotate / remove each write one activity-log entry (the change-log
//    the settings audit reads). Entries carry provider id/name/type and the
//    action — never a key value or a secret name that could be resolved.
//
// Everything injectable arrives through ModelProviderServiceDeps, so the suite
// runs the real service with fakes (the real wiring is wiring.ts).

import { and, eq } from "drizzle-orm";
import {
  DEFAULT_CHATGPT_POOL_MODELS,
  getModelProviderConnector,
  isModelProviderTypeAvailable,
  listAvailableModelProviderTypes,
  MODEL_PROVIDER_DEFAULT_BASE_URLS,
  MODEL_PROVIDER_MODELS_PATH,
  modelProviderSecretName,
  type CreateModelProviderInput,
  type ModelProviderChannelsView,
  type ModelProviderType,
  type PatchModelProviderInput,
  type PoolAccountChannelView,
  type PoolAccountLimitWindow,
  type PoolAccountRoleSignal,
} from "@myrmidonai/shared";
import { modelProviderModels, modelProviders, type Db } from "@myrmidonai/db";
import { badRequest, conflict, notFound, unprocessable } from "../../errors.js";
import {
  clearPoolAccountSignals,
  evaluateAccountSignals,
  recordPoolAccountSignals,
} from "./signals.js";

/** The provider surface this module needs from the secret store. */
export interface ModelProviderSecretStoreDeps {
  /** Resolves a company secret value by name; null when absent. */
  readSecretValue(companyId: string, secretName: string): Promise<string | null>;
  /** Finds a company secret id by name; null when absent. */
  findSecretId(companyId: string, secretName: string): Promise<string | null>;
  /** Creates a company secret; returns its id. */
  createSecret(input: {
    companyId: string;
    name: string;
    value: string;
    description: string;
  }): Promise<{ id: string }>;
  /** Rotates a company secret to a new value. */
  rotateSecret(secretId: string, value: string): Promise<void>;
  /** Removes (soft-deletes) a company secret. */
  deleteSecret(secretId: string): Promise<void>;
}

/** The provider HTTP surface: list models or accounts with a candidate key. */
export interface ModelProviderCatalogPort {
  /**
   * Fetches the model list from the provider's OpenAI-compatible `/models`
   * endpoint using the given key. Returns the model names on success.
   * Throws `ProviderAuthError` when the provider rejects the key.
   */
  listModels(input: {
    baseUrl: string;
    apiKey: string;
  }): Promise<{ models: string[] }>;

  /**
   * Fetches the account channel list from the ChatGPT / Codex subscription pool.
   * Returns the accounts array on success.
   * Throws `ProviderAuthError` when the provider rejects the key.
   */
  listAccounts?(input: {
    baseUrl: string;
    apiKey: string;
  }): Promise<{ accounts: any[] }>;
}

/** The error a provider answers an invalid key with (maps to 4xx). */
export class ProviderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAuthError";
  }
}

export interface ModelProviderServiceDeps {
  db: Db;
  secrets: ModelProviderSecretStoreDeps;
  catalog: ModelProviderCatalogPort;
  now?(): Date;
}

/** What a provider row looks like to the API. Never a key value. */
export interface ModelProviderView {
  id: string;
  type: ModelProviderType;
  name: string;
  baseUrl: string | null;
  /** True when the secret store holds a value for the credential secret. */
  hasKey: boolean;
  /** The secret-store name the credential lives under (a reference, not a value). */
  credentialSecretName: string | null;
  free: boolean;
  keyValidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProviderModelView {
  id: string;
  modelName: string;
  litellmModelName: string;
  enabled: boolean;
  free: boolean;
}

/** Activity-log entry of add / rotate / remove. */
export interface ModelProviderActivityEntry {
  companyId: string;
  action: "model_provider_added" | "model_provider_key_rotated" | "model_provider_removed";
  providerId: string;
  details: Record<string, unknown>;
}

type ProviderRow = typeof modelProviders.$inferSelect;

export function createModelProviderService(deps: ModelProviderServiceDeps) {
  const now = deps.now ?? (() => new Date());

  function view(row: ProviderRow, hasKey: boolean): ModelProviderView {
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      baseUrl: row.baseUrl,
      hasKey,
      credentialSecretName: row.credentialSecretName,
      free: row.free,
      keyValidatedAt: row.keyValidatedAt ? row.keyValidatedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function loadProvider(companyId: string, providerId: string): Promise<ProviderRow> {
    const rows = await deps.db
      .select()
      .from(modelProviders)
      .where(and(eq(modelProviders.id, providerId), eq(modelProviders.companyId, companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Model provider not found in this company");
    return row;
  }

  function effectiveBaseUrl(type: string, baseUrl: string | null | undefined): string {
    const explicit = baseUrl?.trim() || null;
    const connector = getModelProviderConnector(type);
    const url = explicit ?? MODEL_PROVIDER_DEFAULT_BASE_URLS[type] ?? connector?.defaultBaseUrl ?? null;
    if (!url) {
      throw badRequest(`baseUrl is required for provider type "${type}"`);
    }
    return url.replace(/\/$/, "");
  }

  /**
   * The litellm model name for one provider model. Keeps the provider's own
   * spelling: part B registers it under `openai/<name>` style prefixes, which
   * is derived there — the store records what the provider answered.
   */
  function litellmModelNameOf(provider: ProviderRow, modelName: string): string {
    return `${provider.type}/${modelName}`;
  }

  async function hasKeyFor(row: ProviderRow): Promise<boolean> {
    if (!row.credentialSecretName) return false;
    const value = await deps.secrets.readSecretValue(row.companyId, row.credentialSecretName);
    return Boolean(value);
  }

  /**
   * Validates a key against the provider by fetching the model list. This is
   * the acceptance gate: an invalid key is a ProviderAuthError (4xx), a broken
   * endpoint is an unprocessable error, and neither writes anything.
   */
  async function validateKey(input: {
    type: string;
    baseUrl: string | null | undefined;
    key: string;
  }): Promise<string[]> {
    const baseUrl = effectiveBaseUrl(input.type, input.baseUrl);
    try {
      const connector = getModelProviderConnector(input.type);
      if (input.type === "chatgpt-pool" || connector) {
        if (deps.catalog.listAccounts) {
          await deps.catalog.listAccounts({ baseUrl, apiKey: input.key });
        } else {
          try {
            await deps.catalog.listModels({ baseUrl, apiKey: input.key });
          } catch (error) {
            if (error instanceof ProviderAuthError) throw error;
          }
        }
        return connector?.defaultModels ? [...connector.defaultModels] : [...DEFAULT_CHATGPT_POOL_MODELS];
      }

      const { models } = await deps.catalog.listModels({ baseUrl, apiKey: input.key });
      const unique = [...new Set(models.filter((m) => m.trim().length > 0))];
      if (unique.length === 0) {
        throw unprocessable(
          "the provider answered an empty model list; check the base URL",
          { code: "provider_empty_model_list" },
        );
      }
      return unique;
    } catch (error) {
      if (error instanceof ProviderAuthError) {
        throw unprocessable(
          `the provider rejected this key: ${error.message}`,
          { code: "provider_key_invalid" },
        );
      }
      // Errors the repo's error helpers throw (unprocessable/badRequest above)
      // pass through unchanged; anything else is a transport failure.
      if (isHttpErrorLike(error)) throw error;
      throw unprocessable(
        `could not reach the provider at ${baseUrl}: ${(error as Error).message}`,
        { code: "provider_unreachable" },
      );
    }
  }

  /** Replaces the provider's model cache with a fresh snapshot. */
  async function writeModelCache(provider: ProviderRow, models: string[]): Promise<void> {
    await deps.db.delete(modelProviderModels).where(eq(modelProviderModels.providerId, provider.id));
    if (models.length === 0) return;
    await deps.db.insert(modelProviderModels).values(
      models.map((modelName) => ({
        providerId: provider.id,
        modelName,
        litellmModelName: litellmModelNameOf(provider, modelName),
        enabled: true,
        free: provider.free,
      })),
    );
  }

  /** Creates a provider: validate the key first, then write store + DB. */
  async function createProvider(input: {
    companyId: string;
    body: CreateModelProviderInput;
    activity?: (entry: ModelProviderActivityEntry) => Promise<void> | void;
  }): Promise<ModelProviderView> {
    const name = input.body.name.trim();
    const existing = await deps.db
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(and(eq(modelProviders.companyId, input.companyId), eq(modelProviders.name, name)))
      .limit(1);
    if (existing[0]) {
      throw conflict(`a model provider named "${name}" already exists in this company`, {
        code: "model_provider_name_exists",
      });
    }

    if (!isModelProviderTypeAvailable(input.body.type)) {
      throw badRequest(
        `provider type "${input.body.type}" is not available; connector plugin is not registered`,
        { code: "model_provider_type_unsupported" },
      );
    }

    const models = await validateKey({
      type: input.body.type,
      baseUrl: input.body.baseUrl,
      key: input.body.key,
    });

    const inserted = await deps.db
      .insert(modelProviders)
      .values({
        companyId: input.companyId,
        type: input.body.type,
        name,
        baseUrl: input.body.baseUrl?.trim() || null,
        free: input.body.free ?? false,
        keyValidatedAt: now(),
      })
      .returning();
    const row = inserted[0]!;

    const finalSecretName = modelProviderSecretName(row.id);
    await deps.secrets.createSecret({
      companyId: input.companyId,
      name: finalSecretName,
      value: input.body.key,
      description: `Model provider key of "${name}" (${row.type}); write-only, never returned by the API`,
    });

    await writeModelCache(row, models);
    const stored = { ...row, credentialSecretName: finalSecretName };
    await deps.db
      .update(modelProviders)
      .set({ credentialSecretName: finalSecretName, updatedAt: now() })
      .where(eq(modelProviders.id, row.id));

    await input.activity?.({
      companyId: input.companyId,
      action: "model_provider_added",
      providerId: row.id,
      details: { name, type: row.type, baseUrl: stored.baseUrl, models: models.length },
    });

    return view({ ...stored, updatedAt: now() }, true);
  }

  /**
   * Rotates the key: the new key is validated against the provider (a fresh
   * model snapshot is captured) BEFORE the store and the database move. An
   * invalid key changes nothing.
   */
  async function rotateProviderKey(input: {
    companyId: string;
    providerId: string;
    key: string;
    activity?: (entry: ModelProviderActivityEntry) => Promise<void> | void;
  }): Promise<ModelProviderView> {
    const row = await loadProvider(input.companyId, input.providerId);
    const secretName = row.credentialSecretName ?? modelProviderSecretName(row.id);
    const secretId = await deps.secrets.findSecretId(input.companyId, secretName);
    if (!secretId) {
      throw notFound("the provider has no stored key; add the provider again", {
        code: "model_provider_key_absent",
      });
    }

    const models = await validateKey({ type: row.type, baseUrl: row.baseUrl, key: input.key });
    await deps.secrets.rotateSecret(secretId, input.key);
    await writeModelCache(row, models);
    await deps.db
      .update(modelProviders)
      .set({ credentialSecretName: secretName, keyValidatedAt: now(), updatedAt: now() })
      .where(eq(modelProviders.id, row.id));

    await input.activity?.({
      companyId: input.companyId,
      action: "model_provider_key_rotated",
      providerId: row.id,
      details: { name: row.name, type: row.type, models: models.length },
    });

    return view({ ...row, credentialSecretName: secretName, keyValidatedAt: now(), updatedAt: now() }, true);
  }

  /** Metadata-only patch (name, baseUrl, free flag); never touches the key. */
  async function patchProvider(input: {
    companyId: string;
    providerId: string;
    body: PatchModelProviderInput;
    activity?: (entry: ModelProviderActivityEntry) => Promise<void> | void;
  }): Promise<ModelProviderView> {
    const row = await loadProvider(input.companyId, input.providerId);
    const patch: Partial<typeof modelProviders.$inferInsert> = { updatedAt: now() };

    if (input.body.name !== undefined) {
      const name = input.body.name.trim();
      const existing = await deps.db
        .select({ id: modelProviders.id })
        .from(modelProviders)
        .where(and(eq(modelProviders.companyId, input.companyId), eq(modelProviders.name, name)))
        .limit(1);
      if (existing[0] && existing[0].id !== row.id) {
        throw conflict(`a model provider named "${name}" already exists in this company`, {
          code: "model_provider_name_exists",
        });
      }
      patch.name = name;
    }
    if (input.body.baseUrl !== undefined) patch.baseUrl = input.body.baseUrl?.trim() || null;
    if (input.body.free !== undefined) patch.free = input.body.free;

    await deps.db.update(modelProviders).set(patch).where(eq(modelProviders.id, row.id));
    const updated = await loadProvider(input.companyId, input.providerId);
    return view(updated, await hasKeyFor(updated));
  }

  /**
   * Removes a provider: the row (and its model cache, by cascade) and the
   * credential secret. The key value never leaves the store on the way out.
   */
  async function removeProvider(input: {
    companyId: string;
    providerId: string;
    activity?: (entry: ModelProviderActivityEntry) => Promise<void> | void;
  }): Promise<void> {
    const row = await loadProvider(input.companyId, input.providerId);
    if (row.credentialSecretName) {
      const secretId = await deps.secrets.findSecretId(row.companyId, row.credentialSecretName);
      if (secretId) await deps.secrets.deleteSecret(secretId);
    }
    await deps.db.delete(modelProviders).where(eq(modelProviders.id, row.id));
    clearPoolAccountSignals(input.companyId, input.providerId);
    await input.activity?.({
      companyId: input.companyId,
      action: "model_provider_removed",
      providerId: row.id,
      details: { name: row.name, type: row.type },
    });
  }

  /** Lists the company's providers. Answers `has_key`, never the value. */
  async function listProviders(companyId: string): Promise<ModelProviderView[]> {
    const rows = await deps.db
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.companyId, companyId));
    const views: ModelProviderView[] = [];
    for (const row of rows) {
      views.push(view(row, await hasKeyFor(row)));
    }
    return views;
  }

  async function readProvider(companyId: string, providerId: string): Promise<ModelProviderView> {
    const row = await loadProvider(companyId, providerId);
    return view(row, await hasKeyFor(row));
  }

  /** The cached model snapshot captured at validation time. */
  async function listModels(companyId: string, providerId: string): Promise<ModelProviderModelView[]> {
    await loadProvider(companyId, providerId);
    const rows = await deps.db
      .select()
      .from(modelProviderModels)
      .where(eq(modelProviderModels.providerId, providerId));
    return rows
      .map((row) => ({
        id: row.id,
        modelName: row.modelName,
        litellmModelName: row.litellmModelName,
        enabled: row.enabled,
        free: row.free,
      }))
      .sort((a, b) => a.modelName.localeCompare(b.modelName));
  }

  /** Applies the per-model enable/disable (and free/paid) switches. */
  async function setModels(input: {
    companyId: string;
    providerId: string;
    models: Array<{ modelName: string; enabled?: boolean; free?: boolean }>;
  }): Promise<ModelProviderModelView[]> {
    const provider = await loadProvider(input.companyId, input.providerId);
    for (const model of input.models) {
      const patch: Partial<typeof modelProviderModels.$inferInsert> = { updatedAt: now() };
      if (model.enabled !== undefined) patch.enabled = model.enabled;
      if (model.free !== undefined) patch.free = model.free;
      await deps.db
        .update(modelProviderModels)
        .set(patch)
        .where(
          and(
            eq(modelProviderModels.providerId, provider.id),
            eq(modelProviderModels.modelName, model.modelName),
          ),
        );
    }
    return listModels(input.companyId, input.providerId);
  }

  function mapStateToRu(state: string): string {
    switch (state) {
      case "active":
        return "Активен";
      case "rate_limited":
        return "Лимит исчерпан";
      case "token_expired":
        return "Токен истёк";
      case "banned":
        return "Заблокирован";
      case "login_pending":
        return "Ожидает вход";
      case "login_expired":
        return "Сессия истекла";
      case "not_logged_in":
        return "Не авторизован";
      default:
        return state;
    }
  }

  function mapRawAccountToChannel(raw: any): PoolAccountChannelView {
    const n = typeof raw.n === "number" ? raw.n : Number(raw.n || 0);
    const label = typeof raw.label === "string" ? raw.label : `Account #${n}`;
    const state = typeof raw.state === "string" ? raw.state : "unknown";
    const limitedUntil =
      typeof raw.limited_until === "number"
        ? raw.limited_until
        : typeof raw.limitedUntil === "number"
          ? raw.limitedUntil
          : null;
    const lastOk =
      typeof raw.last_ok === "number"
        ? raw.last_ok
        : typeof raw.lastOk === "number"
          ? raw.lastOk
          : null;

    const rawUsage = raw.usage || {};
    const primaryRaw = rawUsage.primary || raw.windows?.primary || null;
    const secondaryRaw = rawUsage.secondary || raw.windows?.secondary || null;

    const primary: PoolAccountLimitWindow | null = primaryRaw
      ? {
          usedPct:
            typeof primaryRaw.used_pct === "number"
              ? primaryRaw.used_pct
              : typeof primaryRaw.usedPct === "number"
                ? primaryRaw.usedPct
                : null,
          windowMin:
            typeof primaryRaw.window_min === "number"
              ? primaryRaw.window_min
              : typeof primaryRaw.windowMin === "number"
                ? primaryRaw.windowMin
                : null,
          resetsAt:
            typeof primaryRaw.resets_at === "number"
              ? primaryRaw.resets_at
              : typeof primaryRaw.resetsAt === "number"
                ? primaryRaw.resetsAt
                : null,
        }
      : null;

    const secondary: PoolAccountLimitWindow | null = secondaryRaw
      ? {
          usedPct:
            typeof secondaryRaw.used_pct === "number"
              ? secondaryRaw.used_pct
              : typeof secondaryRaw.usedPct === "number"
                ? secondaryRaw.usedPct
                : null,
          windowMin:
            typeof secondaryRaw.window_min === "number"
              ? secondaryRaw.window_min
              : typeof secondaryRaw.windowMin === "number"
                ? secondaryRaw.windowMin
                : null,
          resetsAt:
            typeof secondaryRaw.resets_at === "number"
              ? secondaryRaw.resets_at
              : typeof secondaryRaw.resetsAt === "number"
                ? secondaryRaw.resetsAt
                : null,
        }
      : null;

    const isBanned =
      state === "banned" ||
      state === "token_expired" ||
      Boolean(raw.banned) ||
      Boolean(
        rawUsage.recentErrors?.some(
          (e: any) => e.status === 401 || e.status === 403,
        ),
      );

    const nowUnix = Math.floor(now().getTime() / 1000);
    const primaryExhausted = Boolean(
      primary?.usedPct !== null &&
        primary?.usedPct !== undefined &&
        primary.usedPct >= 100,
    );
    const secondaryExhausted = Boolean(
      secondary?.usedPct !== null &&
        secondary?.usedPct !== undefined &&
        secondary.usedPct >= 100,
    );
    const isExhausted =
      !isBanned &&
      (state === "rate_limited" ||
        Boolean(rawUsage.limitReached) ||
        (limitedUntil !== null && limitedUntil > nowUnix) ||
        primaryExhausted ||
        secondaryExhausted);

    return {
      n,
      label,
      email: raw.email || null,
      state,
      stateRu: mapStateToRu(state),
      plan: raw.plan || rawUsage.plan || null,
      limitedUntil,
      lastOk,
      windows: {
        primary,
        secondary,
      },
      usage: {
        primary,
        secondary,
        plan: rawUsage.plan || raw.plan || null,
        limitReached: rawUsage.limitReached ?? isExhausted,
        requests24h: rawUsage.requests_24h ?? rawUsage.requests24h,
        requests7d: rawUsage.requests_7d ?? rawUsage.requests7d,
        tokens24h: rawUsage.tokens_24h ?? rawUsage.tokens24h,
        tokens7d: rawUsage.tokens_7d ?? rawUsage.tokens7d,
        lastLimitAt: rawUsage.last_limit_at ?? rawUsage.lastLimitAt ?? null,
        recentErrors: rawUsage.recent_errors ?? rawUsage.recentErrors,
      },
      isBanned,
      isExhausted,
      error: raw.error || null,
    };
  }

  async function listChannels(
    companyId: string,
    providerId: string,
  ): Promise<ModelProviderChannelsView> {
    const provider = await loadProvider(companyId, providerId);
    const connector = getModelProviderConnector(provider.type);
    if (provider.type !== "chatgpt-pool" && (!connector || !connector.supportsChannels)) {
      return {
        providerId: provider.id,
        providerType: provider.type,
        channels: [],
        signals: [],
      };
    }

    if (!provider.credentialSecretName) {
      return {
        providerId: provider.id,
        providerType: provider.type,
        channels: [],
        signals: [],
      };
    }

    const apiKey = await deps.secrets.readSecretValue(
      companyId,
      provider.credentialSecretName,
    );
    if (!apiKey) {
      return {
        providerId: provider.id,
        providerType: provider.type,
        channels: [],
        signals: [],
      };
    }

    const baseUrl = effectiveBaseUrl(provider.type, provider.baseUrl);
    let rawAccounts: any[] = [];
    if (deps.catalog.listAccounts) {
      const res = await deps.catalog.listAccounts({ baseUrl, apiKey });
      rawAccounts = res.accounts;
    }

    const channels = rawAccounts.map(mapRawAccountToChannel);
    const signals = evaluateAccountSignals(companyId, provider.id, channels, now());
    recordPoolAccountSignals(companyId, provider.id, signals);

    return {
      providerId: provider.id,
      providerType: provider.type,
      channels,
      signals,
    };
  }

  async function syncPoolSignals(
    companyId: string,
    providerId?: string,
  ): Promise<PoolAccountRoleSignal[]> {
    if (providerId) {
      const channelsView = await listChannels(companyId, providerId);
      return channelsView.signals;
    }

    const providers = await deps.db
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.companyId, companyId));

    const aggregated: PoolAccountRoleSignal[] = [];
    for (const p of providers) {
      const connector = getModelProviderConnector(p.type);
      if (p.type === "chatgpt-pool" || connector?.supportsChannels) {
        try {
          const channelsView = await listChannels(companyId, p.id);
          aggregated.push(...channelsView.signals);
        } catch {
          // Transport errors on one provider do not halt the company pass
        }
      }
    }
    return aggregated;
  }

  return {
    createProvider,
    rotateProviderKey,
    patchProvider,
    removeProvider,
    listProviders,
    listAvailableTypes: () => listAvailableModelProviderTypes(),
    readProvider,
    listModels,
    setModels,
    listChannels,
    syncPoolSignals,
  };
}

export type ModelProviderService = ReturnType<typeof createModelProviderService>;

/**
 * The provider's OpenAI-compatible `/models` endpoint, called with the
 * CANDIDATE key. This is the validation the issue asks for: the provider is
 * really polled, and an unauthorized answer becomes ProviderAuthError.
 */
export function createModelProviderCatalogPort(): ModelProviderCatalogPort {
  return {
    async listModels({ baseUrl, apiKey }) {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${MODEL_PROVIDER_MODELS_PATH}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
      } catch (error) {
        throw unprocessable(
          `could not reach the provider at ${baseUrl}: ${(error as Error).message}`,
          { code: "provider_unreachable" },
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderAuthError(`the provider answered ${response.status}`);
      }
      if (!response.ok) {
        throw unprocessable(`the provider answered ${response.status}`, {
          code: "provider_request_failed",
          status: response.status,
        });
      }
      const payload = (await response.json().catch(() => null)) as
        | { data?: Array<{ id?: unknown }> }
        | null;
      const models = (payload?.data ?? [])
        .map((item) => (typeof item.id === "string" ? item.id : null))
        .filter((id): id is string => Boolean(id));
      return { models };
    },

    async listAccounts({ baseUrl, apiKey }) {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/accounts`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
      } catch (error) {
        throw unprocessable(
          `could not reach the provider at ${baseUrl}: ${(error as Error).message}`,
          { code: "provider_unreachable" },
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderAuthError(`the provider answered ${response.status}`);
      }
      if (!response.ok) {
        throw unprocessable(`the provider answered ${response.status}`, {
          code: "provider_request_failed",
          status: response.status,
        });
      }
      const payload = (await response.json().catch(() => null)) as
        | { accounts?: any[] }
        | null;
      const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
      return { accounts };
    },
  };
}

/** Anything shaped like the repo's HttpError rethrows unchanged. */
interface HttpErrorLike {
  status?: number;
  message: string;
}

/** Structural check for the repo's HttpError (an instanceof would import it). */
function isHttpErrorLike(error: unknown): error is HttpErrorLike {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number" &&
    error instanceof Error
  );
}

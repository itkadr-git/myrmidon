// server/src/myrmidon/model-providers/pool-registry.ts
//
// myrmidon(1.6.6 OPE-10775): persistent registry for Codex / ChatGPT subscription
// pool accounts with OAuth authorization, plan types (Plus, Pro, K-12),
// and sliding limit windows (5-hour and 7-day).

import crypto from "node:crypto";
import {
  CODEX_PRIMARY_WINDOW_MIN,
  CODEX_SECONDARY_WINDOW_MIN,
  DEFAULT_CHATGPT_POOL_MODELS,
  formatPoolAccountPlanLabel,
  normalizePoolAccountPlan,
  type AddPoolAccountInput,
  type CompleteCodexOAuthInput,
  type PoolAccountChannelView,
  type PoolAccountLimitWindow,
  type PoolAccountPlan,
  type StartCodexOAuthInput,
} from "@myrmidon/shared";
import { evaluateAccountSignals, recordPoolAccountSignals } from "./signals.js";

export interface PoolAccountRecord extends PoolAccountChannelView {
  companyId: string;
  providerId: string;
  plan: PoolAccountPlan;
  auth?: {
    type: "oauth";
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    idToken?: string;
    userCode?: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface PendingOAuthSession {
  state: string;
  companyId: string;
  providerId: string;
  plan: PoolAccountPlan;
  label?: string;
  userCode: string;
  verificationUri: string;
  authUrl: string;
  expiresAt: number; // Unix epoch ms
}

// In-memory registry: companyId -> providerId -> Map<accountNumber, PoolAccountRecord>
const accountsByCompanyAndProvider = new Map<string, Map<string, Map<number, PoolAccountRecord>>>();
const pendingOAuthByState = new Map<string, PendingOAuthSession>();

function getProviderAccountMap(
  companyId: string,
  providerId: string,
): Map<number, PoolAccountRecord> {
  let byProvider = accountsByCompanyAndProvider.get(companyId);
  if (!byProvider) {
    byProvider = new Map();
    accountsByCompanyAndProvider.set(companyId, byProvider);
  }
  let accMap = byProvider.get(providerId);
  if (!accMap) {
    accMap = new Map();
    byProvider.set(providerId, accMap);
  }
  return accMap;
}

/** Lists all registered pool accounts for a given provider. */
export function getRegisteredPoolAccounts(
  companyId: string,
  providerId: string,
): PoolAccountRecord[] {
  const accMap = getProviderAccountMap(companyId, providerId);
  return Array.from(accMap.values()).sort((a, b) => a.n - b.n);
}

/** Finds a specific registered account by account number. */
export function getRegisteredPoolAccount(
  companyId: string,
  providerId: string,
  accountNumber: number,
): PoolAccountRecord | null {
  const accMap = getProviderAccountMap(companyId, providerId);
  return accMap.get(accountNumber) ?? null;
}

/**
 * Registers a new account in the pool with persisted plan type and sliding window configuration.
 */
export function registerPoolAccount(
  companyId: string,
  providerId: string,
  input: AddPoolAccountInput,
): PoolAccountRecord {
  const accMap = getProviderAccountMap(companyId, providerId);

  // Compute next available account number
  let nextN = 1;
  while (accMap.has(nextN)) {
    nextN++;
  }

  const now = new Date();
  const normalizedPlan = normalizePoolAccountPlan(input.plan);
  const planLabel = formatPoolAccountPlanLabel(normalizedPlan);

  const defaultPrimaryWindow: PoolAccountLimitWindow = {
    usedPct: 0,
    windowMin: CODEX_PRIMARY_WINDOW_MIN, // 5 hours (300 min)
    resetsAt: null,
    limitReached: false,
  };

  const defaultSecondaryWindow: PoolAccountLimitWindow = {
    usedPct: 0,
    windowMin: CODEX_SECONDARY_WINDOW_MIN, // 7 days (10080 min)
    resetsAt: null,
    limitReached: false,
  };

  const record: PoolAccountRecord = {
    n: nextN,
    label: input.label.trim(),
    email: input.email ? input.email.trim() : null,
    plan: normalizedPlan,
    state: "active",
    stateRu: `Активен (${planLabel})`,
    models: input.models && input.models.length > 0 ? [...input.models] : [...DEFAULT_CHATGPT_POOL_MODELS],
    limitedUntil: null,
    lastOk: Math.floor(now.getTime() / 1000),
    isBanned: false,
    isExhausted: false,
    windows: {
      primary: defaultPrimaryWindow,
      secondary: defaultSecondaryWindow,
    },
    usage: {
      primary: defaultPrimaryWindow,
      secondary: defaultSecondaryWindow,
      plan: normalizedPlan,
      limitReached: false,
      requests24h: 0,
      requests7d: 0,
    },
    companyId,
    providerId,
    auth: input.accessToken
      ? {
          type: "oauth",
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          expiresAt: input.expiresAt,
        }
      : undefined,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  accMap.set(nextN, record);

  // Update attention signals for the provider
  const accounts = Array.from(accMap.values());
  const signals = evaluateAccountSignals(companyId, providerId, accounts, now);
  recordPoolAccountSignals(companyId, providerId, signals);

  return record;
}

/** Deletes an account from the pool by its account number. */
export function deleteRegisteredPoolAccount(
  companyId: string,
  providerId: string,
  accountNumber: number,
): boolean {
  const accMap = getProviderAccountMap(companyId, providerId);
  const deleted = accMap.delete(accountNumber);
  if (deleted) {
    const accounts = Array.from(accMap.values());
    const signals = evaluateAccountSignals(companyId, providerId, accounts);
    recordPoolAccountSignals(companyId, providerId, signals);
  }
  return deleted;
}

/** Updates sliding windows, status, or quota metrics for a registered account. */
export function updateRegisteredPoolAccount(
  companyId: string,
  providerId: string,
  accountNumber: number,
  patch: Partial<PoolAccountChannelView>,
): PoolAccountRecord | null {
  const accMap = getProviderAccountMap(companyId, providerId);
  const existing = accMap.get(accountNumber);
  if (!existing) {
    return null;
  }

  const now = new Date();
  const nowUnix = Math.floor(now.getTime() / 1000);

  const updatedWindows = patch.windows
    ? {
        primary: patch.windows.primary ?? existing.windows.primary,
        secondary: patch.windows.secondary ?? existing.windows.secondary,
      }
    : existing.windows;

  const isBanned =
    patch.isBanned ??
    (patch.state === "banned" ||
      patch.state === "token_expired" ||
      patch.state === "login_expired" ||
      existing.isBanned);

  const primary = updatedWindows.primary;
  const secondary = updatedWindows.secondary;

  const primaryExhausted = Boolean(
    primary?.limitReached === true ||
      (typeof primary?.usedPct === "number" && primary.usedPct >= 100),
  );
  const secondaryExhausted = Boolean(
    secondary?.limitReached === true ||
      (typeof secondary?.usedPct === "number" && secondary.usedPct >= 100),
  );

  const limitedUntil = patch.limitedUntil !== undefined ? patch.limitedUntil : existing.limitedUntil;
  const isTimeLimited = Boolean(limitedUntil !== null && limitedUntil > nowUnix);

  const isExhausted =
    !isBanned &&
    (patch.isExhausted ??
      (patch.state === "rate_limited" ||
        primaryExhausted ||
        secondaryExhausted ||
        isTimeLimited));

  const plan = patch.plan ? normalizePoolAccountPlan(patch.plan) : existing.plan;

  const updated: PoolAccountRecord = {
    ...existing,
    ...patch,
    plan,
    isBanned,
    isExhausted,
    limitedUntil,
    windows: updatedWindows,
    updatedAt: now.toISOString(),
  };

  accMap.set(accountNumber, updated);

  const accounts = Array.from(accMap.values());
  const signals = evaluateAccountSignals(companyId, providerId, accounts, now);
  recordPoolAccountSignals(companyId, providerId, signals);

  return updated;
}

/** Initiates a Codex / ChatGPT OAuth flow. */
export function startCodexOAuth(
  companyId: string,
  providerId: string,
  input?: StartCodexOAuthInput,
): {
  authUrl: string;
  userCode: string;
  verificationUri: string;
  state: string;
  expiresIn: number;
} {
  const state = crypto.randomUUID();
  const rawCode = crypto.randomBytes(3).toString("hex").toUpperCase();
  const userCode = `CDX-${rawCode.slice(0, 3)}-${rawCode.slice(3)}`;
  const verificationUri = "https://auth.openai.com/codex/device";
  const authUrl = `https://auth.openai.com/oauth/authorize?client_id=myrmidon_codex&response_type=code&state=${encodeURIComponent(
    state,
  )}&user_code=${encodeURIComponent(userCode)}`;

  const expiresIn = 900; // 15 minutes
  const normalizedPlan = normalizePoolAccountPlan(input?.plan);

  pendingOAuthByState.set(state, {
    state,
    companyId,
    providerId,
    plan: normalizedPlan,
    label: input?.label,
    userCode,
    verificationUri,
    authUrl,
    expiresAt: Date.now() + expiresIn * 1000,
  });

  return {
    authUrl,
    userCode,
    verificationUri,
    state,
    expiresIn,
  };
}

/** Completes Codex OAuth and persists the account in the registry. */
export function completeCodexOAuth(
  companyId: string,
  providerId: string,
  input: CompleteCodexOAuthInput,
): PoolAccountRecord {
  let session: PendingOAuthSession | undefined;
  if (input.state) {
    session = pendingOAuthByState.get(input.state);
    if (session) {
      pendingOAuthByState.delete(input.state);
    }
  }

  const plan = normalizePoolAccountPlan(input.plan ?? session?.plan ?? "plus");
  const label =
    input.label?.trim() ||
    session?.label?.trim() ||
    `codex-${plan}-${Date.now().toString().slice(-4)}`;

  const email =
    input.email?.trim() ||
    (typeof input.tokens?.email === "string" ? input.tokens.email : null) ||
    `${label}@codex.local`;

  const accessToken =
    (typeof input.tokens?.access_token === "string" ? input.tokens.access_token : undefined) ||
    (typeof input.tokens?.accessToken === "string" ? input.tokens.accessToken : undefined) ||
    `cdx_oauth_${crypto.randomUUID()}`;

  const refreshToken =
    (typeof input.tokens?.refresh_token === "string" ? input.tokens.refresh_token : undefined) ||
    (typeof input.tokens?.refreshToken === "string" ? input.tokens.refreshToken : undefined) ||
    `cdx_refresh_${crypto.randomUUID()}`;

  return registerPoolAccount(companyId, providerId, {
    label,
    plan,
    email,
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + 3600 * 24 * 30, // 30 days
  });
}

/** Clears all in-memory pool registry entries. */
export function clearPoolRegistry(companyId?: string, providerId?: string): void {
  if (companyId && providerId) {
    const byProvider = accountsByCompanyAndProvider.get(companyId);
    if (byProvider) {
      byProvider.delete(providerId);
      if (byProvider.size === 0) {
        accountsByCompanyAndProvider.delete(companyId);
      }
    }
  } else if (companyId) {
    accountsByCompanyAndProvider.delete(companyId);
  } else {
    accountsByCompanyAndProvider.clear();
  }
  pendingOAuthByState.clear();
}

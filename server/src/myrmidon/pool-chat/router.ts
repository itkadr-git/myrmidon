import { HttpError } from "../../errors.js";
import type { PoolChatProvider } from "./transports.js";

export type PoolChatAccount = {
  accountRef: string;
  provider: PoolChatProvider;
  enabled: boolean;
  quotaUnits: number | null;
  usedUnits: number;
};

export type PoolChatRouterConfig = {
  accounts?: unknown;
};

export type SelectedPoolChatAccount = {
  accountRef: string;
  provider: PoolChatProvider;
};

function isAccount(value: unknown): value is PoolChatAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Record<string, unknown>;
  return (
    typeof account.accountRef === "string" && account.accountRef.length > 0 && account.accountRef.length <= 256 &&
    (account.provider === "chatgpt" || account.provider === "google") &&
    typeof account.enabled === "boolean" &&
    (account.quotaUnits === null || (Number.isSafeInteger(account.quotaUnits) && (account.quotaUnits as number) >= 0)) &&
    Number.isSafeInteger(account.usedUnits) && (account.usedUnits as number) >= 0
  );
}

/** Select one configured account without exposing its deployment identity. */
export function selectPoolChatAccount(
  config: PoolChatRouterConfig,
  provider: PoolChatProvider,
  reservationUnits: number,
): SelectedPoolChatAccount {
  if (!Number.isSafeInteger(reservationUnits) || reservationUnits < 1) {
    throw new HttpError(400, "Invalid pool-chat reservation");
  }
  const accounts = Array.isArray(config.accounts) ? config.accounts.filter(isAccount) : [];
  const eligible = accounts
    .filter((account) => account.provider === provider && account.enabled)
    .filter((account) => account.quotaUnits === null || account.usedUnits + reservationUnits <= account.quotaUnits)
    .sort((left, right) => {
      const leftRemaining = left.quotaUnits === null ? Number.MAX_SAFE_INTEGER : left.quotaUnits - left.usedUnits;
      const rightRemaining = right.quotaUnits === null ? Number.MAX_SAFE_INTEGER : right.quotaUnits - right.usedUnits;
      return rightRemaining - leftRemaining || left.accountRef.localeCompare(right.accountRef);
    });
  const selected = eligible[0];
  if (!selected) throw new HttpError(429, "No pool-chat account has available quota");
  return { accountRef: selected.accountRef, provider: selected.provider };
}

/** Public capability metadata deliberately omits account refs and usage. */
export function configuredPoolChatProviders(config: PoolChatRouterConfig): PoolChatProvider[] {
  const providers = new Set<PoolChatProvider>();
  if (Array.isArray(config.accounts)) {
    for (const account of config.accounts) if (isAccount(account) && account.enabled) providers.add(account.provider);
  }
  return [...providers];
}

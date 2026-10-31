// myrmidon(LICENSING, OPE-9084): periodic client-side pull of the issuer's
// signed deny-list. The installation fetches `license.deny.json` from the URL
// in MYR_LICENSE_DENY_URL itself — the admin POST endpoint alone is not a
// delivery path. Each tick re-reads the env, so the URL and the interval can
// change without a restart; no tick runs after stop().
//
// The puller only downloads, signature-verifies and atomically replaces the
// file next to license.key; it holds no private key and never serves the list.

import { logger } from "../../middleware/logger.js";
import {
  DEFAULT_DENY_PULL_INTERVAL_MS,
  denyListUrl,
  denyPullIntervalMs,
  pullDenyListOnce,
} from "./denylist.js";
import { TRUSTED_ISSUER_KEYS } from "./trusted-keys.js";
import type { TrustedIssuerKey } from "./license.js";

export interface DenyListPuller {
  /** One immediate pull outside the interval (used by tests and startup). */
  pullNow(): Promise<void>;
  stop(): void;
}

export interface DenyListPullerOptions {
  env?: NodeJS.ProcessEnv;
  trustedKeys?: readonly TrustedIssuerKey[];
  fetcher?: typeof fetch;
  /** Test seam for the interval source; production uses setInterval. */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
  warn?: (message: string) => void;
}

/**
 * Starts the periodic deny-list pull when MYR_LICENSE_DENY_URL is set.
 * Returns a no-op puller when the URL is absent — the timer starts lazily on
 * the first tick that sees the URL, so enabling the env var needs no restart.
 */
export function startDenyListPuller(options: DenyListPullerOptions = {}): DenyListPuller {
  const env = () => options.env ?? process.env;
  const trustedKeys = options.trustedKeys ?? TRUSTED_ISSUER_KEYS;
  const warn = options.warn ?? ((message: string) => logger.warn(message));
  const schedule = options.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const cancel = options.clearIntervalFn ?? ((handle: ReturnType<typeof setInterval>) => clearInterval(handle));

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let pulling = false;

  async function tick(): Promise<void> {
    if (stopped || pulling) return;
    if (!denyListUrl(env())) {
      // The URL is absent: make sure no stale timer keeps running.
      if (timer) {
        cancel(timer);
        timer = null;
      }
      return;
    }
    pulling = true;
    try {
      const result = await pullDenyListOnce(env(), trustedKeys, options.fetcher);
      if (result.status === "updated") {
        warn(`license deny-list pulled: serial ${result.serial} installed`);
      } else if (result.status === "rejected") {
        warn(`license deny-list pull rejected: serial ${result.serial} is lower than the accepted one`);
      }
    } catch (err) {
      warn(`license deny-list pull failed: ${(err as Error).message}`);
    } finally {
      pulling = false;
    }
  }

  function ensureTimer(): void {
    if (stopped || timer) return;
    const interval = denyPullIntervalMs(env());
    timer = schedule(() => void tick(), interval);
    (timer as unknown as { unref?: () => void })?.unref?.();
  }

  // Start lazily: an immediate tick installs the timer only when the URL is
  // configured. A later env change (test seam) is picked up by pullNow().
  void tick().then(() => {
    if (!stopped && denyListUrl(env())) ensureTimer();
  });

  return {
    async pullNow(): Promise<void> {
      await tick();
      if (!stopped && denyListUrl(env())) ensureTimer();
    },
    stop(): void {
      stopped = true;
      if (timer) {
        cancel(timer);
        timer = null;
      }
    },
  };
}

export { DEFAULT_DENY_PULL_INTERVAL_MS };

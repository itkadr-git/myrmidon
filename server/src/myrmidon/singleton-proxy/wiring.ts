// server/src/myrmidon/singleton-proxy/wiring.ts
//
// myrmidon(1.6.6 PROCS-1.5 / OPE-5412): how an api process finds the worker and
// learns whether forwarding is on. Only an `api`-role process gets options at
// all (`singletonProxyOptionsFor` returns null for `all` and `worker`), so the
// single-process board — the default — is untouched.

import { resolveProcessesSettings } from "@myrmidon/shared";
import { resolveWorkerLoopbackAddress, type ProcessRole } from "../../services/process-role.js";
import type { SingletonProxyOptions, SingletonProxyTarget } from "./proxy.js";

/** How long a read of the saved setting is reused: a change made in the UI
 * reaches the forwarding within this window, no restart. */
export const SINGLETON_PROXY_SETTING_TTL_MS = 2_000;

/** The worker's address: the launch map of the orchestrator (T1.5) writes
 * `MYRMIDON_WORKER_HOST` / `MYRMIDON_WORKER_PORT` into every api child; without
 * them (the supervisor fork of PROCS-1.2) it is the worker's loopback listener. */
export function resolveSingletonProxyTarget(env: NodeJS.ProcessEnv = process.env): SingletonProxyTarget {
  return resolveWorkerLoopbackAddress(env);
}

export function singletonProxyOptionsFor(
  role: ProcessRole,
  deps: {
    readProcessesSetting: () => Promise<unknown>;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
  },
): SingletonProxyOptions | null {
  if (role !== "api") return null;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  let cached: { value: boolean; at: number } | null = null;
  return {
    target: resolveSingletonProxyTarget(env),
    enabled: async () => {
      if (cached && now() - cached.at < SINGLETON_PROXY_SETTING_TTL_MS) return cached.value;
      try {
        const stored = await deps.readProcessesSetting();
        const value = resolveProcessesSettings(stored, env).settings.singletonProxy;
        cached = { value, at: now() };
        return value;
      } catch (err) {
        // Keep the last known value; with none, the saved default (on).
        if (cached) return cached.value;
        throw err;
      }
    },
  };
}

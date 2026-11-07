// server/src/myrmidon/singleton-proxy/counters.ts
//
// myrmidon(1.6.6 PROCS-1.5 / OPE-5412): the in-process counters behind the
// family `myrmidon_board_singleton_proxy_total{route,outcome}`. No store, no
// timer: a restart zeroes the series, the shape of the other in-process
// registries (lanes, bridge fallbacks).

import { SINGLETON_ROUTE_GROUPS, type SingletonRouteGroup } from "./allowlist.js";

/** `proxied`: the worker answered; `unavailable`: the worker could not be reached. */
export type SingletonProxyOutcome = "proxied" | "unavailable";
export const SINGLETON_PROXY_OUTCOMES: readonly SingletonProxyOutcome[] = ["proxied", "unavailable"];

export interface SingletonProxySample {
  route: SingletonRouteGroup;
  outcome: SingletonProxyOutcome;
  count: number;
}

export type SingletonProxySource = (() => SingletonProxySample[]) | { read(): SingletonProxySample[] };

const counters = new Map<string, number>();
const keyOf = (route: SingletonRouteGroup, outcome: SingletonProxyOutcome) => `${route}|${outcome}`;

export function recordSingletonProxy(route: SingletonRouteGroup, outcome: SingletonProxyOutcome): void {
  const key = keyOf(route, outcome);
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

/** Every route x outcome, zeros included. */
export function readSingletonProxySample(): SingletonProxySample[] {
  return SINGLETON_ROUTE_GROUPS.flatMap((route) =>
    SINGLETON_PROXY_OUTCOMES.map((outcome) => ({
      route,
      outcome,
      count: counters.get(keyOf(route, outcome)) ?? 0,
    })),
  );
}

export function resolveSingletonProxySource(source?: SingletonProxySource | null): () => SingletonProxySample[] {
  if (!source) return readSingletonProxySample;
  return typeof source === "function" ? source : () => source.read();
}

/** Test-only. */
export function resetSingletonProxyCounters(): void {
  counters.clear();
}

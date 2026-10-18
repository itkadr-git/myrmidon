// server/src/myrmidon/channel-connectors/bridge/fallback.ts
//
// myrmidon(1.6.6 CH-CONNECTOR-G): the fallback chain of the bridge seam.
//
// The seam (themes.ts) hands the core the symbols of a served theme once the
// adapter flag is on. This module wraps every *served* symbol with the rollback
// chain of design OPE-6985:
//
//   flag off                        — the legacy bridge module is returned as
//                                     it is: the adapter is never touched;
//   flag on, the adapter answers    — the adapter's value, nothing else runs;
//   flag on, the adapter throws,
//   its promise rejects or it does
//   not answer in time              — one warning line, one counter increment
//                                     (`myrmidon_adapter_fallback_total`), and
//                                     the legacy symbol answers in its place.
//
// The direct symbol is entered only when the adapter produced no answer: a
// successful adapter call never runs the legacy symbol (no double delivery),
// and a failed one is served from the legacy symbol exactly once. Delivery
// symbols keep their own guard against a duplicate message — the vendor outbox
// with its idempotency key (design doc, section 7) — because a timed-out call
// may still have delivered; the chain never sends twice on its own.
//
// A served symbol the legacy module does not have cannot be replaced: the
// failure is logged and rethrown, so a broken adapter stays visible instead of
// being silently swallowed.

import {
  recordChannelBridgeFallback,
  type ChannelBridgeFallbackReason,
} from "./fallback-counters.js";

/** The timeout of one adapter call, in milliseconds. */
export const CHANNEL_BRIDGE_FALLBACK_TIMEOUT_ENV =
  "MYRMIDON_CHANNEL_CONNECTOR_BRIDGE_TIMEOUT_MS";

/**
 * The default timeout, generous on purpose: the chain counts a fallback
 * (visible, configurable) rather than let a call hang the bridge.
 */
export const DEFAULT_CHANNEL_BRIDGE_FALLBACK_TIMEOUT_MS = 15_000;

/** Raised when a served call did not answer inside the setting. */
export class ChannelBridgeFallbackTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`bridge adapter call did not answer within ${timeoutMs} ms`);
    this.name = "ChannelBridgeFallbackTimeout";
  }
}

/**
 * The timeout of one adapter call, ms. Unset, blank or not a positive number
 * keeps the default — the chain is a safety net, so a typo cannot switch it off.
 */
export function channelBridgeFallbackTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CHANNEL_BRIDGE_FALLBACK_TIMEOUT_ENV]?.trim();
  if (!raw) return DEFAULT_CHANNEL_BRIDGE_FALLBACK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CHANNEL_BRIDGE_FALLBACK_TIMEOUT_MS;
  return Math.floor(parsed);
}

/** Where the chain counts and logs; tests inject fakes, production defaults. */
export interface ChannelBridgeFallbackDeps {
  /** Counter sink; defaults to the process registry. */
  record?(reason: ChannelBridgeFallbackReason): void;
  /** One line per fallback; defaults to console.warn. */
  log?(line: string, error: unknown): void;
  /** Timeout of one adapter call, ms; defaults to the setting. */
  timeoutMs?: number;
}
type ServedCall = (...args: unknown[]) => unknown;

/**
 * The seam's face for one theme: the legacy module with the adapter's symbols
 * spread over it, every served function wrapped by the chain. A served value
 * that is not a function is spread as it is — reading a constant cannot fail,
 * so there is nothing to fall back from.
 */
export function withChannelBridgeFallback<T extends object>(
  legacy: T,
  source: Partial<T>,
  theme: string,
  deps: ChannelBridgeFallbackDeps = {},
): T {
  const face = { ...legacy, ...source } as unknown as Record<string, unknown>;
  const directSymbols = legacy as unknown as Record<string, unknown>;
  for (const [symbol, served] of Object.entries(source as unknown as Record<string, unknown>)) {
    if (typeof served !== "function") continue;
    const direct = directSymbols[symbol];
    face[symbol] = wrapServed({
      theme,
      symbol,
      adapter: served as ServedCall,
      direct: typeof direct === "function" ? (direct as ServedCall) : null,
      deps,
    });
  }
  return face as unknown as T;
}

interface ServedWrap {
  theme: string;
  symbol: string;
  adapter: ServedCall;
  /** The legacy symbol, or null when the connector adds a symbol of its own. */
  direct: ServedCall | null;
  deps: ChannelBridgeFallbackDeps;
}

/** One served symbol with the chain around it: the adapter first, the direct path on failure. */
function wrapServed(wrap: ServedWrap): ServedCall {
  return function bridged(this: unknown, ...args: unknown[]): unknown {
    let answer: unknown;
    try {
      answer = wrap.adapter.apply(this, args);
    } catch (error) {
      return handOverToDirect(wrap, error, this, args);
    }
    if (!isThenable(answer)) return answer;
    // Read per call, like every other myrmidon setting: the timer of one call
    // follows the value in force when that call was made.
    const timeoutMs = wrap.deps.timeoutMs ?? channelBridgeFallbackTimeoutMs();
    return withTimeout(Promise.resolve(answer), timeoutMs).then(undefined, (error: unknown) =>
      handOverToDirect(wrap, error, this, args),
    );
  };
}

/**
 * The direct path answers. The counter moves only when the traffic really
 * returns: a symbol the legacy module does not have has nowhere to go, so the
 * failure is logged and rethrown without a fallback sample.
 */
function handOverToDirect(
  wrap: ServedWrap,
  error: unknown,
  thisArg: unknown,
  args: unknown[],
): unknown {
  const reason: ChannelBridgeFallbackReason =
    error instanceof ChannelBridgeFallbackTimeout ? "timeout" : "error";
  const line = `myrmidon channel bridge adapter fallback: theme=${wrap.theme} symbol=${wrap.symbol} reason=${reason}`;
  if (wrap.direct === null) {
    logFallback(wrap, `${line} direct_symbol=absent (the failure is rethrown)`, error);
    throw error;
  }
  (wrap.deps.record ?? recordChannelBridgeFallback)(reason);
  logFallback(wrap, line, error);
  return wrap.direct.apply(thisArg, args);
}

function logFallback(wrap: ServedWrap, line: string, error: unknown): void {
  if (wrap.deps.log) {
    wrap.deps.log(line, error);
    return;
  }
  console.warn(line, error);
}

/** A promise-like answer: only those can run out of time. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Rejects with {@link ChannelBridgeFallbackTimeout} once the setting runs out. */
function withTimeout(value: PromiseLike<unknown>, timeoutMs: number): Promise<unknown> {
  if (!(timeoutMs > 0)) return Promise.resolve(value);
  return new Promise<unknown>((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new ChannelBridgeFallbackTimeout(timeoutMs));
    }, timeoutMs);
    const unref = (handle as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(handle);
    value.then(
      (settled) => {
        clearTimeout(handle);
        resolve(settled);
      },
      (error: unknown) => {
        clearTimeout(handle);
        reject(error);
      },
    );
  });
}
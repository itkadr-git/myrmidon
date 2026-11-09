// server/src/services/intake-rate-limit.ts
// myrmidon(1.7 WEBHOOK-INTAKE): Sliding window rate limiter per source.

import {
  createInviteRateLimiter,
  type InviteRateLimiter,
  type InviteRateLimitResult,
} from "./invite-rate-limit.js";
import {
  DEFAULT_INTAKE_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_INTAKE_RATE_LIMIT_WINDOW_MS,
  type IntakeConfig,
} from "./intake-config.js";

export type IntakeRateLimitResult = InviteRateLimitResult;

export interface IntakeRateLimiter {
  consume(source: string, ip?: string): IntakeRateLimitResult;
}

export function createIntakeRateLimiter(options: {
  config?: IntakeConfig;
  now?: () => number;
  keyMode?: "source" | "source_ip";
} = {}): IntakeRateLimiter {
  const config = options.config;
  const now = options.now ?? Date.now;
  const keyMode = options.keyMode ?? "source";
  const limitersBySource = new Map<string, InviteRateLimiter>();

  function getLimiter(source: string): InviteRateLimiter {
    let limiter = limitersBySource.get(source);
    if (!limiter) {
      const sourceConfig = config?.sources[source];
      const maxRequests =
        sourceConfig?.rateLimit?.maxRequests ??
        config?.defaultRateLimit.maxRequests ??
        DEFAULT_INTAKE_RATE_LIMIT_MAX_REQUESTS;
      const windowMs =
        sourceConfig?.rateLimit?.windowMs ??
        config?.defaultRateLimit.windowMs ??
        DEFAULT_INTAKE_RATE_LIMIT_WINDOW_MS;

      limiter = createInviteRateLimiter({
        windowMs,
        maxRequests,
        now,
      });
      limitersBySource.set(source, limiter);
    }
    return limiter;
  }

  return {
    consume(source: string, ip = "default") {
      const limiter = getLimiter(source);
      const key = keyMode === "source_ip" && ip ? `${source}:${ip}` : source;
      return limiter.consume(key);
    },
  };
}

// packages/shared/src/myrmidon/provider-package-expiry.ts
//
// 1.6.6 OPE-7189 part J: Package duration calculation and expiration/limit
// warnings for LLM model providers in the registry (e.g. 15-day packages like nghimmo).

export interface ModelProviderPackageWarning {
  key: string;
  providerId: string;
  providerName: string;
  packageName: string | null;
  trigger: "time" | "limit" | "expired";
  status: "warning" | "expired";
  expiresAt: string | null;
  remainingDays: number | null;
  remainingMs: number | null;
  elapsedPercent: number | null;
  thresholdPercent: number;
  rpmLimit: number | null;
  currentRpm?: number | null;
  message: string;
}

/**
 * Calculates package expiration date from a start date and duration in days.
 * For example, a 15-day package (such as nghimmo) starting at 2026-10-01T00:00:00Z
 * expires at 2026-10-16T00:00:00Z.
 */
export function calculatePackageExpiration(input: {
  startedAt: Date | string;
  durationDays: number;
}): { expiresAt: Date; durationMs: number } {
  if (!Number.isFinite(input.durationDays) || input.durationDays <= 0) {
    throw new RangeError("durationDays must be a positive number");
  }
  const started = typeof input.startedAt === "string" ? new Date(input.startedAt) : input.startedAt;
  if (!Number.isFinite(started.getTime())) {
    throw new TypeError("invalid startedAt timestamp");
  }
  const durationMs = input.durationDays * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(started.getTime() + durationMs);
  return { expiresAt, durationMs };
}

/**
 * Evaluates whether an LLM provider package in the registry has expired
 * or is nearing its expiration date / consumption limit (thresholdPercent, default 80%).
 */
export function evaluateModelProviderPackageWarning(
  provider: {
    id: string;
    name: string;
    packageName?: string | null;
    expiresAt?: Date | string | null;
    rpmLimit?: number | null;
    createdAt?: Date | string | null;
    keyValidatedAt?: Date | string | null;
  },
  options?: {
    thresholdPercent?: number;
    now?: Date | string;
    currentRpm?: number;
  },
): ModelProviderPackageWarning | null {
  const thresholdPercent = options?.thresholdPercent ?? 80;
  if (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0 || thresholdPercent >= 100) {
    throw new RangeError("thresholdPercent must be greater than 0 and less than 100");
  }

  const now = options?.now
    ? typeof options.now === "string"
      ? new Date(options.now)
      : options.now
    : new Date();
  const nowMs = now.getTime();

  // 1. Expiration check if expiresAt is set on the provider
  if (provider.expiresAt) {
    const expiresAt =
      typeof provider.expiresAt === "string" ? new Date(provider.expiresAt) : provider.expiresAt;
    const expiresAtMs = expiresAt.getTime();

    if (Number.isFinite(expiresAtMs)) {
      const isExpired = nowMs >= expiresAtMs;
      const remainingMs = Math.max(0, expiresAtMs - nowMs);
      const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));

      if (isExpired) {
        const pkg = provider.packageName ? ` (${provider.packageName})` : "";
        return {
          key: `package-expiry:${provider.id}:${expiresAt.toISOString()}:expired`,
          providerId: provider.id,
          providerName: provider.name,
          packageName: provider.packageName ?? null,
          trigger: "expired",
          status: "expired",
          expiresAt: expiresAt.toISOString(),
          remainingDays: 0,
          remainingMs: 0,
          elapsedPercent: 100,
          thresholdPercent,
          rpmLimit: provider.rpmLimit ?? null,
          message: `Provider "${provider.name}" package${pkg} expired at ${expiresAt.toISOString()}.`,
        };
      }

      const started = provider.keyValidatedAt ?? provider.createdAt ?? now;
      const startedAt = typeof started === "string" ? new Date(started) : started;
      const startedAtMs = startedAt.getTime();
      const totalDurationMs = expiresAtMs - startedAtMs;

      if (totalDurationMs > 0) {
        const elapsedMs = Math.max(0, nowMs - startedAtMs);
        const elapsedPercent = (elapsedMs / totalDurationMs) * 100;
        if (elapsedPercent >= thresholdPercent) {
          const pkg = provider.packageName ? ` (${provider.packageName})` : "";
          return {
            key: `package-expiry:${provider.id}:${expiresAt.toISOString()}:warning`,
            providerId: provider.id,
            providerName: provider.name,
            packageName: provider.packageName ?? null,
            trigger: "time",
            status: "warning",
            expiresAt: expiresAt.toISOString(),
            remainingDays,
            remainingMs,
            elapsedPercent,
            thresholdPercent,
            rpmLimit: provider.rpmLimit ?? null,
            message: `Provider "${provider.name}" package${pkg} is nearing expiration: ${Math.round(elapsedPercent)}% of period has elapsed (threshold ${thresholdPercent}%), ${remainingDays} days remaining before ${expiresAt.toISOString()}.`,
          };
        }
      } else if (remainingDays <= 3) {
        // Fallback for short remaining duration
        const pkg = provider.packageName ? ` (${provider.packageName})` : "";
        return {
          key: `package-expiry:${provider.id}:${expiresAt.toISOString()}:warning`,
          providerId: provider.id,
          providerName: provider.name,
          packageName: provider.packageName ?? null,
          trigger: "time",
          status: "warning",
          expiresAt: expiresAt.toISOString(),
          remainingDays,
          remainingMs,
          elapsedPercent: 100,
          thresholdPercent,
          rpmLimit: provider.rpmLimit ?? null,
          message: `Provider "${provider.name}" package${pkg} is nearing expiration: ${remainingDays} days remaining before ${expiresAt.toISOString()}.`,
        };
      }
    }
  }

  // 2. Consumption / RPM limit check if currentRpm and rpmLimit are present
  if (
    typeof options?.currentRpm === "number" &&
    typeof provider.rpmLimit === "number" &&
    provider.rpmLimit > 0
  ) {
    const rpmUsedPercent = (options.currentRpm / provider.rpmLimit) * 100;
    if (rpmUsedPercent >= thresholdPercent) {
      return {
        key: `package-limit:${provider.id}:${provider.rpmLimit}`,
        providerId: provider.id,
        providerName: provider.name,
        packageName: provider.packageName ?? null,
        trigger: "limit",
        status: "warning",
        expiresAt: provider.expiresAt
          ? typeof provider.expiresAt === "string"
            ? provider.expiresAt
            : provider.expiresAt.toISOString()
          : null,
        remainingDays: null,
        remainingMs: null,
        elapsedPercent: null,
        thresholdPercent,
        rpmLimit: provider.rpmLimit,
        currentRpm: options.currentRpm,
        message: `Provider "${provider.name}" reached ${Math.round(rpmUsedPercent)}% of its RPM limit (${options.currentRpm} of ${provider.rpmLimit} rpm, threshold ${thresholdPercent}%).`,
      };
    }
  }

  return null;
}

export function describeModelProviderPackageWarning(w: ModelProviderPackageWarning): string {
  return w.message;
}

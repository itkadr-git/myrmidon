// myrmidon(1.7 AUTO-UPDATE-SETTINGS, OPE-10186): contracts and helpers for manual update check
import { z } from "zod";

export const updateChannelSchema = z.enum(["stable", "rc", "canary", "latest"]);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;

export const checkUpdatesRequestSchema = z
  .object({
    channel: updateChannelSchema.optional().default("stable"),
    force: z.boolean().optional().default(false),
    reference: z.string().trim().max(255).optional(),
  })
  .strict();

export type CheckUpdatesRequest = z.infer<typeof checkUpdatesRequestSchema>;

export const checkUpdatesResponseSchema = z.object({
  currentVersion: z.string(),
  currentCommit: z.string().nullable(),
  currentDigest: z.string().nullable(),
  channel: updateChannelSchema,
  updateAvailable: z.boolean(),
  latestVersion: z.string().nullable(),
  latestCommit: z.string().nullable(),
  latestDigest: z.string().nullable(),
  releaseTag: z.string().nullable(),
  releaseUrl: z.string().nullable(),
  releaseNotes: z.string().nullable(),
  publishedAt: z.string().nullable(),
  checkedAt: z.string(),
  error: z.string().nullable().optional(),
});

export type CheckUpdatesResponse = z.infer<typeof checkUpdatesResponseSchema>;

/**
 * Normalizes a semver tag/version string:
 * strips leading 'myr-v', 'myr-', or 'v'.
 */
export function normalizeVersionString(raw: string): string {
  let v = raw.trim();
  if (v.startsWith("myr-v")) {
    v = v.slice(5);
  } else if (v.startsWith("myr-")) {
    v = v.slice(4);
  } else if (v.startsWith("v")) {
    v = v.slice(1);
  }
  return v;
}

/**
 * Compares two semver strings (returns >0 if a > b, <0 if a < b, 0 if equal).
 * Follows Semantic Versioning 2.0.0 rules:
 * - 1.7.0 > 1.6.6
 * - 1.7.0 > 1.7.0-rc.1 (release is higher than pre-release of same version)
 * - 1.7.0-rc.2 > 1.7.0-rc.1
 */
export function compareSemver(aRaw: string, bRaw: string): number {
  const aNorm = normalizeVersionString(aRaw);
  const bNorm = normalizeVersionString(bRaw);

  // Strip build metadata (+...)
  const [aNoBuild] = aNorm.split("+");
  const [bNoBuild] = bNorm.split("+");

  const [aMain, ...aPreParts] = (aNoBuild ?? "").split("-");
  const [bMain, ...bPreParts] = (bNoBuild ?? "").split("-");

  const aPre = aPreParts.join("-");
  const bPre = bPreParts.join("-");

  const aNums = (aMain ?? "").split(".").map((n) => Number.parseInt(n, 10));
  const bNums = (bMain ?? "").split(".").map((n) => Number.parseInt(n, 10));

  const maxLen = Math.max(aNums.length, bNums.length);
  for (let i = 0; i < maxLen; i++) {
    const aVal = Number.isNaN(aNums[i]) || aNums[i] === undefined ? 0 : aNums[i];
    const bVal = Number.isNaN(bNums[i]) || bNums[i] === undefined ? 0 : bNums[i];
    if (aVal > bVal) return 1;
    if (aVal < bVal) return -1;
  }

  // If numeric parts are equal, handle pre-release:
  // A version with pre-release is LOWER than one without
  if (!aPre && bPre) return 1; // 1.7.0 > 1.7.0-rc.1
  if (aPre && !bPre) return -1; // 1.7.0-rc.1 < 1.7.0
  if (aPre && bPre) {
    const aPrIds = aPre.split(".");
    const bPrIds = bPre.split(".");
    const prMax = Math.max(aPrIds.length, bPrIds.length);
    for (let i = 0; i < prMax; i++) {
      const aId = aPrIds[i];
      const bId = bPrIds[i];
      if (aId === undefined) return -1;
      if (bId === undefined) return 1;
      if (aId === bId) continue;

      const aIsNum = /^\d+$/.test(aId);
      const bIsNum = /^\d+$/.test(bId);

      if (aIsNum && bIsNum) {
        const aNum = Number.parseInt(aId, 10);
        const bNum = Number.parseInt(bId, 10);
        if (aNum !== bNum) return aNum > bNum ? 1 : -1;
      } else if (aIsNum && !bIsNum) {
        return -1; // Numeric identifiers have lower precedence than non-numeric
      } else if (!aIsNum && bIsNum) {
        return 1;
      } else {
        return aId.localeCompare(bId);
      }
    }
  }

  return 0;
}

export function isNewerVersion(current: string, candidate: string): boolean {
  try {
    return compareSemver(candidate, current) > 0;
  } catch {
    return false;
  }
}

export function evaluateUpdateAvailability(
  current: { version: string; commit?: string | null; digest?: string | null },
  candidate: { version?: string | null; commit?: string | null; digest?: string | null },
): boolean {
  if (candidate.version && isNewerVersion(current.version, candidate.version)) {
    return true;
  }
  if (
    candidate.version &&
    current.version &&
    normalizeVersionString(candidate.version) === normalizeVersionString(current.version)
  ) {
    if (candidate.digest && current.digest && candidate.digest !== current.digest) {
      return true;
    }
    if (
      candidate.commit &&
      current.commit &&
      candidate.commit.toLowerCase() !== current.commit.toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}

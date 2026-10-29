// server/src/myrmidon/bot-containers/drift.ts
//
// Checks composite drift across profileHash, imageDigest, and resource limits
// (memoryMb, cpus, pidsLimit). Used by reconciliation and maintenance to detect
// and repair drift on both local and fleet host containers.

export interface CompositeDriftTarget {
  profileHash: string;
  imageDigest: string;
  limits: { memoryMb: number; cpus: number; pidsLimit: number };
}

/**
 * Returns list of field names that have drifted between expected and actual state.
 * Returns empty array when container state cleanly matches expected state.
 */
export function compositeDriftFields(expected: CompositeDriftTarget, actual: CompositeDriftTarget): string[] {
  const fields: string[] = [];
  if (expected.profileHash !== actual.profileHash) fields.push("profileHash");
  if (expected.imageDigest !== actual.imageDigest) fields.push("imageDigest");
  for (const key of ["memoryMb", "cpus", "pidsLimit"] as const) {
    if (expected.limits[key] !== actual.limits[key]) fields.push(`limits.${key}`);
  }
  return fields;
}

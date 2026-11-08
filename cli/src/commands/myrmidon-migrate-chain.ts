import type { VendorChainEntry, VendorRelease } from "./myrmidon-migrate-vendor-chain.js";

export type AppliedChainRow = { hash: string };

export type ChainCheck = {
  supported: boolean;
  /** The release the source was identified as; when unsupported, the closest supported one. */
  vendorRelease: string;
  /** Every release this tool accepts, oldest first. */
  supportedReleases: string[];
  expected: number;
  applied: number;
  /** Machine-readable reason code when the chain is not supported. */
  reason?:
    | "no-migration-journal"
    | "empty-journal"
    | "hash-mismatch"
    | "older-than-supported-release"
    | "newer-than-supported-release";
  /** Index in the chain of the first row that does not match, when known. */
  firstMismatchIndex?: number;
  firstMismatchTag?: string;
  detail?: string;
};

function matchingPrefix(rows: AppliedChainRow[], chain: ReadonlyArray<VendorChainEntry>): number {
  const common = Math.min(rows.length, chain.length);
  let i = 0;
  while (i < common && rows[i]!.hash === chain[i]![1]) i += 1;
  return i;
}

/**
 * Proves compatibility of a source migration journal by exact hashes. Equal tag
 * names or an equal last number prove nothing: the chain of applied SQL hashes
 * must equal the pinned chain of one supported release, in order, with nothing
 * missing and nothing extra.
 */
export function checkVendorChain(rows: AppliedChainRow[] | null, releases: ReadonlyArray<VendorRelease>): ChainCheck {
  const supportedReleases = releases.map((r) => r.release);
  const newest = releases[releases.length - 1]!;
  const list = supportedReleases.join(", ");
  const base = { vendorRelease: newest.release, supportedReleases, expected: newest.chain.length };
  if (rows === null) {
    return { ...base, supported: false, applied: 0, reason: "no-migration-journal", detail: "Source has no migration journal." };
  }
  if (rows.length === 0) {
    return { ...base, supported: false, applied: 0, reason: "empty-journal", detail: "Source migration journal is empty." };
  }
  const prefixes = releases.map((r) => matchingPrefix(rows, r.chain));
  const exact = releases.findIndex((r, i) => r.chain.length === rows.length && prefixes[i] === rows.length);
  if (exact >= 0) {
    const r = releases[exact]!;
    return { ...base, supported: true, vendorRelease: r.release, expected: r.chain.length, applied: rows.length };
  }

  // Not one of the supported releases: pick the closest one to explain why.
  // Longest matching prefix wins; on a tie prefer a release whose whole chain matched.
  const full = (i: number) => prefixes[i] === releases[i]!.chain.length;
  let best = 0;
  for (let i = 1; i < releases.length; i += 1) {
    if (prefixes[i]! > prefixes[best]! || (prefixes[i] === prefixes[best] && full(i) && !full(best))) best = i;
  }
  const closest = releases[best]!;
  const common = Math.min(rows.length, closest.chain.length);
  const fields = { ...base, vendorRelease: closest.release, expected: closest.chain.length, applied: rows.length };
  if (prefixes[best]! < common) {
    const i = prefixes[best]!;
    return {
      ...fields,
      supported: false,
      reason: "hash-mismatch",
      firstMismatchIndex: i,
      firstMismatchTag: closest.chain[i]![0],
      detail: `Applied migration #${i} does not match the hash of ${closest.chain[i]![0]} in Paperclip release ${closest.release}; this is not a supported release (supported: ${list}).`,
    };
  }
  if (rows.length < closest.chain.length) {
    return {
      ...fields,
      supported: false,
      reason: "older-than-supported-release",
      detail: `Source has ${rows.length} of ${closest.chain.length} migrations of Paperclip release ${closest.release}; upgrade the source Paperclip to a supported release first (supported: ${list}).`,
    };
  }
  return {
    ...fields,
    supported: false,
    reason: "newer-than-supported-release",
    detail: `Source has ${rows.length - closest.chain.length} migration(s) beyond Paperclip release ${closest.release}; the newest supported release is ${newest.release} (supported: ${list}).`,
  };
}

/** True when the target chain starts with the whole pinned base chain. */
export function chainStartsWithVendor(rows: AppliedChainRow[], chain: ReadonlyArray<VendorChainEntry>): boolean {
  if (rows.length < chain.length) return false;
  return chain.every((entry, i) => rows[i]!.hash === entry[1]);
}

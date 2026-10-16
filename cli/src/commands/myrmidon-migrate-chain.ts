import { PAPERCLIP_VENDOR_RELEASE, type VendorChainEntry } from "./myrmidon-migrate-vendor-chain.js";

export type AppliedChainRow = { hash: string };

export type ChainCheck = {
  supported: boolean;
  vendorRelease: string;
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

/**
 * Proves compatibility of a source migration journal by exact hashes. Equal tag
 * names or an equal last number prove nothing: the chain of applied SQL hashes
 * must equal the pinned vendor chain, in order, with nothing missing and
 * nothing extra.
 */
export function checkVendorChain(rows: AppliedChainRow[] | null, chain: ReadonlyArray<VendorChainEntry>): ChainCheck {
  const expected = chain.length;
  const base = { vendorRelease: PAPERCLIP_VENDOR_RELEASE, expected };
  if (rows === null) {
    return { ...base, supported: false, applied: 0, reason: "no-migration-journal", detail: "Source has no migration journal." };
  }
  if (rows.length === 0) {
    return { ...base, supported: false, applied: 0, reason: "empty-journal", detail: "Source migration journal is empty." };
  }
  const common = Math.min(rows.length, expected);
  for (let i = 0; i < common; i += 1) {
    if (rows[i]!.hash !== chain[i]![1]) {
      return {
        ...base,
        supported: false,
        applied: rows.length,
        reason: "hash-mismatch",
        firstMismatchIndex: i,
        firstMismatchTag: chain[i]![0],
        detail: `Applied migration #${i} does not match the hash of ${chain[i]![0]} in vendor release ${PAPERCLIP_VENDOR_RELEASE}.`,
      };
    }
  }
  if (rows.length < expected) {
    return {
      ...base,
      supported: false,
      applied: rows.length,
      reason: "older-than-supported-release",
      detail: `Source has ${rows.length} of ${expected} migrations of vendor release ${PAPERCLIP_VENDOR_RELEASE}; upgrade the source Paperclip to that release first.`,
    };
  }
  if (rows.length > expected) {
    return {
      ...base,
      supported: false,
      applied: rows.length,
      reason: "newer-than-supported-release",
      detail: `Source has ${rows.length - expected} migration(s) beyond vendor release ${PAPERCLIP_VENDOR_RELEASE}; only that exact release is supported.`,
    };
  }
  return { ...base, supported: true, applied: rows.length };
}

/** True when the target chain starts with the whole pinned vendor chain. */
export function chainStartsWithVendor(rows: AppliedChainRow[], chain: ReadonlyArray<VendorChainEntry>): boolean {
  if (rows.length < chain.length) return false;
  return chain.every((entry, i) => rows[i]!.hash === entry[1]);
}

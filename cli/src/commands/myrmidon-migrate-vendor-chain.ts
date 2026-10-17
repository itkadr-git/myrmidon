import { listMigrationChain } from "@paperclipai/db";

// The vendor Paperclip release this tool migrates from, and the shape of its
// migration chain. The hashes themselves are not copied here: the first 278
// migrations (journal idx 0..279) of this tree are byte-identical to that
// release and, by repository rule, never change, so they are read from the
// migration files at run time. A drift in length or in the last tag fails loudly.
export const PAPERCLIP_VENDOR_RELEASE = "v2026.916.1";
export const PAPERCLIP_VENDOR_LAST_IDX = 279;
export const PAPERCLIP_VENDOR_LENGTH = 278;
export const PAPERCLIP_VENDOR_LAST_TAG = "0279_tired_deathstrike";

export type VendorChainEntry = readonly [tag: string, sha256: string, when: number];

let cached: Promise<ReadonlyArray<VendorChainEntry>> | null = null;

export function loadVendorChain(): Promise<ReadonlyArray<VendorChainEntry>> {
  cached ??= listMigrationChain().then((all) => {
    const vendor = all.filter((e) => e.idx <= PAPERCLIP_VENDOR_LAST_IDX).map((e) => [e.tag, e.hash, e.when] as const);
    if (vendor.length !== PAPERCLIP_VENDOR_LENGTH || vendor[vendor.length - 1]![0] !== PAPERCLIP_VENDOR_LAST_TAG) {
      throw new Error("The vendor part of the migration journal does not have the pinned shape; refusing to judge a source.");
    }
    return vendor;
  });
  return cached;
}

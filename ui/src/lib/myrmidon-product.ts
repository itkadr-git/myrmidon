// myrmidon(B1a): the UI consumes the canonical shared product name.
// Vendor identifiers (PAPERCLIP_*, @myrmidon/*, API paths, CSS classes,
// localStorage keys) are unaffected — only human-visible copy uses this.
export { PRODUCT_NAME } from "@myrmidon/shared";

/** MIT attribution shown on the instance "About" section. Do not remove: see docs/myrmidon/CONVENTIONS.md #9. */
export const UPSTREAM_ATTRIBUTION = {
  text: "Based on Paperclip (MIT)",
  href: "https://github.com/paperclipai/paperclip",
} as const;

// myrmidon(B1b): single source of truth for the product name shown in CLI
// user-facing text (banner, help, prompts, error and status messages).
// Vendor identifiers are unaffected: package name (paperclipai), bin name,
// environment variables (PAPERCLIP_*), paths (~/.paperclip), function and
// type names, HTTP headers. Only human-visible copy uses this.
// Keep the value in step with server/src/myrmidon/product.ts — the guard
// test cli/src/__tests__/cli-product.myrmidon.test.ts fails if they drift.
export const PRODUCT_NAME = "Myrmidon";

/** Tagline under the ASCII banner. */
export const PRODUCT_TAGLINE = "The app people use to manage AI agents for work";

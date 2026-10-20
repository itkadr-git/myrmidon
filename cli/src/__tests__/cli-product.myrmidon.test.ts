import { describe, expect, it } from "vitest";

import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../myrmidon-product.js";
import { printPaperclipCliBanner } from "../utils/banner.js";

// myrmidon(B1b): guard against the CLI re-introducing "Paperclip" as the
// product name in user-visible surfaces (banner, --help, prompts, errors).
// Attribution ("Based on Paperclip (MIT)") is the one allowed exception
// (see NOTICE). Identifiers (paperclipai bin, PAPERCLIP_* env, ~/.paperclip
// paths) are vendor compatibility surface and stay untouched.
describe("cli product naming", () => {
  it("names the product Myrmidon", () => {
    // The server constant is checked in the server package
    // (server/src/myrmidon/product.myrmidon.test.ts); cross-package imports
    // would type-check server sources from the CLI and break its typecheck.
    expect(PRODUCT_NAME).toBe("Myrmidon");
    expect(PRODUCT_TAGLINE.length).toBeGreaterThan(10);
  });

  it("prints a Myrmidon banner with no vendor name", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: string) => {
      lines.push(line ?? "");
    };
    try {
      printPaperclipCliBanner();
    } finally {
      console.log = original;
    }
    const text = lines.join("\n");
    expect(text).toContain("Myrmidon");
    expect(text).not.toContain("Paperclip");
  });
});

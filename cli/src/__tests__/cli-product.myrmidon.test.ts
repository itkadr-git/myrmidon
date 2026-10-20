import { describe, expect, it } from "vitest";

import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../myrmidon-product.js";
import { printPaperclipCliBanner } from "../utils/banner.js";
import { buildOpenApiSpec } from "../../../server/src/routes/openapi.js";

// myrmidon(B1b): guard against the CLI re-introducing "Paperclip" as the
// product name in user-visible surfaces (banner, --help, prompts, errors).
// Attribution ("Based on Paperclip (MIT)") is the one allowed exception
// (see NOTICE). Identifiers (paperclipai bin, PAPERCLIP_* env, ~/.paperclip
// paths) are vendor compatibility surface and stay untouched.
describe("cli product naming", () => {
  it("names the product Myrmidon and stays in step with the server constant", async () => {
    expect(PRODUCT_NAME).toBe("Myrmidon");
    // The server module is the single source of truth; the CLI copy must not drift.
    const serverProduct = await import("../../../server/src/myrmidon/product.js");
    expect(PRODUCT_NAME).toBe(serverProduct.PRODUCT_NAME);
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

  it("renders an OpenAPI document whose error/description copy does not name the vendor", () => {
    const doc = JSON.stringify(buildOpenApiSpec());
    expect(doc).toContain("Myrmidon");
    // Vendor references that remain by design: attribution, upstream repo URLs,
    // external Paperclip Cloud services, and schema field names that are part
    // of the API contract (minimumPaperclipVersion, enablePaperclipDeveloperMode).
    const allowed = /Based on Paperclip|paperclipai\/paperclip|Paperclip Cloud/g;
    const stripped = doc.replace(allowed, "");
    const contract = /minimumPaperclipVersion|enablePaperclipDeveloperMode|enableSimplifiedEnglish/g;
    const stripped2 = stripped.replace(contract, "");
    expect(stripped2).not.toMatch(/Paperclip/);
  });
});

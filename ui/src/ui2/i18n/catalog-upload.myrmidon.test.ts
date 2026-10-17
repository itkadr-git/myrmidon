import { describe, expect, it } from "vitest";
import { en } from "./catalogs/en";
import { previewCatalogText, validateCatalogJson } from "./catalog-upload";

const catalog = JSON.stringify(en);

describe("custom locale catalog upload", () => {
  it("accepts the complete built-in catalog and provides a preview", () => {
    expect(validateCatalogJson(catalog).valid).toBe(true);
    expect(previewCatalogText(catalog).length).toBeGreaterThan(0);
  });

  it("rejects invalid JSON, missing keys, and unknown keys", () => {
    expect(validateCatalogJson("{").parseError).toBe(true);
    expect(validateCatalogJson(JSON.stringify({ language: {} })).missingKeys.length).toBeGreaterThan(0);
    expect(validateCatalogJson(JSON.stringify({ ...en, injected: "x" })).unknownKeys).toContain("injected");
  });

  it("rejects catalogs that change interpolation placeholders", () => {
    const altered = JSON.parse(catalog) as { language: { previewDecisionCardBody: string } };
    altered.language.previewDecisionCardBody = "No placeholders";
    expect(validateCatalogJson(JSON.stringify(altered)).invalidValues).toContain("language.previewDecisionCardBody");
  });

  it("rejects oversized payloads", () => {
    expect(validateCatalogJson(" ".repeat(256 * 1024 + 1)).parseError).toBe(true);
  });
});

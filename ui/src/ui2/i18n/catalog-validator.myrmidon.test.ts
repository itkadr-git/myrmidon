import { describe, expect, it } from "vitest";
import {
  formatValidationSummary,
  previewCatalogEntries,
  validateCatalogJsonContent,
} from "./catalog-validator.js";

describe("UI catalog validator (OPE-10187)", () => {
  const baseCatalog = {
    app: {
      title: "Myrmidon",
      welcome: "Hello {{name}}",
    },
    common: {
      save: "Save",
    },
  };

  it("validates valid JSON string content against base", () => {
    const jsonStr = JSON.stringify({
      app: {
        title: "Мирмидон",
        welcome: "Привет {{name}}",
      },
      common: {
        save: "Сохранить",
      },
    });

    const res = validateCatalogJsonContent(jsonStr, {
      baseCatalog,
      targetLocale: "ru",
    });

    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.report.matchedCount).toBe(3);
    expect(res.report.coveragePercent).toBe(100);

    const summary = formatValidationSummary(res);
    expect(summary.status).toBe("valid");
    expect(summary.summary).toContain("Catalog is valid");
  });

  it("flags malformed JSON string gracefully", () => {
    const res = validateCatalogJsonContent("not a json", {
      baseCatalog,
      targetLocale: "ru",
    });

    expect(res.valid).toBe(false);
    expect(res.errors[0]?.code).toBe("PARSE_ERROR");

    const summary = formatValidationSummary(res);
    expect(summary.status).toBe("invalid");
    expect(summary.errorMessages[0]).toContain("PARSE_ERROR");
  });

  it("previews catalog entries in order up to limit", () => {
    const catalog = {
      sectionA: {
        item1: "Value 1",
        item2: "Value 2",
      },
      sectionB: {
        item3: "Value 3",
      },
    };

    const preview = previewCatalogEntries(catalog, 2);
    expect(preview).toHaveLength(2);
    expect(preview[0]).toEqual({ path: "sectionA.item1", value: "Value 1" });
    expect(preview[1]).toEqual({ path: "sectionA.item2", value: "Value 2" });
  });

  it("formats validation summary with error and warning messages", () => {
    const jsonStr = JSON.stringify({
      app: {
        title: "Мирмидон   ", // suspicious trailing whitespace
        welcome: "Привет <script>alert(1)</script>", // disallowed payload
      },
    });

    const res = validateCatalogJsonContent(jsonStr, {
      baseCatalog,
      targetLocale: "ru",
    });

    expect(res.valid).toBe(false);
    const summary = formatValidationSummary(res);
    expect(summary.status).toBe("invalid");
    expect(summary.errorMessages.some((msg) => msg.includes("DISALLOWED_PAYLOAD"))).toBe(true);
    expect(summary.warningMessages.some((msg) => msg.includes("SUSPICIOUS_WHITESPACE"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  extractPlaceholders,
  flattenCatalog,
  lintStringValue,
  parseCatalogJson,
  validateCatalogStructure,
  type LocaleValidationResult,
} from "./locale-validator.js";

describe("locale-validator: parseCatalogJson", () => {
  it("parses valid JSON object", () => {
    const res = parseCatalogJson('{"app": {"title": "Myrmidon"}}');
    expect(res.catalog).toEqual({ app: { title: "Myrmidon" } });
    expect(res.error).toBeUndefined();
  });

  it("rejects malformed JSON", () => {
    const res = parseCatalogJson('{"app": {');
    expect(res.catalog).toBeNull();
    expect(res.error).toContain("Malformed JSON");
  });

  it("rejects non-object root JSON (array, primitive)", () => {
    const resArr = parseCatalogJson('["a", "b"]');
    expect(resArr.catalog).toBeNull();
    expect(resArr.error).toContain("Root catalog element must be a JSON object");

    const resStr = parseCatalogJson('"hello"');
    expect(resStr.catalog).toBeNull();
  });

  it("rejects oversized payload", () => {
    const res = parseCatalogJson('{"a": "b"}', 5);
    expect(res.catalog).toBeNull();
    expect(res.error).toContain("exceeds maximum limit");
  });
});

describe("locale-validator: extractPlaceholders", () => {
  it("extracts double and single bracket placeholders", () => {
    expect(extractPlaceholders("Hello {{name}}, you have {{count}} tasks.")).toEqual(["count", "name"]);
    expect(extractPlaceholders("Hi {user}, see {link}")).toEqual(["link", "user"]);
  });

  it("handles strings without placeholders", () => {
    expect(extractPlaceholders("Plain string")).toEqual([]);
  });
});

describe("locale-validator: flattenCatalog", () => {
  it("flattens nested objects into dotted paths", () => {
    const nested = {
      app: {
        header: {
          title: "Myrmidon",
          subtitle: "Board",
        },
      },
      simple: "Direct",
    };
    const { entries, depthErrors } = flattenCatalog(nested);
    expect(depthErrors).toEqual([]);
    expect(Object.fromEntries(entries)).toEqual({
      "app.header.title": "Myrmidon",
      "app.header.subtitle": "Board",
      "simple": "Direct",
    });
  });
});

describe("locale-validator: lintStringValue", () => {
  it("catches disallowed payloads (<script, event handlers, javascript/data URLs)", () => {
    const scriptRes = lintStringValue("key1", "<script>alert(1)</script>");
    expect(scriptRes.errors.some((e) => e.code === "DISALLOWED_PAYLOAD")).toBe(true);

    const eventRes = lintStringValue("key2", "<div onclick=alert(1)>click</div>");
    expect(eventRes.errors.some((e) => e.code === "DISALLOWED_PAYLOAD")).toBe(true);

    const jsRes = lintStringValue("key3", "javascript:alert(1)");
    expect(jsRes.errors.some((e) => e.code === "DISALLOWED_PAYLOAD")).toBe(true);
  });

  it("detects placeholder syntax errors", () => {
    const unclosedRes = lintStringValue("key1", "Welcome {{user, nice to meet you");
    expect(unclosedRes.errors.some((e) => e.code === "PLACEHOLDER_SYNTAX_ERROR")).toBe(true);
  });

  it("detects placeholder mismatches against base", () => {
    const mismatchRes = lintStringValue(
      "welcome",
      "Welcome {{user}}",
      "Welcome {{user}} to {{company}}",
    );
    expect(mismatchRes.errors.some((e) => e.code === "PLACEHOLDER_MISMATCH")).toBe(true);
  });

  it("flags warnings for empty translation and suspicious whitespace", () => {
    const emptyRes = lintStringValue("empty", "   ");
    expect(emptyRes.warnings.some((w) => w.code === "EMPTY_TRANSLATION")).toBe(true);

    const wsRes = lintStringValue("ws", "  Hello  ");
    expect(wsRes.warnings.some((w) => w.code === "SUSPICIOUS_WHITESPACE")).toBe(true);
  });

  it("detects string length limits", () => {
    const longStr = "a".repeat(2500);
    const res = lintStringValue("long", longStr);
    expect(res.errors.some((e) => e.code === "STRING_TOO_LONG")).toBe(true);
  });
});

describe("locale-validator: validateCatalogStructure", () => {
  const baseCatalog = {
    app: {
      title: "Myrmidon",
      welcome: "Hello {{name}}",
      status: "Active",
    },
    common: {
      save: "Save",
      cancel: "Cancel",
    },
  };

  it("validates a complete matching catalog", () => {
    const candidate = {
      app: {
        title: "Мирмидон",
        welcome: "Привет {{name}}",
        status: "Активен",
      },
      common: {
        save: "Сохранить",
        cancel: "Отмена",
      },
    };

    const res = validateCatalogStructure(candidate, {
      baseCatalog,
      targetLocale: "ru",
    });

    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.report.matchedCount).toBe(5);
    expect(res.report.missingCount).toBe(0);
    expect(res.report.extraCount).toBe(0);
    expect(res.report.coveragePercent).toBe(100);
  });

  it("calculates partial coverage report and missing keys", () => {
    const candidate = {
      app: {
        title: "Мирмидон",
      },
    };

    const res = validateCatalogStructure(candidate, {
      baseCatalog,
      targetLocale: "ru",
      strict: false,
    });

    expect(res.valid).toBe(true);
    expect(res.report.matchedCount).toBe(1);
    expect(res.report.missingCount).toBe(4);
    expect(res.report.coveragePercent).toBe(20);
    expect(res.warnings.some((w) => w.code === "MISSING_KEY")).toBe(true);
  });

  it("fails in strict mode when keys are missing or extra", () => {
    const candidate = {
      app: {
        title: "Мирмидон",
      },
      extra: {
        stuff: "Extra",
      },
    };

    const res = validateCatalogStructure(candidate, {
      baseCatalog,
      targetLocale: "ru",
      strict: true,
    });

    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it("rejects forbidden prototype keys", () => {
    const candidate = JSON.parse('{"__proto__": {"polluted": "true"}}');
    const res = validateCatalogStructure(candidate);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === "INVALID_KEY")).toBe(true);
  });

  it("rejects invalid leaf types (numbers, booleans, arrays)", () => {
    const candidate = {
      title: 123,
      flag: true,
      list: ["item"],
    };
    const res = validateCatalogStructure(candidate);
    expect(res.valid).toBe(false);
    expect(res.errors.filter((e) => e.code === "INVALID_TYPE").length).toBe(3);
  });

  it("rejects non-object root", () => {
    const res = validateCatalogStructure([1, 2, 3]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === "INVALID_ROOT")).toBe(true);
  });

  it("enforces maximum nesting depth", () => {
    let deeplyNested: any = { leaf: "value" };
    for (let i = 0; i < 15; i++) {
      deeplyNested = { level: deeplyNested };
    }
    const res = validateCatalogStructure(deeplyNested, { maxDepth: 5 });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === "NESTING_TOO_DEEP")).toBe(true);
  });
});

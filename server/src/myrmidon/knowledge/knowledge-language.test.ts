import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_REVISION_LANGS,
  assertTranslationOf,
  normalizeKnowledgeRevisionLang,
  selectKnowledgeRevision,
} from "./domain.js";

describe("knowledge revision languages", () => {
  it("supports only the configured locales and normalizes locale tags", () => {
    expect(KNOWLEDGE_REVISION_LANGS).toEqual(["en", "ru"]);
    expect(normalizeKnowledgeRevisionLang("ru-RU")).toBe("ru");
    expect(normalizeKnowledgeRevisionLang("EN_us")).toBe("en");
    expect(normalizeKnowledgeRevisionLang("unknown")).toBe("en");
  });

  it("rejects self and same-language translation links", () => {
    expect(() => assertTranslationOf({ revisionId: "r1", lang: "ru", canonical: { id: "r1", lang: "en" } })).toThrow(/translate itself/);
    expect(() => assertTranslationOf({ lang: "en", canonical: { id: "r1", lang: "en" } })).toThrow(/different language/);
  });

  it("uses exact language when available and canonical fallback otherwise", () => {
    const canonical = { id: "en-1", lang: "en" as const, translationOf: null, status: "approved" as const };
    const russian = { id: "ru-1", lang: "ru" as const, translationOf: "en-1", status: "approved" as const };
    expect(selectKnowledgeRevision([canonical, russian], "ru")).toBe(russian);
    expect(selectKnowledgeRevision([canonical], "ru")).toBe(canonical);
    expect(selectKnowledgeRevision([canonical, russian], "en")).toBe(canonical);
  });
});

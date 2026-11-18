import { describe, expect, it } from "vitest";
import {
  assertTranslationOf,
  KnowledgeDomainError,
  normalizeKnowledgeRevisionLang,
  selectKnowledgeRevision,
  type KnowledgeRevisionLang,
  type KnowledgeRevisionStatus,
} from "./domain.js";

type Revision = Readonly<{
  id: string;
  lang: KnowledgeRevisionLang;
  translationOf: string | null;
  status: KnowledgeRevisionStatus;
}>;

function revision(id: string, lang: KnowledgeRevisionLang, translationOf: string | null, status: KnowledgeRevisionStatus): Revision {
  return Object.freeze({ id, lang, translationOf, status });
}

describe("knowledge language selection contract", () => {
  it.each([
    ["ru-RU", "ru"], ["RU_ru", "ru"], ["en-US", "en"],
    ["unknown", "en"], [null, "en"], [42, "en"],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizeKnowledgeRevisionLang(input)).toBe(expected);
  });

  it.each([["en", "ru"], ["ru", "en"]] as const)("selects approved %s canonical and its %s translation without mutation", (canonicalLang, requestedLang) => {
    const canonical = revision("canonical", canonicalLang, null, "approved");
    const translated = revision("translated", requestedLang, canonical.id, "approved");
    const revisions = Object.freeze([translated, canonical]);
    const before = revisions.map((item) => ({ ...item }));
    expect(selectKnowledgeRevision(revisions, canonicalLang)).toBe(canonical);
    expect(selectKnowledgeRevision(revisions, requestedLang)).toBe(translated);
    expect(revisions).toEqual(before);
  });

  it.each([["en", "ru"], ["ru", "en"]] as const)("requires an approved %s canonical even with an approved %s orphan", (canonicalLang, requestedLang) => {
    const orphan = revision("orphan", requestedLang, "canonical", "approved");
    for (const status of ["draft", "submitted", "rejected"] as const) {
      const canonical = revision("canonical", canonicalLang, null, status);
      expect(selectKnowledgeRevision(Object.freeze([orphan, canonical]), requestedLang)).toBeUndefined();
    }
    expect(selectKnowledgeRevision(Object.freeze([orphan]), requestedLang)).toBeUndefined();
    expect(selectKnowledgeRevision(Object.freeze([]), requestedLang)).toBeUndefined();
  });

  it.each([["en", "ru"], ["ru", "en"]] as const)("falls back to %s canonical for invalid %s translations", (canonicalLang, requestedLang) => {
    const canonical = revision("canonical", canonicalLang, null, "approved");
    const foreign = revision("foreign", requestedLang, "other", "approved");
    const wrongLanguage = revision("wrong-language", canonicalLang, canonical.id, "approved");
    for (const status of ["draft", "submitted", "rejected"] as const) {
      const unapproved = revision(status, requestedLang, canonical.id, status);
      const revisions = Object.freeze([foreign, wrongLanguage, unapproved, canonical]);
      const before = revisions.map((item) => ({ ...item }));
      expect(selectKnowledgeRevision(revisions, requestedLang)).toBe(canonical);
      expect(revisions).toEqual(before);
    }
  });

  it("uses caller order for multiple approved canonicals", () => {
    const first = revision("first", "en", null, "approved");
    const second = revision("second", "ru", null, "approved");
    expect(selectKnowledgeRevision(Object.freeze([first, second]), "ru")).toBe(first);
    expect(selectKnowledgeRevision(Object.freeze([second, first]), "en")).toBe(second);
  });

  it("validates translation links with exact error codes, statuses and precedence", () => {
    const canonical = Object.freeze({ id: "canonical", lang: "en" as const });
    for (const [input, code] of [
      [{ revisionId: "canonical", lang: "en" as const, canonical }, "translation_self_reference"],
      [{ revisionId: "other", lang: "en" as const, canonical }, "translation_language_mismatch"],
    ] as const) {
      try {
        assertTranslationOf(Object.freeze(input));
        throw new Error("expected a domain error");
      } catch (error) {
        expect(error).toBeInstanceOf(KnowledgeDomainError);
        expect(error).toMatchObject({ code, status: 400 });
      }
    }
    expect(assertTranslationOf(Object.freeze({ revisionId: "other", lang: "ru", canonical }))).toBeUndefined();
    expect(assertTranslationOf(Object.freeze({ lang: "en", canonical: null }))).toBeUndefined();
    expect(assertTranslationOf(Object.freeze({ lang: "en" }))).toBeUndefined();
  });
});

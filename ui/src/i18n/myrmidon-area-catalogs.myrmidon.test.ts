// myrmidon(OPE-8950): guards for per-area fork catalogs
// (myrmidon-locales/areas/<area>.<locale>.json).
//   1. no key is defined twice for a locale across base + area files;
//   2. an area file only uses its own namespace `area.<area>.*`;
//   3. every area has both en and ru, with the same keys; plural groups
//      carry the full form set (en _one+_other, ru _one+_few+_many+_other)
//      and the same {{placeholders}} per group;
//   4. a string in one file against an object in another is a conflict.
import { describe, expect, it } from "vitest";
import { collectForkMessages, parseForkCatalogPath } from "./myrmidon-i18n";
import { findAreaParityProblems, findKeyConflicts, type Catalog } from "./catalog-utils";

const areaModules = import.meta.glob("./myrmidon-locales/areas/*.json", {
  eager: true,
  import: "default",
}) as Record<string, Catalog>;
const baseModules = import.meta.glob("./myrmidon-locales/*.json", {
  eager: true,
  import: "default",
}) as Record<string, Catalog>;

describe("area catalogs", () => {
  it("file names are <area>.<locale>.json with a supported locale", () => {
    const bad = Object.keys(areaModules).filter((path) => {
      const parsed = parseForkCatalogPath(path);
      return !parsed?.area || !["en", "ru"].includes(parsed.locale);
    });
    expect(bad).toEqual([]);
  });

  it("no key is defined twice across base and area catalogs", () => {
    expect(findKeyConflicts({ ...baseModules, ...areaModules })).toEqual([]);
  });

  it("each area file stays in its own area.<area>.* namespace", () => {
    const bad: string[] = [];
    for (const [path, catalog] of Object.entries(areaModules)) {
      const area = parseForkCatalogPath(path)?.area;
      if (!area) continue;
      const topKeys = Object.keys(catalog);
      const areaNode = (catalog.area ?? {}) as Catalog;
      if (topKeys.join() !== "area" || Object.keys(areaNode).join() !== area) bad.push(path);
    }
    expect(bad).toEqual([]);
  });

  it("every area has en and ru with identical keys and placeholders", () => {
    const byArea = new Map<string, { en?: Catalog; ru?: Catalog }>();
    for (const [path, catalog] of Object.entries(areaModules)) {
      const parsed = parseForkCatalogPath(path);
      if (!parsed?.area) continue;
      const entry = byArea.get(parsed.area) ?? {};
      (entry as Record<string, Catalog>)[parsed.locale] = catalog;
      byArea.set(parsed.area, entry);
    }
    const problems: string[] = [];
    for (const [area, { en, ru }] of byArea) {
      if (!en || !ru) problems.push(`${area}: needs both en and ru`);
      else problems.push(...findAreaParityProblems(en, ru).map((p) => `${area}: ${p}`));
    }
    expect(problems).toEqual([]);
  });
});

describe("area catalog helpers", () => {
  it("collectForkMessages merges area files per locale over the base", () => {
    const merged = collectForkMessages({
      "./myrmidon-locales/en.json": { nav: { a: "A" } },
      "./myrmidon-locales/ru.json": { nav: { a: "А" } },
      "./myrmidon-locales/areas/x.en.json": { area: { x: { t: "X" } } },
      "./myrmidon-locales/areas/y.en.json": { area: { y: { t: "Y" } } },
      "./myrmidon-locales/areas/x.ru.json": { area: { x: { t: "Х" } } },
    });
    expect(merged.en).toEqual({ nav: { a: "A" }, area: { x: { t: "X" }, y: { t: "Y" } } });
    expect(merged.ru).toEqual({ nav: { a: "А" }, area: { x: { t: "Х" } } });
  });

  it("findKeyConflicts reports a key defined in two files of one locale", () => {
    const conflicts = findKeyConflicts({
      "./myrmidon-locales/areas/x.en.json": { area: { shared: { t: "1" } } },
      "./myrmidon-locales/areas/y.en.json": { area: { shared: { t: "2" } } },
      "./myrmidon-locales/areas/y.ru.json": { area: { shared: { t: "2" } } },
    });
    expect(conflicts).toHaveLength(1);
  });

  it("findKeyConflicts reports a string against an object across files", () => {
    const conflicts = findKeyConflicts({
      "./myrmidon-locales/areas/x.en.json": { area: { shared: "text" } },
      "./myrmidon-locales/areas/y.en.json": { area: { shared: { t: "2" } } },
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("string");
  });

  it("findAreaParityProblems requires the full plural set per language", () => {
    const en = { area: { x: { n_one: "{{count}} item", n_other: "{{count}} items", a: "Hi {{name}}" } } };
    const ruFull = {
      area: { x: { n_one: "{{count}} шт", n_few: "{{count}} шт", n_many: "{{count}} шт", n_other: "{{count}} шт", a: "Привет {{name}}" } },
    };
    expect(findAreaParityProblems(en, ruFull)).toEqual([]);
    // ru with only _one/_other: the soft behaviour the first version accepted
    const ruSoft = { area: { x: { n_one: "{{count}} шт", n_other: "{{count}} шт", a: "Привет {{name}}" } } };
    expect(findAreaParityProblems(en, ruSoft)).toEqual(["ru plural area.x.n lacks forms: few, many"]);
    expect(findAreaParityProblems(en, { area: { x: { ...ruFull.area.x, a: "Привет" } } })).toEqual([
      "placeholders differ: area.x.a",
    ]);
    // a lone n_one is an ordinary key, not a plural group
    expect(findAreaParityProblems({ area: { x: { n_one: "1" } } }, { area: { x: { n_one: "1" } } })).toEqual([]);
    expect(findAreaParityProblems(en, { area: { x: { a: "Привет {{name}}" } } })).toContain("missing in ru: area.x.n");
  });
});

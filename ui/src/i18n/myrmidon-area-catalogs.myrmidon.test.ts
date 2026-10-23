// myrmidon(OPE-8950): guards for per-area fork catalogs
// (myrmidon-locales/areas/<area>.<locale>.json).
//   1. no key is defined twice for a locale across base + area files;
//   2. an area file only uses its own namespace `area.<area>.*`;
//   3. every area has both en and ru, with the same keys (plural suffixes
//      are folded: ru needs _few/_many where en has only _one/_other) and
//      the same {{placeholders}}.
import { describe, expect, it } from "vitest";
import { collectForkMessages, parseForkCatalogPath } from "./myrmidon-i18n";

type Catalog = Record<string, unknown>;

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function isPlainObject(value: unknown): value is Catalog {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Flatten a nested catalog into dotted leaf keys -> string value. */
export function flattenCatalog(catalog: Catalog, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      for (const [k, v] of flattenCatalog(value, path)) out.set(k, v);
    } else {
      out.set(path, String(value));
    }
  }
  return out;
}

/** Keys defined by more than one file for the same locale. */
export function findKeyConflicts(files: Record<string, Catalog>): string[] {
  const owners = new Map<string, string>();
  const conflicts: string[] = [];
  for (const [path, catalog] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const parsed = parseForkCatalogPath(path);
    if (!parsed) continue;
    for (const key of flattenCatalog(catalog).keys()) {
      const id = `${parsed.locale}:${key}`;
      const owner = owners.get(id);
      if (owner) conflicts.push(`${id} defined in ${owner} and ${path}`);
      else owners.set(id, path);
    }
  }
  return conflicts;
}

const foldPlural = (key: string) => key.replace(PLURAL_SUFFIX, "");
const placeholders = (value: string) => [...value.matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1]).sort();

/** Parity problems between the en and ru catalogs of one area. */
export function findAreaParityProblems(en: Catalog, ru: Catalog): string[] {
  const problems: string[] = [];
  const enFlat = flattenCatalog(en);
  const ruFlat = flattenCatalog(ru);
  const enKeys = new Set([...enFlat.keys()].map(foldPlural));
  const ruKeys = new Set([...ruFlat.keys()].map(foldPlural));
  for (const key of enKeys) if (!ruKeys.has(key)) problems.push(`missing in ru: ${key}`);
  for (const key of ruKeys) if (!enKeys.has(key)) problems.push(`missing in en: ${key}`);
  for (const [key, value] of ruFlat) {
    const enValue = enFlat.get(key);
    if (enValue !== undefined && placeholders(enValue).join() !== placeholders(value).join()) {
      problems.push(`placeholders differ: ${key}`);
    }
  }
  return problems;
}

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

  it("findAreaParityProblems folds plural suffixes and checks placeholders", () => {
    const en = { area: { x: { n_one: "{{count}} item", n_other: "{{count}} items", a: "Hi {{name}}" } } };
    const ru = {
      area: { x: { n_one: "{{count}} шт", n_few: "{{count}} шт", n_many: "{{count}} шт", n_other: "{{count}} шт", a: "Привет" } },
    };
    expect(findAreaParityProblems(en, ru)).toEqual(["placeholders differ: area.x.a"]);
    expect(findAreaParityProblems(en, { area: { x: { a: "Привет {{name}}" } } })).toEqual([
      "missing in ru: area.x.n",
    ]);
  });
});

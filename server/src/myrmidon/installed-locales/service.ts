// myrmidon(1.7 LOCALE-UPLOAD): Installed locales listing and coverage service.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { instanceSettings } from "@myrmidon/db";
import type {
  InstalledLocalesQuery,
  InstalledLocalesResponse,
  InstalledLocaleSummary,
  LocaleCoverageDetail,
} from "@myrmidon/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_BASE_LOCALE = "en";

export const KNOWN_LOCALE_NAMES: Record<string, string> = {
  ar: "Arabic",
  bn: "Bengali",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  fa: "Persian",
  fi: "Finnish",
  fil: "Filipino",
  fr: "French",
  he: "Hebrew",
  hi: "Hindi",
  hu: "Hungarian",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  mr: "Marathi",
  ms: "Malay",
  nb: "Norwegian Bokmål",
  nl: "Dutch",
  pa: "Punjabi",
  pl: "Polish",
  "pt-BR": "Portuguese (Brazil)",
  "pt-PT": "Portuguese (Portugal)",
  ro: "Romanian",
  ru: "Russian",
  sv: "Swedish",
  sw: "Swahili",
  ta: "Tamil",
  te: "Telugu",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  ur: "Urdu",
  vi: "Vietnamese",
  "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
};

export interface StoredCustomLocale {
  locale: string;
  name?: string;
  version?: number;
  uploadedAt?: string;
  catalog?: Record<string, unknown>;
}

export interface InstalledLocalesServiceOptions {
  localesDir?: string;
  baseCatalog?: Record<string, unknown>;
  customLocales?: StoredCustomLocale[];
}

export function flattenCatalogKeys(obj: unknown, prefix = ""): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...flattenCatalogKeys(value, nextKey));
    } else {
      keys.push(nextKey);
    }
  }
  return keys;
}

export class InstalledLocalesService {
  private db?: Db;
  private options: InstalledLocalesServiceOptions;
  private cachedBuiltinCatalogs: Map<string, { keys: string[]; raw: Record<string, unknown> }> | null = null;
  private cachedBaseKeys: Set<string> | null = null;

  constructor(db?: Db, options: InstalledLocalesServiceOptions = {}) {
    this.db = db;
    this.options = options;
  }

  private resolveLocalesDir(): string | null {
    if (this.options.localesDir && fs.existsSync(this.options.localesDir)) {
      return this.options.localesDir;
    }
    const candidates = [
      path.resolve(process.cwd(), "ui/src/i18n/locales"),
      path.resolve(__dirname, "../../../../ui/src/i18n/locales"),
      path.resolve(__dirname, "../../../ui/src/i18n/locales"),
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        return cand;
      }
    }
    return null;
  }

  private getBuiltinCatalogs(): Map<string, { keys: string[]; raw: Record<string, unknown> }> {
    if (this.cachedBuiltinCatalogs) {
      return this.cachedBuiltinCatalogs;
    }

    const catalogs = new Map<string, { keys: string[]; raw: Record<string, unknown> }>();
    const dir = this.resolveLocalesDir();

    if (dir && fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith(".json")) {
            const locale = file.replace(/\.json$/, "");
            try {
              const content = fs.readFileSync(path.join(dir, file), "utf-8");
              const parsed = JSON.parse(content);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                catalogs.set(locale, {
                  keys: flattenCatalogKeys(parsed),
                  raw: parsed,
                });
              }
            } catch {
              // skip unreadable or corrupt file
            }
          }
        }
      } catch {
        // directory read failed
      }
    }

    if (this.options.baseCatalog) {
      catalogs.set(DEFAULT_BASE_LOCALE, {
        keys: flattenCatalogKeys(this.options.baseCatalog),
        raw: this.options.baseCatalog,
      });
    }

    this.cachedBuiltinCatalogs = catalogs;
    return catalogs;
  }

  private getBaseKeys(): Set<string> {
    if (this.cachedBaseKeys) {
      return this.cachedBaseKeys;
    }
    const catalogs = this.getBuiltinCatalogs();
    const base = catalogs.get(DEFAULT_BASE_LOCALE);
    const keys = new Set<string>(base ? base.keys : []);
    this.cachedBaseKeys = keys;
    return keys;
  }

  private async getCustomLocalesFromDb(): Promise<StoredCustomLocale[]> {
    if (this.options.customLocales) {
      return this.options.customLocales;
    }
    if (!this.db) {
      return [];
    }
    try {
      const rows = await this.db
        .select()
        .from(instanceSettings)
        .where(eq(instanceSettings.key, "default"))
        .limit(1);
      const general = rows[0]?.general as Record<string, unknown> | undefined;
      const customLocales = general?.customLocales;
      if (Array.isArray(customLocales)) {
        return customLocales as StoredCustomLocale[];
      }
      if (customLocales && typeof customLocales === "object") {
        return Object.values(customLocales) as StoredCustomLocale[];
      }
    } catch {
      // ignore db errors, fallback to empty
    }
    return [];
  }

  public async listInstalledLocales(query?: InstalledLocalesQuery): Promise<InstalledLocalesResponse> {
    const baseKeys = this.getBaseKeys();
    const totalBaseKeys = baseKeys.size;
    const builtinCatalogs = this.getBuiltinCatalogs();
    const customLocales = await this.getCustomLocalesFromDb();

    const customLocaleCodes = new Set(customLocales.map((c) => c.locale));
    const summaries: InstalledLocaleSummary[] = [];

    // Built-in locales
    for (const [locale, { keys }] of builtinCatalogs.entries()) {
      // If replaced by custom locale, skip builtin or let custom override
      if (customLocaleCodes.has(locale)) {
        continue;
      }
      const candidateKeySet = new Set(keys);
      let matchedCount = 0;
      for (const k of candidateKeySet) {
        if (baseKeys.has(k)) {
          matchedCount++;
        }
      }
      const missingCount = Math.max(0, totalBaseKeys - matchedCount);
      const extraCount = Math.max(0, candidateKeySet.size - matchedCount);
      const coveragePercent = totalBaseKeys > 0 ? Math.round((matchedCount / totalBaseKeys) * 1000) / 10 : 100;

      summaries.push({
        locale,
        name: KNOWN_LOCALE_NAMES[locale] ?? locale,
        isBuiltin: true,
        isDefault: locale === DEFAULT_BASE_LOCALE,
        version: 1,
        totalKeys: candidateKeySet.size,
        matchedKeysCount: matchedCount,
        missingKeysCount: missingCount,
        extraKeysCount: extraCount,
        coveragePercent,
        updatedAt: null,
      });
    }

    // Custom locales
    for (const custom of customLocales) {
      const keys = custom.catalog ? flattenCatalogKeys(custom.catalog) : [];
      const candidateKeySet = new Set(keys);
      let matchedCount = 0;
      for (const k of candidateKeySet) {
        if (baseKeys.has(k)) {
          matchedCount++;
        }
      }
      const missingCount = Math.max(0, totalBaseKeys - matchedCount);
      const extraCount = Math.max(0, candidateKeySet.size - matchedCount);
      const coveragePercent = totalBaseKeys > 0 ? Math.round((matchedCount / totalBaseKeys) * 1000) / 10 : 100;

      summaries.push({
        locale: custom.locale,
        name: custom.name || KNOWN_LOCALE_NAMES[custom.locale] || custom.locale,
        isBuiltin: false,
        isDefault: false,
        version: custom.version ?? 1,
        totalKeys: candidateKeySet.size,
        matchedKeysCount: matchedCount,
        missingKeysCount: missingCount,
        extraKeysCount: extraCount,
        coveragePercent,
        updatedAt: custom.uploadedAt ?? null,
      });
    }

    // Apply filters
    let filtered = summaries;
    const filterType = query?.type ?? "all";
    if (filterType === "builtin") {
      filtered = filtered.filter((s) => s.isBuiltin);
    } else if (filterType === "custom") {
      filtered = filtered.filter((s) => !s.isBuiltin);
    }

    if (query?.minCoverage !== undefined) {
      filtered = filtered.filter((s) => s.coveragePercent >= (query.minCoverage as number));
    }

    if (query?.search) {
      const term = query.search.toLowerCase();
      filtered = filtered.filter(
        (s) => s.locale.toLowerCase().includes(term) || s.name.toLowerCase().includes(term),
      );
    }

    // Sort: default locale first, then builtin alphabetically, then custom alphabetically
    filtered.sort((a, b) => {
      if (a.isDefault) return -1;
      if (b.isDefault) return 1;
      if (a.isBuiltin !== b.isBuiltin) {
        return a.isBuiltin ? -1 : 1;
      }
      return a.locale.localeCompare(b.locale);
    });

    return {
      baseLocale: DEFAULT_BASE_LOCALE,
      totalBaseKeys,
      locales: filtered,
      total: filtered.length,
    };
  }

  public async getLocaleCoverage(locale: string): Promise<LocaleCoverageDetail | null> {
    const baseKeys = this.getBaseKeys();
    const totalBaseKeys = baseKeys.size;
    const builtinCatalogs = this.getBuiltinCatalogs();
    const customLocales = await this.getCustomLocalesFromDb();

    const custom = customLocales.find((c) => c.locale === locale);
    let candidateKeys: string[] = [];
    let isBuiltin = true;
    let isDefault = locale === DEFAULT_BASE_LOCALE;
    let name = KNOWN_LOCALE_NAMES[locale] ?? locale;
    let version: number | null = 1;
    let updatedAt: string | null = null;

    if (custom) {
      isBuiltin = false;
      isDefault = false;
      name = custom.name || KNOWN_LOCALE_NAMES[locale] || locale;
      version = custom.version ?? 1;
      updatedAt = custom.uploadedAt ?? null;
      candidateKeys = custom.catalog ? flattenCatalogKeys(custom.catalog) : [];
    } else if (builtinCatalogs.has(locale)) {
      const b = builtinCatalogs.get(locale)!;
      candidateKeys = b.keys;
    } else {
      return null;
    }

    const candidateKeySet = new Set(candidateKeys);
    const matchedKeys: string[] = [];
    const extraKeys: string[] = [];
    const missingKeys: string[] = [];

    for (const k of candidateKeySet) {
      if (baseKeys.has(k)) {
        matchedKeys.push(k);
      } else {
        extraKeys.push(k);
      }
    }

    for (const k of baseKeys) {
      if (!candidateKeySet.has(k)) {
        missingKeys.push(k);
      }
    }

    const coveragePercent =
      totalBaseKeys > 0 ? Math.round((matchedKeys.length / totalBaseKeys) * 1000) / 10 : 100;

    return {
      locale,
      name,
      baseLocale: DEFAULT_BASE_LOCALE,
      isBuiltin,
      isDefault,
      version,
      totalKeys: candidateKeySet.size,
      matchedKeysCount: matchedKeys.length,
      missingKeysCount: missingKeys.length,
      extraKeysCount: extraKeys.length,
      coveragePercent,
      missingKeys,
      extraKeys,
      matchedKeys,
      updatedAt,
    };
  }
}

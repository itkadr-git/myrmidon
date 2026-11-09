// myrmidon(1.7 LOCALE-UPLOAD / OPE-12117): module service contract for the
// custom-locale application service.
//
// POST /api/locale/upload accepts a user dictionary (multipart file or JSON
// body), validates it against the base English catalog and stores it as a NEW
// VERSION of the custom locale (version 1, 2, 3... per locale).
// GET /api/locale/current returns the active stored version.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { instanceSettings, type Db } from "@myrmidon/db";
import {
  CUSTOM_LOCALES_SETTINGS_KEY,
  type LocaleValidationResult,
  type StoredCustomLocale,
} from "@myrmidon/shared";
import { badRequest } from "../../errors.js";
import { validateCatalog } from "../../myrmidon/locale-upload/validator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const UPLOAD_ALLOWED_LOCALES = ["ru", "en"] as const;
export type UploadAllowedLocale = (typeof UPLOAD_ALLOWED_LOCALES)[number];

function canonicalizeJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

let cachedBaseCatalog: Record<string, unknown> | null = null;

export function resetBaseCatalogCache(): void {
  cachedBaseCatalog = null;
}

function tryCandidatePaths(): Record<string, unknown> | null {
  const candidates = [
    path.resolve(process.cwd(), "ui/src/i18n/locales/en.json"),
    path.resolve(__dirname, "../../../ui/src/i18n/locales/en.json"),
    path.resolve(__dirname, "../../myrmidon/locale-upload/en-reference.json"),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, "utf-8");
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function loadBaseEnglishCatalog(): Record<string, unknown> {
  if (cachedBaseCatalog) return cachedBaseCatalog;
  const loaded = tryCandidatePaths();
  if (loaded) {
    cachedBaseCatalog = loaded;
    return cachedBaseCatalog;
  }
  throw new Error("Failed to load base English catalog: reference file not found or invalid JSON");
}

export interface UploadLocalePayload {
  locale: string;
  catalog: Record<string, unknown>;
  uploadedBy?: string | null;
  dryRun?: boolean;
  strict?: boolean;
}

export interface UploadLocaleResponse {
  stored: boolean;
  dryRun: boolean;
  locale: string;
  version: number;
  checksum: string;
  uploadedAt: string;
  validation: LocaleValidationResult;
}

export interface CurrentLocaleResponse {
  locale: string;
  version: number;
  uploadedAt: string;
  checksum: string;
  catalog: Record<string, unknown>;
  keyCount: number;
  active: boolean;
}

export interface LocaleModuleService {
  uploadLocale(params: UploadLocalePayload): Promise<UploadLocaleResponse>;
  getCurrentLocale(preferredLocale?: string): Promise<CurrentLocaleResponse | null>;
  getCustomLocale(locale: string): Promise<StoredCustomLocale | null>;
}

export interface LocaleModuleServiceOptions {
  baseCatalog?: Record<string, unknown>;
}

export function createLocaleModuleService(
  db: Db,
  options: LocaleModuleServiceOptions = {},
): LocaleModuleService {
  const getBase = (): Record<string, unknown> => {
    return options.baseCatalog ?? loadBaseEnglishCatalog();
  };

  async function getGeneralSettings(): Promise<Record<string, unknown>> {
    const existing = await db
      .select({ general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, "default"))
      .limit(1);

    if (existing.length === 0) {
      await db
        .insert(instanceSettings)
        .values({ singletonKey: "default", general: {} })
        .onConflictDoNothing();
      const created = await db
        .select({ general: instanceSettings.general })
        .from(instanceSettings)
        .where(eq(instanceSettings.singletonKey, "default"))
        .limit(1);
      const row = created[0];
      return (
        row && row.general && typeof row.general === "object" && !Array.isArray(row.general)
          ? (row.general as Record<string, unknown>)
          : {}
      );
    }

    const row = existing[0];
    return (
      row && row.general && typeof row.general === "object" && !Array.isArray(row.general)
        ? (row.general as Record<string, unknown>)
        : {}
    );
  }

  return {
    async uploadLocale(params: UploadLocalePayload): Promise<UploadLocaleResponse> {
      const base = getBase();
      const validation = validateCatalog(params.catalog, base, {
        targetLocale: params.locale,
        baseLocale: "en",
        strict: params.strict ?? false,
      });

      if (!validation.valid) {
        throw badRequest("CATALOG_VALIDATION_FAILED", {
          message: `Catalog validation failed with ${validation.errors.length} error(s)`,
          targetLocale: params.locale,
          baseLocale: "en",
          report: validation.report,
          errors: validation.errors,
          warnings: validation.warnings,
        });
      }

      const normalizedJson = canonicalizeJson(params.catalog);
      const checksum = crypto.createHash("sha256").update(normalizedJson).digest("hex");
      const uploadedAt = new Date().toISOString();

      const general = await getGeneralSettings();
      const customLocales: Record<string, StoredCustomLocale> =
        typeof general[CUSTOM_LOCALES_SETTINGS_KEY] === "object" &&
        general[CUSTOM_LOCALES_SETTINGS_KEY] !== null &&
        !Array.isArray(general[CUSTOM_LOCALES_SETTINGS_KEY])
          ? { ...(general[CUSTOM_LOCALES_SETTINGS_KEY] as Record<string, StoredCustomLocale>) }
          : {};

      const previous = customLocales[params.locale];
      const nextVersion = previous ? (previous.version ?? 0) + 1 : 1;

      if (params.dryRun) {
        return {
          stored: false,
          dryRun: true,
          locale: params.locale,
          version: nextVersion,
          checksum,
          uploadedAt,
          validation,
        };
      }

      const record: StoredCustomLocale = {
        locale: params.locale,
        version: nextVersion,
        uploadedAt,
        uploadedBy: params.uploadedBy ?? null,
        keyCount: validation.report.totalCandidateKeys,
        checksum,
        catalog: params.catalog,
      };

      customLocales[params.locale] = record;

      const nextGeneral = {
        ...general,
        [CUSTOM_LOCALES_SETTINGS_KEY]: customLocales,
        activeLocale: params.locale,
      };

      await db
        .update(instanceSettings)
        .set({
          general: nextGeneral,
          updatedAt: new Date(),
        })
        .where(eq(instanceSettings.singletonKey, "default"));

      return {
        stored: true,
        dryRun: false,
        locale: params.locale,
        version: nextVersion,
        checksum,
        uploadedAt,
        validation,
      };
    },

    async getCustomLocale(locale: string): Promise<StoredCustomLocale | null> {
      const general = await getGeneralSettings();
      const customLocales =
        typeof general[CUSTOM_LOCALES_SETTINGS_KEY] === "object" &&
        general[CUSTOM_LOCALES_SETTINGS_KEY] !== null &&
        !Array.isArray(general[CUSTOM_LOCALES_SETTINGS_KEY])
          ? (general[CUSTOM_LOCALES_SETTINGS_KEY] as Record<string, StoredCustomLocale>)
          : {};

      return customLocales[locale] ?? null;
    },

    async getCurrentLocale(preferredLocale?: string): Promise<CurrentLocaleResponse | null> {
      const general = await getGeneralSettings();
      const customLocales =
        typeof general[CUSTOM_LOCALES_SETTINGS_KEY] === "object" &&
        general[CUSTOM_LOCALES_SETTINGS_KEY] !== null &&
        !Array.isArray(general[CUSTOM_LOCALES_SETTINGS_KEY])
          ? (general[CUSTOM_LOCALES_SETTINGS_KEY] as Record<string, StoredCustomLocale>)
          : {};

      const targetLocale =
        preferredLocale ||
        (typeof general.activeLocale === "string" ? general.activeLocale : undefined) ||
        "ru";

      const stored = customLocales[targetLocale];
      if (stored) {
        return {
          locale: stored.locale,
          version: stored.version,
          uploadedAt: stored.uploadedAt,
          checksum: stored.checksum,
          catalog: stored.catalog,
          keyCount: stored.keyCount,
          active: true,
        };
      }

      // If ru was requested or is default but has no upload yet, fallback to en
      if (targetLocale !== "en" && customLocales["en"]) {
        const enStored = customLocales["en"];
        return {
          locale: enStored.locale,
          version: enStored.version,
          uploadedAt: enStored.uploadedAt,
          checksum: enStored.checksum,
          catalog: enStored.catalog,
          keyCount: enStored.keyCount,
          active: true,
        };
      }

      // If no stored custom locale exists, return the base English reference
      const base = getBase();
      const baseNormalized = canonicalizeJson(base);
      const baseChecksum = crypto.createHash("sha256").update(baseNormalized).digest("hex");
      return {
        locale: "en",
        version: 1,
        uploadedAt: new Date(0).toISOString(),
        checksum: baseChecksum,
        catalog: base,
        keyCount: Object.keys(base).length,
        active: true,
      };
    },
  };
}

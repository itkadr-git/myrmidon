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
  type StoredCustomLocaleSummary,
} from "@myrmidon/shared";
import { badRequest } from "../../errors.js";
import { validateCatalog, type ValidateCatalogOptions } from "./validator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    path.resolve(__dirname, "./en-reference.json"),
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

export interface UploadLocaleParams {
  locale: string;
  catalog: Record<string, unknown>;
  uploadedBy?: string | null;
  dryRun?: boolean;
  strict?: boolean;
  maxStringLength?: number;
}

export interface UploadLocaleResult {
  stored: boolean;
  dryRun: boolean;
  locale: string;
  version: number;
  checksum: string;
  uploadedAt: string;
  validation: LocaleValidationResult;
}

export interface LocaleUploadService {
  uploadLocale(params: UploadLocaleParams): Promise<UploadLocaleResult>;
  getCustomLocale(locale: string): Promise<StoredCustomLocale | null>;
  listCustomLocales(): Promise<StoredCustomLocaleSummary[]>;
  deleteCustomLocale(locale: string): Promise<boolean>;
  validateOnly(params: {
    locale: string;
    catalog: Record<string, unknown>;
    strict?: boolean;
  }): Promise<LocaleValidationResult>;
}

export interface LocaleUploadServiceOptions {
  baseCatalog?: Record<string, unknown>;
}

export function createLocaleUploadService(
  db: Db,
  options: LocaleUploadServiceOptions = {},
): LocaleUploadService {
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
    async validateOnly({ locale, catalog, strict }) {
      const base = getBase();
      const valOpts: ValidateCatalogOptions = {
        targetLocale: locale,
        baseLocale: "en",
        strict: strict ?? false,
      };
      return validateCatalog(catalog, base, valOpts);
    },

    async uploadLocale(params: UploadLocaleParams): Promise<UploadLocaleResult> {
      const base = getBase();
      const validation = validateCatalog(params.catalog, base, {
        targetLocale: params.locale,
        baseLocale: "en",
        strict: params.strict ?? false,
        maxStringLength: params.maxStringLength,
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

    async listCustomLocales(): Promise<StoredCustomLocaleSummary[]> {
      const general = await getGeneralSettings();
      const customLocales =
        typeof general[CUSTOM_LOCALES_SETTINGS_KEY] === "object" &&
        general[CUSTOM_LOCALES_SETTINGS_KEY] !== null &&
        !Array.isArray(general[CUSTOM_LOCALES_SETTINGS_KEY])
          ? (general[CUSTOM_LOCALES_SETTINGS_KEY] as Record<string, StoredCustomLocale>)
          : {};

      return Object.values(customLocales).map((item) => ({
        locale: item.locale,
        version: item.version,
        uploadedAt: item.uploadedAt,
        uploadedBy: item.uploadedBy,
        keyCount: item.keyCount,
        checksum: item.checksum,
      }));
    },

    async deleteCustomLocale(locale: string): Promise<boolean> {
      const general = await getGeneralSettings();
      const customLocales =
        typeof general[CUSTOM_LOCALES_SETTINGS_KEY] === "object" &&
        general[CUSTOM_LOCALES_SETTINGS_KEY] !== null &&
        !Array.isArray(general[CUSTOM_LOCALES_SETTINGS_KEY])
          ? { ...(general[CUSTOM_LOCALES_SETTINGS_KEY] as Record<string, StoredCustomLocale>) }
          : {};

      if (!customLocales[locale]) {
        return false;
      }

      delete customLocales[locale];

      const nextGeneral = {
        ...general,
        [CUSTOM_LOCALES_SETTINGS_KEY]: customLocales,
      };

      await db
        .update(instanceSettings)
        .set({
          general: nextGeneral,
          updatedAt: new Date(),
        })
        .where(eq(instanceSettings.singletonKey, "default"));

      return true;
    },
  };
}

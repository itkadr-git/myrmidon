import fs from \"node:fs\";
import path from \"node:path\";
import crypto from \"node:crypto\";
import { fileURLToPath } from \"node:url\";
import { eq } from \"drizzle-orm\";
import { instanceSettings, type Db } from \"@myrmidon/db\";
import {
  CUSTOM_LOCALES_SETTINGS_KEY,
  type StoredCustomLocale,
  type StoredCustomLocaleSummary,
  type LocaleValidationResult,
} from \"@myrmidon/shared\";
import { badRequest } from \"../../errors.js\";
import { validateCatalog, type ValidateCatalogOptions } from \"./validator.js\";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedBaseCatalog: Record<string, unknown> | null = null;

export function loadBaseEnglishCatalog(): Record<string, unknown> {
  if (cachedBaseCatalog) {
    return cachedBaseCatalog;
  }

  const candidatePaths = [
    path.resolve(process.cwd(), \"ui/src/i18n/locales/en.json\"),
    path.resolve(__dirname, \"../../../ui/src/i18n/locales/en.json\"),
    path.resolve(__dirname, \"./en-reference.json\"),
  ];

  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, \"utf-8\");
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === \"object\" && !Array.isArray(parsed)) {
          cachedBaseCatalog = parsed as Record<string, unknown>;
          return cachedBaseCatalog;
        }
      }
    } catch {
      // Try next candidate
    }
  }

  // Fallback minimal catalog if filesystem read fails
  cachedBaseCatalog = {
    app: { title: \"Myrmidon\" },
  };
  return cachedBaseCatalog;
}

export function resetBaseCatalogCache(): void {
  cachedBaseCatalog = null;
}

export interface UploadLocaleParams {
  locale: string;
  catalog: Record<string, unknown>;
  actorId?: string | null;
  dryRun?: boolean;
  strict?: boolean;
}

export interface LocaleUploadService {
  getBaseCatalog(): Record<string, unknown>;
  validate(candidate: unknown, options?: ValidateCatalogOptions): LocaleValidationResult;
  upload(params: UploadLocaleParams): Promise<{
    valid: boolean;
    result: LocaleValidationResult;
    stored?: StoredCustomLocale;
  }>;
  listCustomLocales(): Promise<StoredCustomLocaleSummary[]>;
  getCustomLocale(locale: string): Promise<StoredCustomLocale | null>;
  deleteCustomLocale(locale: string): Promise<boolean>;
}

export function createLocaleUploadService(
  db: Db,
  options: { baseCatalog?: Record<string, unknown> } = {},
): LocaleUploadService {
  const getBaseCatalog = (): Record<string, unknown> => {
    return options.baseCatalog ?? loadBaseEnglishCatalog();
  };

  const validate = (candidate: unknown, opts: ValidateCatalogOptions = {}): LocaleValidationResult => {
    const base = getBaseCatalog();
    return validateCatalog(candidate, base, opts);
  };

  const ensureSettingsRow = async (): Promise<{ id: string; general: Record<string, unknown> }> => {
    let [row] = await db
      .select({ id: instanceSettings.id, general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, \"default\"))
      .limit(1);

    if (!row) {
      await db
        .insert(instanceSettings)
        .values({ singletonKey: \"default\", general: {} })
        .onConflictDoNothing({ target: [instanceSettings.singletonKey] });

      [row] = await db
        .select({ id: instanceSettings.id, general: instanceSettings.general })
        .from(instanceSettings)
        .where(eq(instanceSettings.singletonKey, \"default\"))
        .limit(1);
    }

    const general =
      row && row.general && typeof row.general === \"object\" && !Array.isArray(row.general)
        ? (row.general as Record<string, unknown>)
        : {};

    return { id: row.id, general };
  };

  const upload = async (
    params: UploadLocaleParams,
  ): Promise<{
    valid: boolean;
    result: LocaleValidationResult;
    stored?: StoredCustomLocale;
  }> => {
    const validation = validate(params.catalog, {
      targetLocale: params.locale,
      strict: params.strict,
    });

    if (!validation.valid && !params.dryRun) {
      throw badRequest(\"CATALOG_VALIDATION_FAILED\", {
        errors: validation.errors,
        report: validation.report,
      });
    }

    if (params.dryRun) {
      return {
        valid: validation.valid,
        result: validation,
      };
    }

    const normalizedJson = JSON.stringify(params.catalog);
    const checksum = crypto.createHash(\"sha256\").update(normalizedJson).digest(\"hex\");

    const { id, general } = await ensureSettingsRow();
    const customLocales = (
      general[CUSTOM_LOCALES_SETTINGS_KEY] &&
      typeof general[CUSTOM_LOCALES_SETTINGS_KEY] === \"object\" &&
      !Array.isArray(general[CUSTOM_LOCALES_SETTINGS_KEY])
        ? general[CUSTOM_LOCALES_SETTINGS_KEY]
        : {}
    ) as Record<string, StoredCustomLocale>;

    const prevRecord = customLocales[params.locale];
    const version = (prevRecord?.version ?? 0) + 1;

    const stored: StoredCustomLocale = {
      locale: params.locale,
      version,
      uploadedAt: new Date().toISOString(),
      uploadedBy: params.actorId ?? null,
      keyCount: validation.report.totalCandidateKeys,
      checksum,
      catalog: params.catalog,
    };

    const nextCustomLocales = {
      ...customLocales,
      [params.locale]: stored,
    };

    await db
      .update(instanceSettings)
      .set({
        general: {
          ...general,
          [CUSTOM_LOCALES_SETTINGS_KEY]: nextCustomLocales,
        },
        updatedAt: new Date(),
      })
      .where(eq(instanceSettings.id, id));

    return {
      valid: validation.valid,
      result: validation,
      stored,
    };
  };

  const listCustomLocales = async (): Promise<StoredCustomLocaleSummary[]> => {
    const { general } = await ensureSettingsRow();
    const customLocales = (
      general[CUSTOM_LOCALES_SETTINGS_KEY] &&
      typeof general[CUSTOM_LOCALES_SETTINGS_KEY] === \"object\" &&
      !Array.isArray(general[CUSTOM_LOCALES_SETTINGS_KEY])
        ? general[CUSTOM_LOCALES_SETTINGS_KEY]
        : {}
    ) as Record<string, StoredCustomLocale>;

    return Object.values(customLocales).map((item) => ({
      locale: item.locale,
      version: item.version,
      uploadedAt: item.uploadedAt,
      uploadedBy: item.uploadedBy,
      keyCount: item.keyCount,
      checksum: item.checksum,
    }));
  };

  const getCustomLocale = async (locale: string): Promise<StoredCustomLocale | null> => {
    const { general } = await ensureSettingsRow();
    const customLocales = (
      general[CUSTOM_LOCALES_SETTINGS_KEY] &&
      typeof general[CUSTOM_LOCALES_SETTINGS_KEY] === \"object\" &&
      !Array.isArray(general[CUSTOM_LOCALES_SETTINGS_KEY])
        ? general[CUSTOM_LOCALES_SETTINGS_KEY]
        : {}
    ) as Record<string, StoredCustomLocale>;

    return customLocales[locale] ?? null;
  };

  const deleteCustomLocale = async (locale: string): Promise<boolean> => {
    const { id, general } = await ensureSettingsRow();
    const customLocales = (
      general[CUSTOM_LOCALES_SETTINGS_KEY] &&
      typeof general[CUSTOM_LOCALES_SETTINGS_KEY] === \"object\" &&
      !Array.isArray(general[CUSTOM_LOCALES_SETTINGS_KEY])
        ? general[CUSTOM_LOCALES_SETTINGS_KEY]
        : {}
    ) as Record<string, StoredCustomLocale>;

    if (!(locale in customLocales)) {
      return false;
    }

    const nextCustomLocales = { ...customLocales };
    delete nextCustomLocales[locale];

    await db
      .update(instanceSettings)
      .set({
        general: {
          ...general,
          [CUSTOM_LOCALES_SETTINGS_KEY]: nextCustomLocales,
        },
        updatedAt: new Date(),
      })
      .where(eq(instanceSettings.id, id));

    return true;
  };

  return {
    getBaseCatalog,
    validate,
    upload,
    listCustomLocales,
    getCustomLocale,
    deleteCustomLocale,
  };
}

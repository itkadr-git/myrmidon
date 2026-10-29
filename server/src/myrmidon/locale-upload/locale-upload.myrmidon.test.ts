import express from \"express\";
import request from \"supertest\";
import { describe, expect, it } from \"vitest\";
import type { Db } from \"@myrmidon/db\";
import type { StoredCustomLocale } from \"@myrmidon/shared\";
import { errorHandler } from \"../../middleware/index.js\";
import { localeUploadRoutes } from \"./routes.js\";
import {
  validateCatalog,
  parseCatalogJson,
  flattenCatalog,
} from \"./validator.js\";
import type { LocaleUploadService } from \"./service.js\";

const boardActor = {
  type: \"board\",
  source: \"session\",
  userId: \"admin-user-1\",
  isInstanceAdmin: true,
  companyIds: [\"company-1\"],
};

const agentActor = {
  type: \"agent\",
  source: \"agent_key\",
  agentId: \"agent-1\",
  companyId: \"company-1\",
};

const SAMPLE_BASE_CATALOG = {
  common: {
    save: \"Save\",
    cancel: \"Cancel\",
    welcome: \"Welcome, {{name}}!\",
    itemsCount: \"You have {{count}} items\",
  },
  settings: {
    title: \"Settings\",
    theme: \"Theme: {{mode}}\",
  },
};

function createMockService(initialLocales: Record<string, StoredCustomLocale> = {}): LocaleUploadService {
  const store = { ...initialLocales };

  return {
    getBaseCatalog: () => SAMPLE_BASE_CATALOG,
    validate: (catalog, options) => {
      return validateCatalog(catalog, SAMPLE_BASE_CATALOG, {
        targetLocale: options?.targetLocale ?? \"custom\",
        strict: options?.strict ?? false,
      });
    },
    upload: async (params) => {
      const validation = validateCatalog(params.catalog, SAMPLE_BASE_CATALOG, {
        targetLocale: params.locale,
        strict: params.strict ?? false,
      });

      if (!validation.valid && !params.dryRun) {
        const error = new Error(\"CATALOG_VALIDATION_FAILED\") as Error & {
          statusCode?: number;
          body?: unknown;
        };
        error.statusCode = 400;
        error.body = {
          success: false,
          valid: false,
          error: \"CATALOG_VALIDATION_FAILED\",
          errors: validation.errors,
          report: validation.report,
        };
        throw error;
      }

      if (params.dryRun) {
        return {
          valid: validation.valid,
          result: validation,
        };
      }

      const existing = store[params.locale];
      const version = existing ? existing.version + 1 : 1;
      const storedRecord: StoredCustomLocale = {
        locale: params.locale,
        version,
        uploadedAt: \"2026-10-29T16:00:00.000Z\",
        uploadedBy: params.actorId ?? null,
        keyCount: validation.report.totalCandidateKeys,
        checksum: \"mock-checksum-sha256\",
        catalog: params.catalog as Record<string, unknown>,
      };
      store[params.locale] = storedRecord;

      return {
        valid: validation.valid,
        result: validation,
        stored: storedRecord,
      };
    },
    listCustomLocales: async () => {
      return Object.values(store).map((item) => ({
        locale: item.locale,
        version: item.version,
        uploadedAt: item.uploadedAt,
        uploadedBy: item.uploadedBy,
        keyCount: item.keyCount,
        checksum: item.checksum,
      }));
    },
    getCustomLocale: async (locale) => store[locale] ?? null,
    deleteCustomLocale: async (locale) => {
      if (!store[locale]) return false;
      delete store[locale];
      return true;
    },
  };
}

function createTestApp(actor: unknown = boardActor, service?: LocaleUploadService) {
  const s = service ?? createMockService();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use(\"/api\", localeUploadRoutes({} as Db, s));
  app.use(errorHandler);
  return { app, service: s };
}

describe(\"myrmidon(1.7 LOCALE-UPLOAD E.1, OPE-9645): Validator unit tests\", () => {
  it(\"parses valid JSON string\", () => {
    const res = parseCatalogJson('{\"common\":{\"save\":\"Speichern\"}}');
    expect(res.error).toBeUndefined();
    expect(res.catalog).toEqual({ common: { save: \"Speichern\" } });
  });

  it(\"detects broken JSON syntax (битый каталог)\", () => {
    const res = parseCatalogJson('{\"common\":{\"save\": missing quote}}');
    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/Invalid JSON/);
  });

  it(\"rejects non-object root in parseCatalogJson\", () => {
    const res = parseCatalogJson('[\"not\", \"an\", \"object\"]');
    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/JSON root must be an object/);
  });

  it(\"validates a fully valid catalog and reports correct key diff\", () => {
    const candidate = {
      common: {
        save: \"Сохранить\",
        cancel: \"Отмена\",
        welcome: \"Добро пожаловать, {{name}}!\",
        itemsCount: \"У вас {{count}} элементов\",
      },
      settings: {
        title: \"Настройки\",
        theme: \"Тема: {{mode}}\",
      },
      extraSection: {
        extraKey: \"Дополнительное значение\",
      },
    };

    const res = validateCatalog(candidate, SAMPLE_BASE_CATALOG, { targetLocale: \"ru\" });
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.report.totalBaseKeys).toBe(6);
    expect(res.report.matchedCount).toBe(6);
    expect(res.report.missingCount).toBe(0);
    expect(res.report.extraCount).toBe(1);
    expect(res.report.extraKeys).toContain(\"extraSection.extraKey\");
    expect(res.report.newKeys).toContain(\"extraSection.extraKey\");
  });

  it(\"reports missing keys when candidate has only partial translations\", () => {
    const candidate = {
      common: {
        save: \"Guardar\",
      },
    };

    const res = validateCatalog(candidate, SAMPLE_BASE_CATALOG, { targetLocale: \"es\" });
    expect(res.valid).toBe(true); // valid to upload partial in non-strict mode
    expect(res.report.matchedCount).toBe(1);
    expect(res.report.missingCount).toBe(5);
    expect(res.report.missingKeys).toContain(\"common.cancel\");
    expect(res.report.missingKeys).toContain(\"settings.title\");
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it(\"fails strict validation when keys are missing\", () => {
    const candidate = {
      common: {
        save: \"Enregistrer\",
      },
    };

    const res = validateCatalog(candidate, SAMPLE_BASE_CATALOG, {
      targetLocale: \"fr\",
      strict: true,
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === \"MISSING_KEY\")).toBe(true);
  });

  it(\"rejects candidate with non-string leaf nodes (structural violation)\", () => {
    const candidate = {
      common: {
        save: 12345, // invalid type!
        cancel: [\"array\", \"not\", \"allowed\"],
      },
    };

    const res = validateCatalog(candidate, SAMPLE_BASE_CATALOG, { targetLocale: \"de\" });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.path === \"common.save\" && e.code === \"INVALID_TYPE\")).toBe(true);
    expect(res.errors.some((e) => e.path === \"common.cancel\" && e.code === \"INVALID_TYPE\")).toBe(true);
  });

  it(\"rejects candidate with placeholder mismatch\", () => {
    const candidate = {
      common: {
        save: \"Save\",
        cancel: \"Cancel\",
        welcome: \"Welcome, {{user}}!\", // mismatch: base has {{name}}!
        itemsCount: \"Items without count\", // missing {{count}}!
      },
    };

    const res = validateCatalog(candidate, SAMPLE_BASE_CATALOG, { targetLocale: \"de\" });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.path === \"common.welcome\" && e.code === \"PLACEHOLDER_MISMATCH\")).toBe(true);
    expect(res.errors.some((e) => e.path === \"common.itemsCount\" && e.code === \"PLACEHOLDER_MISMATCH\")).toBe(true);
  });

  it(\"rejects candidate with XSS or disallowed HTML payload\", () => {
    const candidate = {
      common: {
        save: \"<script>alert('xss')</script>\",
        cancel: \"Cancel <div onclick='hack()'>click</div>\",
      },
    };

    const res = validateCatalog(candidate, SAMPLE_BASE_CATALOG, { targetLocale: \"de\" });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === \"DISALLOWED_PAYLOAD\")).toBe(true);
  });

  it(\"flattens catalog keys accurately\", () => {
    const map = flattenCatalog(SAMPLE_BASE_CATALOG);
    expect(map.get(\"common.save\")).toBe(\"Save\");
    expect(map.get(\"settings.theme\")).toBe(\"Theme: {{mode}}\");
    expect(map.size).toBe(6);
  });
});

describe(\"myrmidon(1.7 LOCALE-UPLOAD E.1, OPE-9645): API route endpoints\", () => {
  it(\"POST /api/myrmidon/locales/upload accepts valid JSON body\", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post(\"/api/myrmidon/locales/upload\")
      .send({
        locale: \"de\",
        catalog: {
          common: {
            save: \"Speichern\",
            cancel: \"Abbrechen\",
            welcome: \"Willkommen, {{name}}!\",
            itemsCount: \"Sie haben {{count}} Elemente\",
          },
        },
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.valid).toBe(true);
    expect(res.body.targetLocale).toBe(\"de\");
    expect(res.body.baseLocale).toBe(\"en\");
    expect(res.body.report.matchedCount).toBe(4);
    expect(res.body.report.missingCount).toBe(2);
    expect(res.body.stored).toBeDefined();
    expect(res.body.stored.version).toBe(1);
    expect(res.body.stored.keyCount).toBe(4);
  });

  it(\"POST /api/myrmidon/locales/upload accepts multipart file upload\", async () => {
    const { app } = createTestApp();
    const catalogJson = JSON.stringify({
      common: {
        save: \"Enregistrer\",
        cancel: \"Annuler\",
        welcome: \"Bienvenue, {{name}}!\",
        itemsCount: \"Vous avez {{count}} éléments\",
      },
    });

    const res = await request(app)
      .post(\"/api/myrmidon/locales/upload\")
      .attach(\"file\", Buffer.from(catalogJson), \"fr.json\")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.targetLocale).toBe(\"fr\");
    expect(res.body.stored.version).toBe(1);
  });

  it(\"POST /api/myrmidon/locales/upload returns 400 on broken JSON syntax (битый каталог)\", async () => {
    const { app } = createTestApp();
    const brokenJson = '{\"common\": {\"save\": missing_quotes_and_corrupt';

    const res = await request(app)
      .post(\"/api/myrmidon/locales/upload\")
      .attach(\"file\", Buffer.from(brokenJson), \"broken.json\")
      .expect(400);

    expect(res.body.error).toMatch(/Invalid JSON/);
  });

  it(\"POST /api/myrmidon/locales/upload returns 400 on broken structure / non-string leaf\", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post(\"/api/myrmidon/locales/upload\")
      .send({
        locale: \"ru\",
        catalog: {
          common: {
            save: [\"invalid\", \"array\"],
          },
        },
      })
      .expect(400);

    expect(res.body.error).toBe(\"CATALOG_VALIDATION_FAILED\");
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.some((e: { code: string }) => e.code === \"INVALID_TYPE\")).toBe(true);
  });

  it(\"POST /api/myrmidon/locales/upload returns 400 on placeholder mismatch\", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post(\"/api/myrmidon/locales/upload\")
      .send({
        locale: \"it\",
        catalog: {
          common: {
            welcome: \"Benvenuto, {{wrongPlaceholder}}!\",
          },
        },
      })
      .expect(400);

    expect(res.body.error).toBe(\"CATALOG_VALIDATION_FAILED\");
    expect(res.body.errors.some((e: { code: string }) => e.code === \"PLACEHOLDER_MISMATCH\")).toBe(true);
  });

  it(\"POST /api/myrmidon/locales/upload with dryRun=true validates without persisting\", async () => {
    const { app, service } = createTestApp();
    const res = await request(app)
      .post(\"/api/myrmidon/locales/upload\")
      .send({
        locale: \"es\",
        dryRun: true,
        catalog: {
          common: {
            save: \"Guardar\",
          },
        },
      })
      .expect(200);

    expect(res.body.valid).toBe(true);
    expect(res.body.stored).toBeUndefined();

    // Verify it was not stored in service
    const stored = await service.getCustomLocale(\"es\");
    expect(stored).toBeNull();
  });

  it(\"POST /api/myrmidon/locales/validate returns diff report without storing\", async () => {
    const { app, service } = createTestApp();
    const res = await request(app)
      .post(\"/api/myrmidon/locales/validate\")
      .send({
        locale: \"pl\",
        catalog: {
          common: {
            save: \"Zapisz\",
            extra: \"Dodatkowy\",
          },
        },
      })
      .expect(200);

    expect(res.body.valid).toBe(true);
    expect(res.body.report.matchedCount).toBe(1);
    expect(res.body.report.missingCount).toBe(5);
    expect(res.body.report.extraCount).toBe(1);
    expect(res.body.report.extraKeys).toContain(\"common.extra\");

    const stored = await service.getCustomLocale(\"pl\");
    expect(stored).toBeNull();
  });

  it(\"enforces board authorization: rejects agent actor with 403\", async () => {
    const { app } = createTestApp(agentActor);
    await request(app)
      .post(\"/api/myrmidon/locales/upload\")
      .send({
        locale: \"de\",
        catalog: { common: { save: \"Speichern\" } },
      })
      .expect(403);
  });

  it(\"GET /api/myrmidon/locales/custom lists uploaded locales and supports deletion\", async () => {
    const initialLocale: StoredCustomLocale = {
      locale: \"de\",
      version: 1,
      uploadedAt: \"2026-10-29T12:00:00.000Z\",
      uploadedBy: \"user-1\",
      keyCount: 10,
      checksum: \"abc123sha\",
      catalog: { common: { save: \"Speichern\" } },
    };

    const { app } = createTestApp(boardActor, createMockService({ de: initialLocale }));

    // List
    const listRes = await request(app).get(\"/api/myrmidon/locales/custom\").expect(200);
    expect(listRes.body.customLocales).toHaveLength(1);
    expect(listRes.body.customLocales[0].locale).toBe(\"de\");

    // Get specific
    const getRes = await request(app).get(\"/api/myrmidon/locales/custom/de\").expect(200);
    expect(getRes.body.customLocale.locale).toBe(\"de\");
    expect(getRes.body.customLocale.catalog.common.save).toBe(\"Speichern\");

    // Delete
    await request(app).delete(\"/api/myrmidon/locales/custom/de\").expect(200);

    // Verify 404 after deletion
    await request(app).get(\"/api/myrmidon/locales/custom/de\").expect(404);
  });
});

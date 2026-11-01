import fs from "node:fs";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import type { StoredCustomLocale } from "@myrmidon/shared";
import { localeUploadRoutes } from "./routes.js";
import {
  createLocaleUploadService,
  loadBaseEnglishCatalog,
  resetBaseCatalogCache,
  type LocaleUploadService,
} from "./service.js";
import {
  extractPlaceholders,
  findDisallowedPayloads,
  flattenCatalog,
  formatPath,
  isPlainObject,
  parseCatalogJson,
  validateCatalog,
} from "./validator.js";

function createStatefulMockDb(): any {
  const row: { general: Record<string, unknown> } = { general: {} };
  return {
    select: (_selection: unknown) => ({
      from: (_table: unknown) => ({
        where: (_condition: unknown) => ({ limit: async (_count: number) => [{ general: row.general }] }),
      }),
    }),
    insert: (_table: unknown) => ({ values: (_value: unknown) => ({ onConflictDoNothing: async () => undefined }) }),
    update: (_table: unknown) => ({
      set: (patch: { general: Record<string, unknown> }) => ({
        where: async (_condition: unknown) => {
          row.general = patch.general;
        },
      }),
    }),
  };
}

const sampleBaseCatalog = {
  app: {
    title: "Myrmidon",
    welcome: "Welcome to {{company}}!",
    description: "Multi-agent company orchestrator",
  },
  common: {
    save: "Save",
    cancel: "Cancel",
    confirm_action: "Are you sure you want to delete {item}?",
  },
  settings: {
    language: "Language",
    profile: {
      name: "Name",
      email: "Email",
    },
  },
};

describe("validator unit tests", () => {
  it("detects plain objects correctly", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject("string")).toBe(false);
    expect(isPlainObject(123)).toBe(false);
  });

  it("formats key paths", () => {
    expect(formatPath([])).toBe("<root>");
    expect(formatPath(["app", "title"])).toBe("app.title");
  });

  it("extracts curly and double-curly placeholders", () => {
    expect(extractPlaceholders("Hello {{name}} and {role}")).toEqual(["name", "role"]);
    expect(extractPlaceholders("No placeholders here")).toEqual([]);
    expect(extractPlaceholders("Duplicate {{key}} and {{key}}")).toEqual(["key"]);
  });

  it("identifies disallowed payloads (script tags, event handlers, javascript/data URIs)", () => {
    expect(findDisallowedPayloads("<script>alert(1)</script>")).toContain("<script");
    expect(findDisallowedPayloads('<button onclick="doBad()">Click</button>')).toContain(
      "event-handler attribute",
    );
    expect(findDisallowedPayloads('Visit javascript:alert("pwned")')).toContain("javascript:");
    expect(findDisallowedPayloads("Image data:image/png;base64,AAA")).toContain("data:");
    expect(findDisallowedPayloads("Hello world")).toEqual([]);
  });

  it("flattens nested catalog objects to dot-delimited key-value maps", () => {
    const flattened = flattenCatalog(sampleBaseCatalog);
    expect(flattened.get("app.title")).toBe("Myrmidon");
    expect(flattened.get("app.welcome")).toBe("Welcome to {{company}}!");
    expect(flattened.get("settings.profile.name")).toBe("Name");
    expect(flattened.size).toBe(9);
  });

  it("parses catalog JSON strings and buffers", () => {
    const parsedValid = parseCatalogJson('{"app":{"title":"Test"}}');
    expect(parsedValid.error).toBeUndefined();
    expect(parsedValid.catalog).toEqual({ app: { title: "Test" } });

    const parsedArray = parseCatalogJson("[1, 2, 3]");
    expect(parsedArray.error).toBeDefined();
    expect(parsedArray.error).toContain("must be a JSON object");

    const parsedSyntaxError = parseCatalogJson("{invalid json");
    expect(parsedSyntaxError.error).toBeDefined();
    expect(parsedSyntaxError.error).toContain("Invalid JSON syntax");
  });

  it("validates catalog against base and calculates accurate diff report", () => {
    const candidate = {
      app: {
        title: "Мирмидон",
        welcome: "Добро пожаловать в {{company}}!",
      },
      common: {
        save: "Сохранить",
        cancel: "Отмена",
        confirm_action: "Вы уверены, что хотите удалить {item}?",
      },
      custom_feature: {
        label: "Новая функция",
      },
    };

    const result = validateCatalog(candidate, sampleBaseCatalog, {
      targetLocale: "ru",
      baseLocale: "en",
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.report.totalBaseKeys).toBe(9);
    expect(result.report.totalCandidateKeys).toBe(6);
    expect(result.report.matchedCount).toBe(5);
    expect(result.report.missingCount).toBe(4);
    expect(result.report.extraCount).toBe(1);
    expect(result.report.missingKeys).toEqual([
      "app.description",
      "settings.language",
      "settings.profile.email",
      "settings.profile.name",
    ]);
    expect(result.report.extraKeys).toEqual(["custom_feature.label"]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("catches placeholder mismatch between base and candidate", () => {
    const candidate = {
      app: {
        title: "Myrmidon",
        welcome: "Welcome to {{organization}}!", // expected {{company}}
        description: "Desc",
      },
      common: {
        save: "Save",
        cancel: "Cancel",
        confirm_action: "Delete {item}?",
      },
      settings: {
        language: "Lang",
        profile: {
          name: "Name",
          email: "Email",
        },
      },
    };

    const result = validateCatalog(candidate, sampleBaseCatalog);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "PLACEHOLDER_MISMATCH")).toBe(true);
  });

  it("enforces strict mode where missing base keys result in errors", () => {
    const candidate = {
      app: { title: "Title" },
    };

    const strictResult = validateCatalog(candidate, sampleBaseCatalog, { strict: true });
    expect(strictResult.valid).toBe(false);
    expect(strictResult.errors.some((e) => e.message.includes("Missing required base translation key"))).toBe(
      true,
    );
  });
});

describe("base English catalog loader", () => {
  it("loads the packaged English reference catalog", () => {
    resetBaseCatalogCache();
    const catalog = loadBaseEnglishCatalog();
    expect(typeof catalog).toBe("object");
    expect(catalog).not.toBeNull();
    expect(Object.keys(catalog).length).toBeGreaterThan(0);
  });

  it("throws a descriptive error when no reference file exists", () => {
    resetBaseCatalogCache();
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    try {
      expect(() => loadBaseEnglishCatalog()).toThrow(
        "Failed to load base English catalog: reference file not found or invalid JSON",
      );
    } finally {
      existsSpy.mockRestore();
      resetBaseCatalogCache();
    }
  });
});

describe("stateful service persistence logic", () => {
  it("changes the checksum when a nested catalog value changes", async () => {
    const db = createStatefulMockDb();
    const service = createLocaleUploadService(db as Db, { baseCatalog: sampleBaseCatalog });
    const first = {
      app: { title: "Titel", welcome: "Willkommen bei {{company}}!", description: "Text" },
      common: { save: "Speichern", cancel: "Abbrechen", confirm_action: "Löschen {item}?" },
      settings: { language: "Sprache", profile: { name: "Name", email: "E-Mail" } },
    };
    const changedNestedValue = {
      ...first,
      settings: { ...first.settings, profile: { ...first.settings.profile, email: "Adresse" } },
    };

    const firstResult = await service.uploadLocale({ locale: "de", catalog: first, dryRun: true });
    const changedResult = await service.uploadLocale({
      locale: "de",
      catalog: changedNestedValue,
      dryRun: true,
    });

    expect(firstResult.checksum).not.toBe(changedResult.checksum);
  });

  it("persists uploaded locales, increments versions, and provides summaries", async () => {
    const store: Record<string, unknown> = {
      instanceSettings: {
        default: { singletonKey: "default", general: {} },
      },
    };

    const mockDb: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              const row = (store.instanceSettings as any)["default"];
              return row ? [{ general: row.general }] : [];
            },
          }),
        }),
      }),
      insert: () => ({
        values: (val: any) => ({
          onConflictDoNothing: async () => {
            if (!(store.instanceSettings as any)[val.singletonKey]) {
              (store.instanceSettings as any)[val.singletonKey] = { ...val };
            }
          },
        }),
      }),
      update: () => ({
        set: (patch: any) => ({
          where: async () => {
            const current = (store.instanceSettings as any)["default"] || { general: {} };
            current.general = patch.general;
            (store.instanceSettings as any)["default"] = current;
          },
        }),
      }),
    };

    const service = createLocaleUploadService(mockDb as Db, {
      baseCatalog: sampleBaseCatalog,
    });

    const candidate1 = {
      app: {
        title: "Titel V1",
        welcome: "Willkommen bei {{company}}!",
        description: "Orchestrierung",
      },
      common: {
        save: "Speichern",
        cancel: "Abbrechen",
        confirm_action: "Löschen {item}?",
      },
      settings: {
        language: "Sprache",
        profile: {
          name: "Name",
          email: "E-Mail",
        },
      },
    };

    const res1 = await service.uploadLocale({
      locale: "de",
      catalog: candidate1,
      uploadedBy: "user-1",
    });

    expect(res1.stored).toBe(true);
    expect(res1.version).toBe(1);
    expect(res1.locale).toBe("de");
    expect(res1.validation.valid).toBe(true);

    const stored1 = await service.getCustomLocale("de");
    expect(stored1).not.toBeNull();
    expect(stored1?.version).toBe(1);
    expect(stored1?.uploadedBy).toBe("user-1");

    // Re-upload should increment version to 2
    const candidate2 = {
      ...candidate1,
      app: {
        ...candidate1.app,
        title: "Titel V2",
      },
    };

    const res2 = await service.uploadLocale({
      locale: "de",
      catalog: candidate2,
      uploadedBy: "user-2",
    });

    expect(res2.stored).toBe(true);
    expect(res2.version).toBe(2);

    const summaries = await service.listCustomLocales();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].locale).toBe("de");
    expect(summaries[0].version).toBe(2);

    const deleted = await service.deleteCustomLocale("de");
    expect(deleted).toBe(true);

    const deletedAgain = await service.deleteCustomLocale("de");
    expect(deletedAgain).toBe(false);

    const storedAfterDelete = await service.getCustomLocale("de");
    expect(storedAfterDelete).toBeNull();
  });
});

describe("locale upload HTTP routes", () => {
  function createTestApp(options: {
    actor?: { type: "board" | "agent" | "none"; userId?: string; agentId?: string };
    service?: LocaleUploadService;
  } = {}) {
    const app = express();
    app.use(express.json({ limit: "10mb" }));

    app.use((req, _res, next) => {
      req.actor = options.actor ?? { type: "board", userId: "user-admin" };
      next();
    });

    const mockDb: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    };

    const router = localeUploadRoutes(mockDb, {
      baseCatalog: sampleBaseCatalog,
      service: options.service,
    });
    app.use("/api", router);

    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = err.statusCode || err.status || 500;
      const detail = err instanceof Error ? err.message : String(err);
      res.status(status).json({
        error: err.code || err.name || "ERROR",
        message: err.details?.message || detail,
        details: err.details,
        ...(err.details?.errors ? { errors: err.details.errors } : {}),
      });
    });

    return app;
  }

  it("handles valid JSON upload and returns diff report", async () => {
    const app = createTestApp();
    const candidate = {
      app: {
        title: "Titre",
        welcome: "Bienvenue sur {{company}}!",
        description: "Desc",
      },
      common: {
        save: "Enregistrer",
        cancel: "Annuler",
        confirm_action: "Supprimer {item}?",
      },
      settings: {
        language: "Langue",
        profile: {
          name: "Nom",
          email: "Email",
        },
      },
    };

    const res = await request(app)
      .post("/api/myrmidon/locales/upload")
      .send({
        locale: "fr",
        catalog: candidate,
      })
      .expect(200);

    expect(res.body.stored).toBe(true);
    expect(res.body.locale).toBe("fr");
    expect(res.body.version).toBe(1);
    expect(res.body.validation.valid).toBe(true);
    expect(res.body.validation.report.matchedCount).toBe(9);
    expect(res.body.validation.report.coveragePercent).toBe(100);
  });

  it("supports dryRun=true mode without persistence", async () => {
    const app = createTestApp();
    const candidate = {
      app: {
        title: "Titre",
        welcome: "Bienvenue sur {{company}}!",
        description: "Desc",
      },
      common: {
        save: "Enregistrer",
        cancel: "Annuler",
        confirm_action: "Supprimer {item}?",
      },
      settings: {
        language: "Langue",
        profile: {
          name: "Nom",
          email: "Email",
        },
      },
    };

    const res = await request(app)
      .post("/api/myrmidon/locales/upload?dryRun=true")
      .send({
        locale: "fr",
        catalog: candidate,
      })
      .expect(200);

    expect(res.body.stored).toBe(false);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.validation.valid).toBe(true);
  });

  it("rejects non-board actors with 403 Forbidden", async () => {
    const app = createTestApp({
      actor: { type: "agent", agentId: "agent-123" },
    });

    await request(app)
      .post("/api/myrmidon/locales/upload")
      .send({
        locale: "es",
        catalog: { app: { title: "Titulo" } },
      })
      .expect(403);
  });

  it("validates catalog via /api/myrmidon/locales/validate endpoint", async () => {
    const app = createTestApp();

    const validCandidate = {
      app: {
        title: "Título",
        welcome: "Bienvenido a {{company}}!",
        description: "Desc",
      },
      common: {
        save: "Guardar",
        cancel: "Cancelar",
        confirm_action: "Eliminar {item}?",
      },
      settings: {
        language: "Idioma",
        profile: {
          name: "Nombre",
          email: "Email",
        },
      },
    };

    const res = await request(app)
      .post("/api/myrmidon/locales/validate")
      .send({
        locale: "es",
        catalog: validCandidate,
      })
      .expect(200);

    expect(res.body.valid).toBe(true);
    expect(res.body.report.matchedCount).toBe(9);

    // Broken candidate with placeholder mismatch
    const brokenCandidate = {
      ...validCandidate,
      app: {
        ...validCandidate.app,
        welcome: "Bienvenido a {{org}}!",
      },
    };

    const brokenRes = await request(app)
      .post("/api/myrmidon/locales/validate")
      .send({
        locale: "es",
        catalog: brokenCandidate,
      })
      .expect(400);

    expect(brokenRes.body.error).toBe("CATALOG_VALIDATION_FAILED");
    expect(brokenRes.body.errors.some((e: any) => e.code === "PLACEHOLDER_MISMATCH")).toBe(true);
  });

  it("supports multipart/form-data file upload", async () => {
    const app = createTestApp();

    const fileContent = JSON.stringify({
      app: {
        title: "Titel",
        welcome: "Willkommen bei {{company}}!",
        description: "Desc",
      },
      common: {
        save: "Speichern",
        cancel: "Abbrechen",
        confirm_action: "Löschen {item}?",
      },
      settings: {
        language: "Sprache",
        profile: {
          name: "Name",
          email: "Email",
        },
      },
    });

    const res = await request(app)
      .post("/api/myrmidon/locales/upload")
      .attach("file", Buffer.from(fileContent, "utf-8"), "de.json")
      .expect(200);

    expect(res.body.stored).toBe(true);
    expect(res.body.locale).toBe("de");
  });

  it("provides CRUD operations: list, get, and delete", async () => {
    const customStore: Record<string, StoredCustomLocale> = {
      de: {
        locale: "de",
        version: 1,
        uploadedAt: new Date().toISOString(),
        uploadedBy: "admin",
        keyCount: 7,
        checksum: "abc123hash",
        catalog: { common: { save: "Speichern" } },
      },
    };

    const mockService: LocaleUploadService = {
      async uploadLocale() {
        throw new Error("not implemented");
      },
      async validateOnly() {
        throw new Error("not implemented");
      },
      async listCustomLocales() {
        return Object.values(customStore).map((c) => ({
          locale: c.locale,
          version: c.version,
          uploadedAt: c.uploadedAt,
          uploadedBy: c.uploadedBy,
          keyCount: c.keyCount,
          checksum: c.checksum,
        }));
      },
      async getCustomLocale(locale: string) {
        return customStore[locale] ?? null;
      },
      async deleteCustomLocale(locale: string) {
        if (!customStore[locale]) return false;
        delete customStore[locale];
        return true;
      },
    };

    const app = createTestApp({ service: mockService });

    const listRes = await request(app).get("/api/myrmidon/locales/custom").expect(200);
    expect(listRes.body.total).toBe(1);
    expect(listRes.body.locales[0].locale).toBe("de");

    const getRes = await request(app).get("/api/myrmidon/locales/custom/de").expect(200);
    expect(getRes.body.catalog.common.save).toBe("Speichern");

    await request(app).delete("/api/myrmidon/locales/custom/de").expect(200);
    await request(app).get("/api/myrmidon/locales/custom/de").expect(404);
  });
});

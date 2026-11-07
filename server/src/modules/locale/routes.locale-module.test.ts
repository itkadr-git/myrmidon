// myrmidon(1.7 LOCALE-UPLOAD / OPE-12117): contract tests for the /api/locale
// module (routes + service, no real database — the mock mirrors the
// createStatefulMockDb pattern of locale-upload.myrmidon.test.ts).
//
// Acceptance criteria (OPE-12117): valid upload stores a new version, GET
// current returns the active stored version, invalid JSON answers 400.
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { localeModuleRoutes } from "./routes.js";
import { createLocaleModuleService } from "./service.js";

function createStatefulMockDb(): any {
  const row: { general: Record<string, unknown> } = { general: {} };
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ general: row.general }] }),
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
    update: () => ({
      set: (patch: { general: Record<string, unknown> }) => ({
        where: async () => {
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
    profile: { name: "Name", email: "Email" },
  },
};

const validRuCatalog = {
  app: {
    title: "Мирмидон",
    welcome: "Добро пожаловать в {{company}}!",
    description: "Оркестратор мультиагентной компании",
  },
  common: {
    save: "Save",
    cancel: "Отмена",
    confirm_action: "Вы уверены, что хотите удалить {item}?",
  },
  settings: {
    language: "Язык",
    profile: { name: "Имя", email: "Email" },
  },
};

function createTestApp(options: {
  actor?: { type: "board" | "agent" | "none"; userId?: string };
  service?: ReturnType<typeof createLocaleModuleService>;
} = {}) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.use((req, _res, next) => {
    req.actor = options.actor ?? { type: "board", userId: "user-admin" };
    next();
  });

  const router = localeModuleRoutes(createStatefulMockDb() as Db, {
    baseCatalog: sampleBaseCatalog,
    service: options.service,
  });
  app.use("/api", router);

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.statusCode || err.status || 500;
    const detail = err instanceof Error ? err.message : String(err);
    res.status(status).json({
      error: err.details?.code || err.code || err.name || "ERROR",
      message: err.details?.message || detail,
      ...(err.details?.errors ? { errors: err.details.errors } : {}),
    });
  });

  return app;
}

describe("locale module: POST /api/locale/upload", () => {
  it("accepts a valid ru JSON dictionary and stores it as a new version", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/api/locale/upload")
      .send({ locale: "ru", catalog: validRuCatalog })
      .expect(200);
    expect(res.body.stored).toBe(true);
    expect(res.body.locale).toBe("ru");
    expect(res.body.version).toBe(1);
    expect(res.body.validation.valid).toBe(true);
    expect(res.body.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("bumps the version on re-upload of the same locale", async () => {
    const app = createTestApp();
    await request(app)
      .post("/api/locale/upload")
      .send({ locale: "ru", catalog: validRuCatalog })
      .expect(200);
    const res = await request(app)
      .post("/api/locale/upload")
      .send({ locale: "ru", catalog: validRuCatalog })
      .expect(200);
    expect(res.body.version).toBe(2);
  });

  it("rejects a non-ru/en locale with 400", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/api/locale/upload")
      .send({ locale: "de", catalog: validRuCatalog })
      .expect(400);
    expect(res.body.error).toBe("INVALID_LOCALE");
  });

  it("rejects an invalid JSON payload or empty catalog with 400", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/api/locale/upload")
      .send({ locale: "ru", catalog: {} })
      .expect(400);
    expect(res.body.error).toBe("INVALID_CATALOG_JSON");
  });

  it("rejects missing locale field with 400", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/api/locale/upload")
      .send({ catalog: validRuCatalog })
      .expect(400);
    expect(res.body.error).toBe("INVALID_LOCALE");
  });

  it("accepts multipart/form-data upload with a .json file", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/api/locale/upload")
      .field("locale", "ru")
      .attach("file", Buffer.from(JSON.stringify(validRuCatalog)), "ru.json")
      .expect(200);
    expect(res.body.stored).toBe(true);
    expect(res.body.locale).toBe("ru");
    expect(res.body.version).toBe(1);
  });
});

describe("locale module: GET /api/locale/current", () => {
  it("returns base English catalog when no custom locale is uploaded", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/locale/current").expect(200);
    expect(res.body.locale).toBe("en");
    expect(res.body.version).toBe(1);
    expect(res.body.active).toBe(true);
    expect(res.body.catalog).toBeDefined();
  });

  it("returns active uploaded locale after successful upload", async () => {
    const service = createLocaleModuleService(createStatefulMockDb() as any, {
      baseCatalog: sampleBaseCatalog,
    });
    const app = createTestApp({ service });

    await request(app)
      .post("/api/locale/upload")
      .send({ locale: "ru", catalog: validRuCatalog })
      .expect(200);

    const res = await request(app).get("/api/locale/current").expect(200);
    expect(res.body.locale).toBe("ru");
    expect(res.body.version).toBe(1);
    expect(res.body.active).toBe(true);
    expect(res.body.catalog.app.title).toBe("Мирмидон");
  });
});

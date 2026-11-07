import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { myrmidonInstalledLocalesRoutes } from "./routes.js";
import {
  InstalledLocalesService,
  flattenCatalogKeys,
  type StoredCustomLocale,
} from "./service.js";

const boardActor = {
  type: "board",
  source: "session",
  userId: "user-test",
  isInstanceAdmin: true,
  companyIds: ["company-1"],
};

const anonymousActor = { type: "none" };

function createApp(service: InstalledLocalesService, actor: unknown = boardActor) {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    (_req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", myrmidonInstalledLocalesRoutes(undefined, service));
  app.use(errorHandler);
  return app;
}

describe("flattenCatalogKeys", () => {
  it("flattens nested object keys into dot-delimited paths", () => {
    const catalog = {
      app: {
        title: "Test App",
        nav: {
          home: "Home",
          settings: "Settings",
        },
      },
      status: "active",
    };
    const keys = flattenCatalogKeys(catalog);
    expect(keys).toEqual([
      "app.title",
      "app.nav.home",
      "app.nav.settings",
      "status",
    ]);
  });

  it("handles non-object and empty gracefully", () => {
    expect(flattenCatalogKeys(null)).toEqual([]);
    expect(flattenCatalogKeys(undefined)).toEqual([]);
    expect(flattenCatalogKeys([])).toEqual([]);
    expect(flattenCatalogKeys("string")).toEqual([]);
  });
});

describe("InstalledLocalesService", () => {
  const baseCatalog = {
    app: {
      title: "Myrmidon",
      welcome: "Welcome",
      actions: {
        save: "Save",
        cancel: "Cancel",
      },
    },
  };

  const customLocales: StoredCustomLocale[] = [
    {
      locale: "de-custom",
      name: "German Custom",
      version: 2,
      uploadedAt: "2026-10-15T12:00:00Z",
      catalog: {
        app: {
          title: "Myrmidon DE",
          welcome: "Willkommen",
          extra: "Zusatz",
        },
      },
    },
  ];

  it("lists installed locales with coverage percent calculation", async () => {
    const service = new InstalledLocalesService(undefined, {
      baseCatalog,
      customLocales,
    });

    const result = await service.listInstalledLocales();
    expect(result.baseLocale).toBe("en");
    expect(result.totalBaseKeys).toBe(4);

    const en = result.locales.find((l) => l.locale === "en");
    expect(en).toBeDefined();
    expect(en?.isDefault).toBe(true);
    expect(en?.isBuiltin).toBe(true);
    expect(en?.coveragePercent).toBe(100);
    expect(en?.matchedKeysCount).toBe(4);
    expect(en?.missingKeysCount).toBe(0);

    const deCustom = result.locales.find((l) => l.locale === "de-custom");
    expect(deCustom).toBeDefined();
    expect(deCustom?.isBuiltin).toBe(false);
    expect(deCustom?.isDefault).toBe(false);
    expect(deCustom?.version).toBe(2);
    // base has 4 keys, de-custom has app.title, app.welcome (2 matched out of 4 -> 50%)
    expect(deCustom?.matchedKeysCount).toBe(2);
    expect(deCustom?.missingKeysCount).toBe(2);
    expect(deCustom?.extraKeysCount).toBe(1);
    expect(deCustom?.coveragePercent).toBe(50);
  });

  it("filters locales by type (builtin vs custom)", async () => {
    const service = new InstalledLocalesService(undefined, {
      baseCatalog,
      customLocales,
    });

    const builtins = await service.listInstalledLocales({ type: "builtin" });
    expect(builtins.locales.every((l) => l.isBuiltin)).toBe(true);
    expect(builtins.locales.some((l) => l.locale === "en")).toBe(true);
    expect(builtins.locales.some((l) => l.locale === "de-custom")).toBe(false);

    const customs = await service.listInstalledLocales({ type: "custom" });
    expect(customs.locales.every((l) => !l.isBuiltin)).toBe(true);
    expect(customs.locales.some((l) => l.locale === "de-custom")).toBe(true);
  });

  it("filters locales by minCoverage and search term", async () => {
    const service = new InstalledLocalesService(undefined, {
      baseCatalog,
      customLocales,
    });

    const highCoverage = await service.listInstalledLocales({ minCoverage: 90 });
    expect(highCoverage.locales.every((l) => l.coveragePercent >= 90)).toBe(true);
    expect(highCoverage.locales.some((l) => l.locale === "de-custom")).toBe(false);

    const searchRes = await service.listInstalledLocales({ search: "custom" });
    expect(searchRes.locales.length).toBe(1);
    expect(searchRes.locales[0].locale).toBe("de-custom");
  });

  it("returns detailed coverage report for existing locale", async () => {
    const service = new InstalledLocalesService(undefined, {
      baseCatalog,
      customLocales,
    });

    const report = await service.getLocaleCoverage("de-custom");
    expect(report).not.toBeNull();
    expect(report?.locale).toBe("de-custom");
    expect(report?.coveragePercent).toBe(50);
    expect(report?.matchedKeys).toContain("app.title");
    expect(report?.matchedKeys).toContain("app.welcome");
    expect(report?.missingKeys).toContain("app.actions.save");
    expect(report?.missingKeys).toContain("app.actions.cancel");
    expect(report?.extraKeys).toContain("app.extra");
  });

  it("returns null when locale coverage is not found", async () => {
    const service = new InstalledLocalesService(undefined, {
      baseCatalog,
      customLocales: [],
    });

    const report = await service.getLocaleCoverage("non-existent-locale");
    expect(report).toBeNull();
  });
});

describe("myrmidonInstalledLocalesRoutes (HTTP endpoints)", () => {
  const baseCatalog = {
    app: {
      title: "Myrmidon",
      welcome: "Welcome",
    },
  };

  const customLocales: StoredCustomLocale[] = [
    {
      locale: "fr-custom",
      name: "French Custom",
      version: 1,
      catalog: {
        app: {
          title: "Myrmidon FR",
        },
      },
    },
  ];

  const service = new InstalledLocalesService(undefined, {
    baseCatalog,
    customLocales,
  });

  it("GET /api/myrmidon/locales returns 200 with installed locales", async () => {
    const app = createApp(service);
    const res = await request(app).get("/api/myrmidon/locales").expect(200);

    expect(res.body).toHaveProperty("baseLocale", "en");
    expect(res.body).toHaveProperty("totalBaseKeys");
    expect(res.body).toHaveProperty("locales");
    expect(Array.isArray(res.body.locales)).toBe(true);
    expect(res.body.locales.length).toBeGreaterThan(0);
  });

  it("GET /api/myrmidon/locales/installed is an alias for GET /api/myrmidon/locales", async () => {
    const app = createApp(service);
    const res = await request(app).get("/api/myrmidon/locales/installed").expect(200);

    expect(res.body).toHaveProperty("baseLocale", "en");
    expect(res.body).toHaveProperty("locales");
  });

  it("GET /api/myrmidon/locales rejects invalid query params with 400", async () => {
    const app = createApp(service);
    const res = await request(app)
      .get("/api/myrmidon/locales?minCoverage=150")
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("GET /api/myrmidon/locales rejects anonymous actor with 403", async () => {
    const app = createApp(service, anonymousActor);
    await request(app).get("/api/myrmidon/locales").expect(403);
  });

  it("GET /api/myrmidon/locales/:locale/coverage returns coverage details", async () => {
    const app = createApp(service);
    const res = await request(app)
      .get("/api/myrmidon/locales/fr-custom/coverage")
      .expect(200);

    expect(res.body).toHaveProperty("locale", "fr-custom");
    expect(res.body).toHaveProperty("coveragePercent", 50);
    expect(res.body).toHaveProperty("missingKeys");
    expect(res.body).toHaveProperty("extraKeys");
  });

  it("GET /api/myrmidon/locales/:locale/coverage returns 404 for missing locale", async () => {
    const app = createApp(service);
    const res = await request(app)
      .get("/api/myrmidon/locales/unknown-locale-xyz/coverage")
      .expect(404);

    expect(res.body).toHaveProperty("error");
  });

  it("GET /api/myrmidon/locales/:locale/coverage returns 400 for invalid locale slug", async () => {
    const app = createApp(service);
    const res = await request(app)
      .get("/api/myrmidon/locales/!invalid@slug/coverage")
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });
});

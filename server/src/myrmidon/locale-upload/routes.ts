import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import type { Db } from "@myrmidon/db";
import { badRequest, notFound } from "../../errors.js";
import { assertAuthenticated, assertBoard } from "../../routes/authz.js";
import { parseCatalogJson } from "./validator.js";
import {
  createLocaleUploadService,
  type LocaleUploadService,
  type LocaleUploadServiceOptions,
} from "./service.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 1,
  },
});

function handleFileUpload(req: Request, res: Response, next: NextFunction) {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    const middleware = upload.fields([
      { name: "file", maxCount: 1 },
      { name: "catalog", maxCount: 1 },
    ]);
    middleware(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return next(badRequest("FILE_TOO_LARGE", { message: "Uploaded catalog file exceeds 5MB limit" }));
        }
        return next(badRequest("UPLOAD_ERROR", { message: String(err) }));
      }
      next();
    });
  } else {
    next();
  }
}

export function localeUploadRoutes(
  db: Db,
  options?: LocaleUploadServiceOptions & { service?: LocaleUploadService },
): Router {
  const router = Router();
  const service = options?.service ?? createLocaleUploadService(db, options);

  async function parseUploadPayload(req: Request): Promise<{
    locale: string;
    catalog: Record<string, unknown>;
    dryRun: boolean;
    strict: boolean;
  }> {
    const body = (req.body || {}) as Record<string, unknown>;
    const query = (req.query || {}) as Record<string, unknown>;

    let rawCatalog: Record<string, unknown> | null = null;
    let detectedLocale = "";

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const file = files?.file?.[0] || files?.catalog?.[0];
    if (file && file.buffer) {
      const parseResult = parseCatalogJson(file.buffer);
      if (parseResult.error || !parseResult.catalog) {
        throw badRequest(parseResult.error || "Failed to parse JSON file");
      }
      rawCatalog = parseResult.catalog;

      const originalName = file.originalname || "";
      const match = originalName.match(/^([a-zA-Z0-9_-]+)\.json$/i);
      if (match && match[1]) {
        detectedLocale = match[1];
      }
    }

    const localeParam = (
      (body.locale as string) ||
      (query.locale as string) ||
      detectedLocale ||
      ""
    ).trim();

    if (!localeParam) {
      throw badRequest("Locale identifier is required (e.g. 'fr', 'de', 'custom-1')");
    }

    if (!/^[a-zA-Z0-9_-]{2,35}$/.test(localeParam)) {
      throw badRequest("Invalid locale identifier format: must be 2-35 alphanumeric chars, dashes or underscores");
    }

    if (!rawCatalog) {
      if (body.catalog && typeof body.catalog === "object" && !Array.isArray(body.catalog)) {
        rawCatalog = body.catalog as Record<string, unknown>;
      } else if (body.content && typeof body.content === "string") {
        const parsed = parseCatalogJson(body.content);
        if (parsed.error || !parsed.catalog) {
          throw badRequest(parsed.error || "Invalid JSON in content field");
        }
        rawCatalog = parsed.catalog;
      } else if (typeof body === "object" && !Array.isArray(body) && !body.catalog && Object.keys(body).length > 0 && !body.locale) {
        rawCatalog = body;
      }
    }

    if (!rawCatalog) {
      throw badRequest("Missing localization catalog data. Send a JSON file or catalog object in request body");
    }

    const dryRun =
      body.dryRun === true ||
      body.dryRun === "true" ||
      query.dryRun === "true" ||
      query.dryRun === "1";

    const strict =
      body.strict === true ||
      body.strict === "true" ||
      query.strict === "true" ||
      query.strict === "1";

    return {
      locale: localeParam,
      catalog: rawCatalog,
      dryRun,
      strict,
    };
  }

  const handleUpload = async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertAuthenticated(req);
      assertBoard(req);

      const payload = await parseUploadPayload(req);
      const uploadedBy = req.actor.userId ?? null;

      const result = await service.uploadLocale({
        locale: payload.locale,
        catalog: payload.catalog,
        uploadedBy,
        dryRun: payload.dryRun,
        strict: payload.strict,
      });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  router.post("/myrmidon/locales/validate", handleFileUpload, async (req, res, next) => {
    try {
      assertAuthenticated(req);
      assertBoard(req);

      const payload = await parseUploadPayload(req);
      const validation = await service.validateOnly({
        locale: payload.locale,
        catalog: payload.catalog,
        strict: payload.strict,
      });

      if (!validation.valid) {
        return res.status(400).json({
          error: "CATALOG_VALIDATION_FAILED",
          message: `Catalog validation failed with ${validation.errors.length} error(s)`,
          targetLocale: payload.locale,
          baseLocale: validation.baseLocale,
          report: validation.report,
          errors: validation.errors,
          warnings: validation.warnings,
        });
      }

      res.status(200).json({
        valid: true,
        targetLocale: payload.locale,
        baseLocale: validation.baseLocale,
        report: validation.report,
        errors: [],
        warnings: validation.warnings,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/myrmidon/locales/upload", handleFileUpload, handleUpload);
  router.post("/myrmidon/locale-upload", handleFileUpload, handleUpload);

  router.get("/myrmidon/locales/custom", async (req, res, next) => {
    try {
      assertAuthenticated(req);
      const locales = await service.listCustomLocales();
      res.status(200).json({
        locales,
        total: locales.length,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/myrmidon/locales/custom/:locale", async (req, res, next) => {
    try {
      assertAuthenticated(req);
      const locale = req.params.locale;
      const custom = await service.getCustomLocale(locale);
      if (!custom) {
        throw notFound(`Custom locale "${locale}" not found`);
      }
      res.status(200).json(custom);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/myrmidon/locales/custom/:locale", async (req, res, next) => {
    try {
      assertAuthenticated(req);
      assertBoard(req);
      const locale = req.params.locale;
      const deleted = await service.deleteCustomLocale(locale);
      if (!deleted) {
        throw notFound(`Custom locale "${locale}" not found`);
      }
      res.status(200).json({ deleted: true, locale });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// myrmidon(1.7 LOCALE-UPLOAD / OPE-12117): Express router for /api/locale
//
// Endpoints:
// - POST /api/locale/upload: accepts multipart/form-data or application/json,
//   validates ru/en JSON dictionary, saves as new version, returns stored metadata.
// - GET /api/locale/current: returns the active locale dictionary and metadata.
// - Invalid JSON or invalid payload -> 400.
import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import type { Db } from "@myrmidon/db";
import { badRequest, notFound } from "../../errors.js";
import { assertAuthenticated, assertBoard } from "../../routes/authz.js";
import { parseCatalogJson } from "../../myrmidon/locale-upload/validator.js";
import {
  createLocaleModuleService,
  UPLOAD_ALLOWED_LOCALES,
  type LocaleModuleService,
  type LocaleModuleServiceOptions,
  type UploadAllowedLocale,
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

export function localeModuleRoutes(
  db: Db = {} as Db,
  options?: LocaleModuleServiceOptions & { service?: LocaleModuleService },
): Router {
  const router = Router();
  const service = options?.service ?? createLocaleModuleService(db, options);

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
        throw badRequest("INVALID_CATALOG_JSON", {
          message: parseResult.error || "Failed to parse JSON file",
          errors: [{ path: "<root>", code: "PARSE_ERROR", message: parseResult.error || "Failed to parse JSON file" }],
        });
      }
      rawCatalog = parseResult.catalog;

      const originalName = file.originalname || "";
      const match = originalName.match(/^([a-zA-Z0-9_-]+)\.json$/i);
      if (match && match[1]) {
        detectedLocale = match[1].toLowerCase();
      }
    }

    const localeParam = (
      (body.locale as string) ||
      (query.locale as string) ||
      detectedLocale ||
      ""
    ).trim().toLowerCase();

    if (!localeParam) {
      throw badRequest("INVALID_LOCALE", {
        message: "Field 'locale' is required (ru or en)",
      });
    }

    if (!UPLOAD_ALLOWED_LOCALES.includes(localeParam as UploadAllowedLocale)) {
      throw badRequest("INVALID_LOCALE", {
        message: `Field 'locale' must be one of: ${UPLOAD_ALLOWED_LOCALES.join(", ")} (received: "${localeParam}")`,
      });
    }

    if (!rawCatalog) {
      if (body.catalog && typeof body.catalog === "object" && !Array.isArray(body.catalog)) {
        rawCatalog = body.catalog as Record<string, unknown>;
      } else if (body.content && typeof body.content === "string") {
        const parsed = parseCatalogJson(body.content);
        if (parsed.error || !parsed.catalog) {
          throw badRequest("INVALID_CATALOG_JSON", {
            message: parsed.error || "Invalid JSON in content field",
            errors: [{ path: "<root>", code: "PARSE_ERROR", message: parsed.error || "Invalid JSON in content field" }],
          });
        }
        rawCatalog = parsed.catalog;
      } else if (typeof body === "object" && !Array.isArray(body) && !body.catalog && Object.keys(body).length > 0 && !body.locale) {
        rawCatalog = body;
      }
    }

    if (!rawCatalog) {
      throw badRequest("INVALID_CATALOG_JSON", {
        message: "Catalog must be provided as a valid JSON file upload, JSON object ('catalog'), or raw string ('content')",
      });
    }

    if (typeof rawCatalog !== "object" || Array.isArray(rawCatalog) || Object.keys(rawCatalog).length === 0) {
      throw badRequest("INVALID_CATALOG_JSON", {
        message: "Catalog dictionary cannot be empty",
      });
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

  // POST /api/locale/upload (multipart/json)
  router.post("/locale/upload", handleFileUpload, async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertAuthenticated(req);
      assertBoard(req);

      const payload = await parseUploadPayload(req);
      const uploadedBy = req.actor?.userId ?? null;

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
  });

  // GET /api/locale/current
  router.get("/locale/current", async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertAuthenticated(req);
      const preferredLocale = typeof req.query.locale === "string" ? req.query.locale : undefined;
      const current = await service.getCurrentLocale(preferredLocale);
      if (!current) {
        throw notFound("No current locale available");
      }
      res.status(200).json(current);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

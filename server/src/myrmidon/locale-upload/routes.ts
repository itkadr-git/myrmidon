import { Router, type Request, type Response, type NextFunction } from \"express\";
import multer from \"multer\";
import type { Db } from \"@myrmidon/db\";
import { badRequest, notFound } from \"../../errors.js\";
import { assertAuthenticated, assertBoard } from \"../../routes/authz.js\";
import { parseCatalogJson } from \"./validator.js\";
import {
  createLocaleUploadService,
  type LocaleUploadService,
} from \"./service.js\";

const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },
});

function handleFileUpload(req: Request, res: Response, next: NextFunction) {
  const contentType = req.headers[\"content-type\"] || \"\";
  if (contentType.includes(\"multipart/form-data\")) {
    multerUpload.fields([
      { name: \"file\", maxCount: 1 },
      { name: \"catalog\", maxCount: 1 },
    ])(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        return next(badRequest(`Upload error: ${err.message}`));
      }
      if (err) {
        return next(err);
      }
      next();
    });
  } else {
    next();
  }
}

interface ParsedUploadInput {
  locale: string;
  catalog: Record<string, unknown>;
  dryRun?: boolean;
  strict?: boolean;
}

function extractUploadInput(req: Request): ParsedUploadInput {
  const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
  const file = files?.file?.[0] || files?.catalog?.[0] || req.file;

  let catalog: Record<string, unknown> | null = null;
  let detectedLocale = \"\";

  if (file) {
    const parseResult = parseCatalogJson(file.buffer);
    if (parseResult.error || !parseResult.catalog) {
      throw badRequest(parseResult.error || \"Failed to parse JSON file\");
    }
    catalog = parseResult.catalog;

    const originalName = file.originalname || \"\";
    const match = originalName.match(/^([a-zA-Z0-9_-]+)\.json$/i);
    if (match) {
      detectedLocale = match[1].toLowerCase();
    }
  }

  const body = req.body || {};
  const query = req.query || {};

  const locale = (
    body.locale ||
    query.locale ||
    detectedLocale
  )?.toString().trim();

  if (!locale) {
    throw badRequest(\"Locale identifier is required (e.g. 'fr', 'de', 'custom-1')\");
  }

  if (!/^[a-zA-Z0-9_-]{2,35}$/.test(locale)) {
    throw badRequest(\"Invalid locale identifier format: must be 2-35 alphanumeric chars, dashes or underscores\");
  }

  if (!catalog) {
    if (body.catalog && typeof body.catalog === \"object\" && !Array.isArray(body.catalog)) {
      catalog = body.catalog;
    } else if (body.content && typeof body.content === \"string\") {
      const parsed = parseCatalogJson(body.content);
      if (parsed.error || !parsed.catalog) {
        throw badRequest(parsed.error || \"Invalid JSON in content field\");
      }
      catalog = parsed.catalog;
    } else if (typeof body === \"object\" && !Array.isArray(body) && !body.catalog && Object.keys(body).length > 0 && !body.locale) {
      catalog = body;
    }
  }

  if (!catalog) {
    throw badRequest(\"Missing localization catalog data. Send a JSON file or catalog object in request body\");
  }

  const dryRun =
    body.dryRun === true ||
    body.dryRun === \"true\" ||
    query.dryRun === \"true\" ||
    query.dryRun === \"1\";

  const strict =
    body.strict === true ||
    body.strict === \"true\" ||
    query.strict === \"true\" ||
    query.strict === \"1\";

  return {
    locale,
    catalog,
    dryRun,
    strict,
  };
}

export function localeUploadRoutes(
  db: Db,
  serviceOverride?: LocaleUploadService,
): Router {
  const router = Router();
  const service = serviceOverride ?? createLocaleUploadService(db);

  // POST /myrmidon/locales/validate - pre-upload validation without saving
  router.post(\"/myrmidon/locales/validate\", handleFileUpload, async (req, res, next) => {
    try {
      assertBoard(req);
      const input = extractUploadInput(req);
      const validation = service.validate(input.catalog, {
        targetLocale: input.locale,
        strict: input.strict,
      });

      return res.status(200).json({
        success: validation.valid,
        valid: validation.valid,
        targetLocale: validation.targetLocale,
        baseLocale: validation.baseLocale,
        report: validation.report,
        errors: validation.errors,
        warnings: validation.warnings,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /myrmidon/locales/upload (and alias /myrmidon/locale-upload)
  const handleUpload = async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertBoard(req);
      const input = extractUploadInput(req);
      const actorId = req.actor?.userId || null;

      const uploadResult = await service.upload({
        locale: input.locale,
        catalog: input.catalog,
        actorId,
        dryRun: input.dryRun,
        strict: input.strict,
      });

      return res.status(200).json({
        success: uploadResult.valid,
        valid: uploadResult.valid,
        targetLocale: uploadResult.result.targetLocale,
        baseLocale: uploadResult.result.baseLocale,
        report: uploadResult.result.report,
        errors: uploadResult.result.errors,
        warnings: uploadResult.result.warnings,
        stored: uploadResult.stored,
      });
    } catch (err) {
      next(err);
    }
  };

  router.post(\"/myrmidon/locales/upload\", handleFileUpload, handleUpload);
  router.post(\"/myrmidon/locale-upload\", handleFileUpload, handleUpload);

  // GET /myrmidon/locales/custom - list custom uploaded locales
  router.get(\"/myrmidon/locales/custom\", async (req, res, next) => {
    try {
      assertAuthenticated(req);
      const customLocales = await service.listCustomLocales();
      return res.status(200).json({ customLocales });
    } catch (err) {
      next(err);
    }
  });

  // GET /myrmidon/locales/custom/:locale - get specific custom locale
  router.get(\"/myrmidon/locales/custom/:locale\", async (req, res, next) => {
    try {
      assertAuthenticated(req);
      const locale = req.params.locale;
      const customLocale = await service.getCustomLocale(locale);
      if (!customLocale) {
        throw notFound(`Custom locale '${locale}' not found`);
      }
      return res.status(200).json({ customLocale });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /myrmidon/locales/custom/:locale - delete custom locale
  router.delete(\"/myrmidon/locales/custom/:locale\", async (req, res, next) => {
    try {
      assertBoard(req);
      const locale = req.params.locale;
      const deleted = await service.deleteCustomLocale(locale);
      if (!deleted) {
        throw notFound(`Custom locale '${locale}' not found`);
      }
      return res.status(200).json({ success: true, deleted: locale });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// myrmidon(1.7 LOCALE-UPLOAD, OPE-10187): routes for localization catalog structure linting and validation.
import { Router, type Request, type Response, type NextFunction } from \"express\";
import multer from \"multer\";
import type { Db } from \"@myrmidon/db\";
import {
  parseCatalogJson,
  type LocaleValidationResult,
} from \"@myrmidon/shared\";
import { validateUploadedCatalog } from \"./validator.js\";

const MAX_CATALOG_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CATALOG_FILE_BYTES, files: 1 },
});

function requireBoardUser(req: Request, res: Response): boolean {
  if (req.actor.type !== \"board\") {
    res.status(403).json({ error: \"Board access required\" });
    return false;
  }
  return true;
}

function handleUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  const contentType = req.headers[\"content-type\"] || \"\";
  if (contentType.includes(\"multipart/form-data\")) {
    upload.fields([{ name: \"file\", maxCount: 1 }, { name: \"catalog\", maxCount: 1 }])(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === \"LIMIT_FILE_SIZE\") {
          return res.status(400).json({
            error: \"FILE_TOO_LARGE\",
            message: `Catalog file exceeds maximum size limit of ${MAX_CATALOG_FILE_BYTES} bytes`,
            errors: [
              {
                path: \"<root>\",
                code: \"PARSE_ERROR\",
                message: `Catalog file exceeds maximum size limit of ${MAX_CATALOG_FILE_BYTES} bytes`,
              },
            ],
          });
        }
        return res.status(400).json({
          error: \"UPLOAD_ERROR\",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      next();
    });
  } else {
    next();
  }
}

export function localeUploadRoutes(_db?: Db) {
  const router = Router();

  const handleValidate = async (req: Request, res: Response) => {
    if (!requireBoardUser(req, res)) return;

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const uploadedFile = files?.file?.[0] || files?.catalog?.[0];

    const body = req.body || {};
    const locale = (uploadedFile ? body.locale : (body.locale || req.query.locale)) as string | undefined;

    if (!locale || typeof locale !== \"string\" || locale.trim() === \"\") {
      return res.status(400).json({
        error: \"MISSING_LOCALE\",
        message: \"Field 'locale' is required (e.g. 'ru', 'de', 'custom')\",
      });
    }

    const strict = body.strict === true || body.strict === \"true\" || req.query.strict === \"true\";

    let candidateObject: unknown = null;

    if (uploadedFile) {
      const parsed = parseCatalogJson(uploadedFile.buffer, MAX_CATALOG_FILE_BYTES);
      if (parsed.error || !parsed.catalog) {
        return res.status(400).json({
          error: \"INVALID_CATALOG_JSON\",
          message: parsed.error || \"Failed to parse catalog JSON\",
          errors: [
            {
              path: \"<root>\",
              code: \"PARSE_ERROR\",
              message: parsed.error || \"Failed to parse catalog JSON\",
            },
          ],
        });
      }
      candidateObject = parsed.catalog;
    } else if (typeof body.content === \"string\") {
      const parsed = parseCatalogJson(body.content, MAX_CATALOG_FILE_BYTES);
      if (parsed.error || !parsed.catalog) {
        return res.status(400).json({
          error: \"INVALID_CATALOG_JSON\",
          message: parsed.error || \"Failed to parse catalog JSON\",
          errors: [
            {
              path: \"<root>\",
              code: \"PARSE_ERROR\",
              message: parsed.error || \"Failed to parse catalog JSON\",
            },
          ],
        });
      }
      candidateObject = parsed.catalog;
    } else if (body.catalog && typeof body.catalog === \"object\") {
      candidateObject = body.catalog;
    } else {
      return res.status(400).json({
        error: \"MISSING_CATALOG\",
        message: \"Catalog must be provided as a multipart file upload, JSON object ('catalog'), or raw string ('content')\",
      });
    }

    const validation: LocaleValidationResult = validateUploadedCatalog(candidateObject, {
      targetLocale: locale.trim(),
      strict,
    });

    if (!validation.valid) {
      return res.status(400).json({
        error: \"CATALOG_VALIDATION_FAILED\",
        message: `Catalog validation failed with ${validation.errors.length} error(s)`,
        targetLocale: validation.targetLocale,
        baseLocale: validation.baseLocale,
        report: validation.report,
        errors: validation.errors,
        warnings: validation.warnings,
      });
    }

    return res.status(200).json({
      valid: true,
      targetLocale: validation.targetLocale,
      baseLocale: validation.baseLocale,
      report: validation.report,
      errors: [],
      warnings: validation.warnings,
    });
  };

  router.post(\"/myrmidon/locales/validate\", handleUploadMiddleware, handleValidate);
  router.post(\"/myrmidon/locale-upload/validate\", handleUploadMiddleware, handleValidate);

  return router;
}

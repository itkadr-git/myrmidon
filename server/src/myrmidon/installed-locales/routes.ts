// myrmidon(1.7 LOCALE-UPLOAD): Routes for installed locales and coverage percent.
import { Router } from "express";
import type { Db } from "@myrmidon/db";
import { installedLocalesQuerySchema } from "@myrmidon/shared";
import { badRequest, notFound } from "../../errors.js";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { InstalledLocalesService } from "./service.js";

const LOCALE_SLUG_REGEX = /^[a-zA-Z0-9_-]{2,35}$/;

export function myrmidonInstalledLocalesRoutes(db?: Db, customService?: InstalledLocalesService) {
  const router = Router();
  const service = customService ?? new InstalledLocalesService(db);

  // List all installed locales (built-in and custom) with coverage percentage
  const listHandler = async (req: any, res: any, next: any) => {
    try {
      assertBoardOrgAccess(req);
      const parsedQuery = installedLocalesQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        throw badRequest("Invalid query parameters", parsedQuery.error.issues);
      }
      const result = await service.listInstalledLocales(parsedQuery.data);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  router.get("/myrmidon/locales", listHandler);
  router.get("/myrmidon/locales/installed", listHandler);

  // Detailed coverage report for a specific locale
  const detailHandler = async (req: any, res: any, next: any) => {
    try {
      assertBoardOrgAccess(req);
      const { locale } = req.params;
      if (!LOCALE_SLUG_REGEX.test(locale)) {
        throw badRequest(`Invalid locale identifier: "${locale}". Expected 2-35 alphanumeric characters, dashes or underscores.`);
      }
      const report = await service.getLocaleCoverage(locale);
      if (!report) {
        throw notFound(`Locale "${locale}" is not installed`);
      }
      res.json(report);
    } catch (err) {
      next(err);
    }
  };

  router.get("/myrmidon/locales/:locale/coverage", detailHandler);
  router.get("/myrmidon/locales/:locale", detailHandler);

  return router;
}

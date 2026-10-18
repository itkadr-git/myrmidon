// server/src/myrmidon/corpus/routes.ts
//
// myrmidon(1.6.6 CORPUS-2.0 ч.C): the HTTP surface of the corpus module, mounted
// on the board API by ./index.ts. Paths follow the vendor convention for a
// company-scoped resource: `/myrmidon/companies/:companyId/corpus/…` (the router
// itself is mounted under `/api`), while the module settings hang off
// `/myrmidon/corpus/settings` — they are instance-wide, like the run limits.
//
// Guards (server/src/routes/authz.ts):
//   * settings GET   — any board request;
//   * settings PATCH — `assertInstanceAdmin`;
//   * every data route — `assertCompanyAccess`, so a member of another company
//     reads 403 before the module is even consulted.
//
// While the module is off the data routes answer 503 `corpus_disabled` and the
// settings route still answers — the settings page must be able to switch the
// module on. `CorpusRequestError` carries the status and the machine token; any
// other error keeps the vendor 500 path.

import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import {
  corpusSearchBodySchema,
  createCorpusDatasetSchema,
  patchCorpusSettingsSchema,
  updateCorpusDatasetSchema,
  type CorpusSettingsPatch,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import {
  assertBoardOrgAccess,
  assertCompanyAccess,
  assertInstanceAdmin,
  getActorInfo,
} from "../../routes/authz.js";
import {
  CORPUS_NOT_CONFIGURED_ERROR,
  CorpusRequestError,
  corpusService,
  type CorpusActor,
  type CorpusService,
  type CorpusServiceDeps,
  type CorpusSettingsView,
} from "./service.js";
import type { CorpusPortsResolver } from "./ports.js";

export interface CorpusRoutesDeps {
  /** How this process reaches the corpus ports (parts A/B); `null` = not wired. */
  ports: CorpusPortsResolver;
  env?: Record<string, string | undefined>;
  /**
   * Seam for tests and for a host that already holds a service: extra
   * `CorpusServiceDeps`. Production mounts pass only the ports (and read the
   * settings and the audit log through the database defaults), so a route test
   * can drive the whole HTTP surface — 503/403/404/413/409 — without a live
   * Postgres.
   */
  serviceDeps?: Partial<CorpusServiceDeps>;
}

/** Multipart upload of one document; the field name is the vendor one, `file`. */
function singleFileUpload(req: Request, res: Response, maxBytes: number): Promise<void> {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
  }).single("file");
  return new Promise<void>((resolve, reject) => {
    upload(req, res, (err: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function uploadedFile(req: Request): { originalname: string; mimetype: string; buffer: Buffer } | undefined {
  return (req as Request & { file?: { originalname: string; mimetype: string; buffer: Buffer } }).file;
}

/** `?limit=20` → 20; anything else (absent, empty, non-numeric) → undefined. */
function readIntQuery(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function handle(
  run: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    try {
      await run(req, res);
    } catch (err) {
      if (err instanceof CorpusRequestError) {
        res.status(err.status).json({ error: err.code, message: err.message, ...err.details });
        return;
      }
      next(err);
    }
  };
}

/** Same gate as the service, asked before a multipart body is buffered. */
function assertModuleUsable(view: CorpusSettingsView): void {
  if (!view.enabled) {
    throw new CorpusRequestError(503, "corpus_disabled", "the corpus module is disabled", {
      enabled: false,
    });
  }
  if (!view.available) {
    throw new CorpusRequestError(
      503,
      CORPUS_NOT_CONFIGURED_ERROR,
      "the corpus module is enabled but its ports are not wired in this process",
      { enabled: true },
    );
  }
}

export function myrmidonCorpusRoutes(db: Db, deps: CorpusRoutesDeps) {
  const router = Router();
  const service: CorpusService = corpusService(db, { ...deps.serviceDeps, ports: deps.ports, env: deps.env });

  const actorOf = (req: Request): CorpusActor => getActorInfo(req);

  // --- settings -------------------------------------------------------------

  router.get(
    "/myrmidon/corpus/settings",
    handle(async (req, res) => {
      assertBoardOrgAccess(req);
      const view = await service.readSettings();
      res.json(view);
    }),
  );

  router.patch(
    "/myrmidon/corpus/settings",
    validate(patchCorpusSettingsSchema),
    handle(async (req, res) => {
      assertInstanceAdmin(req);
      const view = await service.updateSettings(req.body as CorpusSettingsPatch, actorOf(req));
      res.json(view);
    }),
  );

  // --- datasets -------------------------------------------------------------

  router.get(
    "/myrmidon/companies/:companyId/corpus/datasets",
    handle(async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json({ datasets: await service.listDatasets(companyId) });
    }),
  );

  router.post(
    "/myrmidon/companies/:companyId/corpus/datasets",
    validate(createCorpusDatasetSchema),
    handle(async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const dataset = await service.createDataset(companyId, req.body, actorOf(req));
      res.status(201).json({ dataset });
    }),
  );

  router.get(
    "/myrmidon/companies/:companyId/corpus/datasets/:datasetId",
    handle(async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const dataset = await service.getDataset(companyId, req.params.datasetId as string);
      res.json({ dataset });
    }),
  );

  router.patch(
    "/myrmidon/companies/:companyId/corpus/datasets/:datasetId",
    validate(updateCorpusDatasetSchema),
    handle(async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const dataset = await service.updateDataset(
        companyId,
        req.params.datasetId as string,
        req.body,
        actorOf(req),
      );
      res.json({ dataset });
    }),
  );

  router.delete(
    "/myrmidon/companies/:companyId/corpus/datasets/:datasetId",
    handle(async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await service.deleteDataset(companyId, req.params.datasetId as string, actorOf(req));
      res.status(204).end();
    }),
  );

  // --- stats ----------------------------------------------------------------

  router.get(
    "/myrmidon/companies/:companyId/corpus/stats",
    handle(async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json({ stats: await service.stats(companyId) });
    }),
  );

  // --- documents ------------------------------------------------------------

  router.get(
    "/myrmidon/companies/:companyId/corpus/datasets/:datasetId/documents",
    handle(async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const documents = await service.listDocuments(
        companyId,
        req.params.datasetId as string,
        { limit: readIntQuery(req.query.limit), offset: readIntQuery(req.query.offset) },
      );
      res.json({ documents });
    }),
  );

  router.post(
    "/myrmidon/companies/:companyId/corpus/datasets/:datasetId/documents",
    handle(async (req, res) => {
      const companyId = req.params.companyId as string;
      const datasetId = req.params.datasetId as string;
      assertCompanyAccess(req, companyId);

      // The switch and the size limit are checked before the body is buffered:
      // a disabled module must not make the process eat a 25 MiB upload.
      const view = await service.readSettings();
      assertModuleUsable(view);

      try {
        await singleFileUpload(req, res, view.settings.maxDocumentBytes);
      } catch (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            throw new CorpusRequestError(
              413,
              "document_too_large",
              `the document exceeds maxDocumentBytes (${view.settings.maxDocumentBytes})`,
              { maxDocumentBytes: view.settings.maxDocumentBytes },
            );
          }
          throw new CorpusRequestError(400, "bad_upload", err.message);
        }
        throw err;
      }

      const file = uploadedFile(req);
      if (!file) {
        throw new CorpusRequestError(400, "missing_file", "missing the file field 'file'");
      }

      const result = await service.uploadDocument({
        companyId,
        datasetId,
        filename: file.originalname,
        mimeType: file.mimetype || null,
        bytes: file.buffer,
        actor: actorOf(req),
      });
      res.status(202).json(result);
    }),
  );

  router.get(
    "/myrmidon/companies/:companyId/corpus/documents/:documentId",
    handle(async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const document = await service.getDocument(companyId, req.params.documentId as string);
      res.json({ document });
    }),
  );

  router.delete(
    "/myrmidon/companies/:companyId/corpus/documents/:documentId",
    handle(async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await service.deleteDocument(companyId, req.params.documentId as string, actorOf(req));
      res.status(204).end();
    }),
  );

  // --- parse jobs -----------------------------------------------------------

  router.get(
    "/myrmidon/companies/:companyId/corpus/jobs/:jobId",
    handle(async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const job = await service.getJob(companyId, req.params.jobId as string);
      res.json({ job });
    }),
  );

  // --- search ---------------------------------------------------------------

  router.post(
    "/myrmidon/companies/:companyId/corpus/datasets/:datasetId/search",
    validate(corpusSearchBodySchema),
    handle(async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(await service.search(companyId, req.params.datasetId as string, req.body));
    }),
  );

  return router;
}
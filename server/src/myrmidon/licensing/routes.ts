// myrmidon(LICENSING): licensing API for the installation owner.
//
//   GET  /api/licensing/install-id    { installId, source }
//   GET  /api/licensing/status        install id + request blob + issuer flag
//   POST /api/licensing/parse-request { request } -> the request fields
//   POST /api/licensing/issue         sign a module license
//   GET  /api/licensing/issued        journal of issued licenses
//
// The same router is also mounted under /api/myrmidon/licensing (the fork
// rule for new API paths). Every route is instance-admin only. The issuer
// private key never appears in a response or a log line.

import type { KeyObject } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { badRequest, conflict, unprocessable } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertInstanceAdmin } from "../../routes/authz.js";
import { logger } from "../../middleware/logger.js";
import { readAboutBuildInfo } from "../about/build-info.js";
import { resolveInstallId } from "./install-id.js";
import {
  FEATURE_RE,
  KNOWN_MODULES,
  MAX_LICENSE_DAYS,
  MAX_WATERMARK_CHARS,
  buildLicenseRequest,
  isValidInstanceId,
  issueLicense,
  parseLicenseRequest,
  CORE_FEATURE,
} from "./license.js";
import { IssuerKeyError, appendJournal, isIssuerConfigured, loadIssuerKey, readJournal } from "./issuer.js";

const NOT_A_REQUEST =
  "This does not look like a license request. Ask the client to press 'Copy license request' again.";

const parseRequestBody = z.object({ request: z.string().max(4096) });

const issueBody = z
  .object({
    request: z.string().max(4096).optional(),
    instanceId: z.string().max(128).optional(),
    modules: z.array(z.enum(KNOWN_MODULES)).min(1).max(KNOWN_MODULES.length),
    features: z.array(z.string().regex(FEATURE_RE)).max(20).optional(),
    days: z.number().int().min(1).max(MAX_LICENSE_DAYS).nullable(),
    watermark: z.string().trim().max(MAX_WATERMARK_CHARS).nullable().optional(),
  })
  .strict();

function actorUserId(req: { actor?: unknown }): string | null {
  const actor = req.actor as { userId?: unknown } | undefined;
  return typeof actor?.userId === "string" ? actor.userId : null;
}

// Authorization runs before body validation: a non-admin gets 403, never a
// validation message.
function instanceAdminOnly(req: Request, _res: Response, next: NextFunction) {
  assertInstanceAdmin(req);
  next();
}

export interface LicensingRoutesOptions {
  env?: NodeJS.ProcessEnv;
  machineIdPaths?: readonly string[];
  now?: () => Date;
}

export function licensingRoutes(options: LicensingRoutesOptions = {}): Router {
  const router = Router();
  const env = () => options.env ?? process.env;
  const now = () => (options.now ? options.now() : new Date());
  const install = () => resolveInstallId({ env: env(), machineIdPaths: options.machineIdPaths });

  for (const prefix of ["/licensing", "/myrmidon/licensing"]) {
    router.get(`${prefix}/install-id`, instanceAdminOnly, (_req, res) => {
      res.json(install());
    });

    router.get(`${prefix}/status`, instanceAdminOnly, (req, res) => {
      const id = install();
      const modules = typeof req.query.modules === "string" && req.query.modules
        ? req.query.modules.split(",").filter((m) => (KNOWN_MODULES as readonly string[]).includes(m))
        : [...KNOWN_MODULES];
      res.json({
        ...id,
        board: readAboutBuildInfo(env()).version,
        knownModules: KNOWN_MODULES,
        issuerConfigured: isIssuerConfigured(env()),
        request: buildLicenseRequest({
          instanceId: id.installId,
          board: readAboutBuildInfo(env()).version,
          modules,
          now: now(),
        }),
      });
    });

    router.post(`${prefix}/parse-request`, instanceAdminOnly, validate(parseRequestBody), (req, res) => {
      const parsed = parseLicenseRequest(req.body.request);
      if (!parsed) throw unprocessable(NOT_A_REQUEST);
      res.json({
        instanceId: parsed.instance_id,
        board: parsed.board,
        modules: parsed.modules.filter((m) => (KNOWN_MODULES as readonly string[]).includes(m)),
        requestedAt: parsed.ts,
      });
    });

    router.post(`${prefix}/issue`, instanceAdminOnly, validate(issueBody), (req, res) => {
      const body = req.body as z.infer<typeof issueBody>;

      let instanceId: string;
      if (body.request && body.request.trim()) {
        const parsed = parseLicenseRequest(body.request);
        if (!parsed) throw unprocessable(NOT_A_REQUEST);
        instanceId = parsed.instance_id;
      } else if (body.instanceId && body.instanceId.trim()) {
        instanceId = body.instanceId.trim();
        if (!isValidInstanceId(instanceId)) throw badRequest("Invalid installation id");
      } else {
        throw badRequest("Paste a license request or enter an installation id");
      }

      let key: KeyObject;
      try {
        key = loadIssuerKey(env());
      } catch (err) {
        if (err instanceof IssuerKeyError) {
          // 409 with a stable code: the form shows a clear "not configured" state.
          throw conflict("License issuer key is not configured on the server", { code: `issuer_key_${err.code}` });
        }
        throw err;
      }

      const features = [...new Set([CORE_FEATURE, ...(body.features ?? [])])];
      const issuedAt = now();
      const expires = body.days === null ? null : Math.floor(issuedAt.getTime() / 1000) + body.days * 86400;
      const watermark = body.watermark && body.watermark.length > 0 ? body.watermark : null;
      const { license, payload } = issueLicense(key, {
        instanceId,
        modules: body.modules,
        features,
        expires,
        watermark,
      });
      const record = appendJournal(
        {
          issuedBy: actorUserId(req),
          instanceId,
          modules: payload.modules,
          features: payload.features,
          expires,
          watermark,
        },
        env(),
        issuedAt,
      );
      // Metadata only: never the license text, never key material.
      logger.info(
        { licenseId: record.id, instanceId, modules: payload.modules, expires },
        "module license issued",
      );
      res.status(201).json({ license, payload, id: record.id });
    });

    router.get(`${prefix}/issued`, instanceAdminOnly, (_req, res) => {
      res.json(readJournal(env()));
    });
  }

  return router;
}

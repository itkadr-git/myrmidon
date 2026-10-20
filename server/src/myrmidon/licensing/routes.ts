// myrmidon(LICENSING): licensing API for the installation owner.
//
//   GET  /api/licensing/install-id    { installId, source }
//   GET  /api/licensing/status        install id + request blob + license state per closed module
//   POST /api/licensing/license       { value } save a license where the modules read it
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
  verifyLicense,
  CORE_FEATURE,
  type TrustedIssuerKey,
  type VerifyReason,
} from "./license.js";
import { IssuerKeyError, appendJournal, isIssuerConfigured, loadIssuerKey, readJournal } from "./issuer.js";
import {
  LICENSE_ENV,
  MAX_LICENSE_CHARS,
  hostShare,
  licenseFilePath,
  moduleStatuses,
  needsAttention,
  readCandidateLicense,
  writeLicenseFile,
  type HostShareOptions,
} from "./client-license.js";
import { TRUSTED_ISSUER_KEYS } from "./trusted-keys.js";

const NOT_A_REQUEST =
  "This does not look like a license request. Ask the client to press 'Copy license request' again.";

const parseRequestBody = z.object({ request: z.string().max(4096) });

// `value`, not `license`: the request logger redacts `value` in 4xx lines, so
// a refused license never reaches a log.
const saveLicenseBody = z.object({ value: z.string().min(1).max(MAX_LICENSE_CHARS) }).strict();

const SAVE_REFUSALS: Partial<Record<VerifyReason, string>> = {
  bad_format: "This is not a license: expected one line starting with MYR1.",
  bad_payload: "The license content is damaged.",
  bad_signature: "The license signature is invalid: the text was changed or it was not issued by the vendor.",
  unsupported_rev: "This license format is not supported by this board version.",
  instance_mismatch: "This license was issued for another installation (the installation id does not match).",
  expired: "This license has already expired.",
  feature_not_granted: "This license does not allow any module to start.",
};

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
  /** Closed modules installed into this board (see installed-modules.ts). */
  installedModules?: () => Promise<string[]>;
  /** Test seam: trust anchors; production always uses TRUSTED_ISSUER_KEYS. */
  trustedKeys?: readonly TrustedIssuerKey[];
  /** Test seam for the "is the license file shared with the host" probe. */
  hostShare?: HostShareOptions;
}

export function licensingRoutes(options: LicensingRoutesOptions = {}): Router {
  const router = Router();
  const env = () => options.env ?? process.env;
  const now = () => (options.now ? options.now() : new Date());
  const install = () => resolveInstallId({ env: env(), machineIdPaths: options.machineIdPaths });
  const trustedKeys = options.trustedKeys ?? TRUSTED_ISSUER_KEYS;
  const installed = async () => {
    if (!options.installedModules) return [] as string[];
    try {
      return (await options.installedModules()).filter((m) => (KNOWN_MODULES as readonly string[]).includes(m));
    } catch (err) {
      logger.warn({ err }, "licensing: cannot list installed closed modules");
      return [] as string[];
    }
  };

  async function clientState(requested: string[] | null) {
    const id = install();
    const board = readAboutBuildInfo(env()).version;
    const installedModules = await installed();
    const requestModules =
      requested && requested.length > 0
        ? requested
        : installedModules.length > 0
          ? installedModules
          : [...KNOWN_MODULES];
    const license = readCandidateLicense(env());
    const nowSeconds = Math.floor(now().getTime() / 1000);
    const modules = moduleStatuses({
      license,
      installId: id.installId,
      nowSeconds,
      trustedKeys,
      installed: installedModules,
    });
    const file = licenseFilePath(env());
    return {
      ...id,
      board,
      knownModules: KNOWN_MODULES,
      installedModules,
      issuerConfigured: isIssuerConfigured(env()),
      request: buildLicenseRequest({ instanceId: id.installId, board, modules: requestModules, now: now() }),
      license: {
        source: license.source,
        path: file,
        envOverride: license.source === "env",
        share: hostShare(file, options.hostShare),
      },
      modules,
      attention: needsAttention(modules),
    };
  }

  for (const prefix of ["/licensing", "/myrmidon/licensing"]) {
    router.get(`${prefix}/install-id`, instanceAdminOnly, (_req, res) => {
      res.json(install());
    });

    router.get(`${prefix}/status`, instanceAdminOnly, async (req, res, next) => {
      try {
        const requested =
          typeof req.query.modules === "string" && req.query.modules
            ? req.query.modules.split(",").filter((m) => (KNOWN_MODULES as readonly string[]).includes(m))
            : null;
        res.json(await clientState(requested));
      } catch (err) {
        next(err);
      }
    });

    router.post(`${prefix}/license`, instanceAdminOnly, validate(saveLicenseBody), async (req, res, next) => {
      try {
        const text = (req.body as z.infer<typeof saveLicenseBody>).value.trim();
        if ((env()[LICENSE_ENV] ?? "").trim()) {
          throw conflict("The license is set by the MYR_LICENSE variable; a saved file would not be used", {
            code: "license_env_override",
          });
        }
        const id = install();
        const nowSeconds = Math.floor(now().getTime() / 1000);
        const result = verifyLicense(text, id.installId, nowSeconds, trustedKeys);
        if (!result.valid) {
          const message = SAVE_REFUSALS[result.reason] ?? "The license is not valid.";
          throw unprocessable(message, { code: `license_${result.reason}` });
        }
        const file = licenseFilePath(env());
        try {
          writeLicenseFile(file, text);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? "unknown";
          logger.warn({ path: file, code }, "licensing: cannot write the license file");
          throw conflict(`Cannot write the license file ${file} (${code})`, {
            code: "license_path_unwritable",
            path: file,
            errno: code,
          });
        }
        // Metadata only: never the license text.
        logger.info(
          {
            path: file,
            instanceId: id.installId,
            modules: result.payload?.modules,
            expires: result.payload?.expires ?? null,
            kid: result.kid ?? null,
          },
          "module license saved",
        );
        res.json(await clientState(null));
      } catch (err) {
        next(err);
      }
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

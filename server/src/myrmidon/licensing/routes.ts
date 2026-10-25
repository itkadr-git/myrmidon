// myrmidon(LICENSING): client licensing API of the installation.
//
//   GET  /api/licensing/install-id    { installId, source }
//   GET  /api/licensing/status        install id + request blob + license state per closed module
//   POST /api/licensing/license       { value } save a license where the modules read it
//
// The same router is also mounted under /api/myrmidon/licensing (the fork
// rule for new API paths). Every route is instance-admin only. The board only
// VERIFIES licenses with public keys; issuing is the vendor's closed module
// and has no code path here.

import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { conflict, unprocessable } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertInstanceAdmin } from "../../routes/authz.js";
import { logger } from "../../middleware/logger.js";
import { readAboutBuildInfo } from "../about/build-info.js";
import type { InstallIdProvider } from "./install-id.js";
import {
  KNOWN_MODULES,
  buildLicenseRequest,
  verifyLicense,
  type TrustedIssuerKey,
  type VerifyReason,
} from "./license.js";
import {
  LICENSE_ENV,
  MAX_LICENSE_CHARS,
  hostShare,
  instanceMismatchMessage,
  licenseFilePath,
  moduleStatuses,
  needsAttention,
  readCandidateLicense,
  writeLicenseFile,
  type HostShareOptions,
} from "./client-license.js";
import { createDenyListReader } from "./denylist.js";
import { TRUSTED_ISSUER_KEYS } from "./trusted-keys.js";

// `value`, not `license`: the request logger redacts `value` in 4xx lines, so
// a refused license never reaches a log.
const saveLicenseBody = z.object({ value: z.string().min(1).max(MAX_LICENSE_CHARS) }).strict();

const SAVE_REFUSALS: Partial<Record<VerifyReason, string>> = {
  bad_format: "This is not a license: expected one line starting with MYR1.",
  bad_payload: "The license content is damaged.",
  bad_signature: "The license signature is invalid: the text was changed or it was not issued by the vendor.",
  unsupported_rev: "This license format is not supported by this board version.",
  expired: "This license has already expired.",
  feature_not_granted: "This license does not allow any module to start.",
};

// Authorization runs before body validation: a non-admin gets 403, never a
// validation message.
function instanceAdminOnly(req: Request, _res: Response, next: NextFunction) {
  assertInstanceAdmin(req);
  next();
}

export interface LicensingRoutesOptions {
  env?: NodeJS.ProcessEnv;
  /** The board's installation id (database); the only source the routes use. */
  installId: InstallIdProvider;
  now?: () => Date;
  /** Closed modules installed into this board (see installed-modules.ts). */
  installedModules?: () => Promise<string[]>;
  /** Test seam: trust anchors; production always uses TRUSTED_ISSUER_KEYS. */
  trustedKeys?: readonly TrustedIssuerKey[];
  /** Test seam for the "is the license file shared with the host" probe. */
  hostShare?: HostShareOptions;
}

export function licensingRoutes(options: LicensingRoutesOptions): Router {
  const router = Router();
  const env = () => options.env ?? process.env;
  const now = () => (options.now ? options.now() : new Date());
  const install = () => options.installId();
  const trustedKeys = options.trustedKeys ?? TRUSTED_ISSUER_KEYS;
  const denyList = createDenyListReader({
    env: () => env(),
    trustedKeys,
    warn: (message) => logger.warn(message),
  });
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
    const id = await install();
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
      denyList,
    });
    const file = licenseFilePath(env());
    return {
      ...id,
      board,
      knownModules: KNOWN_MODULES,
      installedModules,
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
    router.get(`${prefix}/install-id`, instanceAdminOnly, async (_req, res, next) => {
      try {
        res.json(await install());
      } catch (err) {
        next(err);
      }
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
        const id = await install();
        const nowSeconds = Math.floor(now().getTime() / 1000);
        const result = verifyLicense(text, id.installId, nowSeconds, trustedKeys);
        if (!result.valid) {
          if (result.reason === "instance_mismatch" && result.licenseInstanceId) {
            throw unprocessable(instanceMismatchMessage(result.licenseInstanceId, id.installId), {
              code: "license_instance_mismatch",
              licenseInstanceId: result.licenseInstanceId,
              boardInstanceId: id.installId,
            });
          }
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
  }

  return router;
}

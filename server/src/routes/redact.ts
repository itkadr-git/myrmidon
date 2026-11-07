import { Router, type Request } from "express";
import type { Db } from "@myrmidon/db";
import {
  redactConfigSchema,
  validateRedactConfigResponseSchema,
  type RedactConfig,
} from "@myrmidon/shared";
import { assertAuthenticated, assertBoardOrgAccess } from "./authz.js";

export interface RedactRoutesOptions {
  /** Static config provider. In production this may read from a store. */
  getConfig?: () => Promise<RedactConfig> | RedactConfig;
}

const DEFAULT_CONFIG: RedactConfig = redactConfigSchema.parse({
  version: "1.7.0",
  updatedAt: new Date(0).toISOString(),
  rules: [
    {
      id: "default-secrets",
      name: "Default secrets masking",
      description: "Mask API keys, tokens, and passwords",
      mode: "mask",
      maskStyle: "irreversible",
      recognizers: [
        { kind: "secret", enabled: true },
        { kind: "bank", enabled: true },
        { kind: "legal", enabled: true },
        { kind: "pii", enabled: true },
      ],
    },
  ],
});

async function getEffectiveConfig(
  options?: RedactRoutesOptions,
): Promise<RedactConfig> {
  if (options?.getConfig) {
    return await options.getConfig();
  }
  return DEFAULT_CONFIG;
}

function validateBody(
  body: unknown,
): { valid: true; config: RedactConfig } | { valid: false; errors: string[] } {
  const result = redactConfigSchema.safeParse(body);
  if (result.success) {
    return { valid: true, config: result.data };
  }
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
  return { valid: false, errors };
}

export function redactRoutes(_db: Db, options?: RedactRoutesOptions) {
  const router = Router();

  router.get("/redact/config", async (req: Request, res) => {
    assertAuthenticated(req);
    assertBoardOrgAccess(req);
    const config = await getEffectiveConfig(options);
    res.json(redactConfigSchema.parse(config));
  });

  router.post("/redact/validate", (req: Request, res) => {
    assertAuthenticated(req);
    assertBoardOrgAccess(req);

    const body = validateBody(req.body);
    if (!body.valid) {
      const response = validateRedactConfigResponseSchema.parse({
        valid: false,
        errors: body.errors,
        normalized: null,
      });
      res.status(400).json(response);
      return;
    }

    const normalized = redactConfigSchema.parse(body.config);
    const response = validateRedactConfigResponseSchema.parse({
      valid: true,
      errors: [],
      normalized,
    });
    res.json(response);
  });

  return router;
}

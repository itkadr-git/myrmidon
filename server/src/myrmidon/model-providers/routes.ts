// server/src/myrmidon/model-providers/routes.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS A): the settings API of the company model
// provider registry.
//
//   POST   /api/myrmidon/companies/:companyId/model-providers            (board only)
//   GET    /api/myrmidon/companies/:companyId/model-providers            (company access)
//   PATCH  /api/myrmidon/companies/:companyId/model-providers/:id        (board only)
//   DELETE /api/myrmidon/companies/:companyId/model-providers/:id        (board only)
//   GET    /api/myrmidon/companies/:companyId/model-providers/:id/models (company access)
//   POST   /api/myrmidon/companies/:companyId/model-providers/:id/models (board only)
//
// Reads answer the provider state and its cached model list. The credential
// key is accepted on POST (creation) and PATCH (rotation), validated against
// the live provider, stored in the secret store — and NEVER answered. No
// response body of this router contains the key value; the suite asserts it.
//
// Mutations are board-only: they mint and rotate credentials. Reads are open
// to any actor with company access (the settings screen shows which providers
// exist and which models are enabled).
//
// No database or service imports here: everything arrives through
// ModelProviderRoutesDeps, so the suite runs the real routes with fakes (the
// real wiring is wiring.ts).

import { Router, type Request } from "express";
import {
  createModelProviderSchema,
  listAvailableModelProviderTypes,
  patchModelProviderSchema,
  setModelProviderModelsSchema,
} from "@myrmidon/shared";
import { z, type ZodType } from "zod";
import { badRequest } from "../../errors.js";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import type { ModelProviderActivityEntry, ModelProviderService } from "./service.js";
import { reportPoolAccountStatus } from "./signals.js";

const reportAccountStatusSchema = z.object({
  accountNumber: z.number().int().positive(),
  label: z.string().optional(),
  state: z.string().min(1),
  plan: z.string().optional().nullable(),
  windows: z
    .object({
      primary: z
        .object({
          usedPct: z.number().nullable().optional(),
          windowMin: z.number().nullable().optional(),
          resetsAt: z.number().nullable().optional(),
        })
        .optional()
        .nullable(),
      secondary: z
        .object({
          usedPct: z.number().nullable().optional(),
          windowMin: z.number().nullable().optional(),
          resetsAt: z.number().nullable().optional(),
        })
        .optional()
        .nullable(),
    })
    .optional(),
  limitedUntil: z.number().nullable().optional(),
  isBanned: z.boolean().optional(),
  isExhausted: z.boolean().optional(),
});

export interface ModelProviderRoutesDeps {
  service: ModelProviderService;
  /** Writes the mutation into the company activity log. Optional: tests pass none. */
  recordActivity?: (entry: ModelProviderActivityEntry) => Promise<void>;
}

function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

export function modelProviderRoutes(deps: ModelProviderRoutesDeps): Router {
  const router = Router();
  const activity = (entry: ModelProviderActivityEntry) =>
    deps.recordActivity ? deps.recordActivity(entry) : Promise.resolve();

  const parse = <T>(schema: ZodType<T>, body: unknown): T => {
    const result = schema.safeParse(body);
    if (!result.success) {
      const issues = result.error?.issues ?? [];
      const first = issues[0];
      const path = first?.path?.length ? `${first.path.join(".")}: ` : "";
      throw badRequest(`${path}${first?.message ?? "invalid request body"}`);
    }
    return result.data;
  };

  router.post("/myrmidon/companies/:companyId/model-providers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = parse(createModelProviderSchema, bodyOf(req));
    const provider = await deps.service.createProvider({
      companyId,
      body,
      activity: (entry) => activity(entry),
    });
    res.status(201).json(provider);
  });

  router.get("/myrmidon/companies/:companyId/model-providers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({
      providers: await deps.service.listProviders(companyId),
      availableTypes: deps.service.listAvailableTypes ? deps.service.listAvailableTypes() : listAvailableModelProviderTypes(),
    });
  });

  router.patch("/myrmidon/companies/:companyId/model-providers/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const providerId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = parse(patchModelProviderSchema, bodyOf(req));
    if (body.key !== undefined) {
      const view = await deps.service.rotateProviderKey({
        companyId,
        providerId,
        key: body.key,
        activity: (entry) => activity(entry),
      });
      res.json(view);
      return;
    }
    const view = await deps.service.patchProvider({
      companyId,
      providerId,
      body,
      activity: (entry) => activity(entry),
    });
    res.json(view);
  });

  router.delete("/myrmidon/companies/:companyId/model-providers/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const providerId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    await deps.service.removeProvider({
      companyId,
      providerId,
      activity: (entry) => activity(entry),
    });
    res.status(204).send();
  });

  router.get("/myrmidon/companies/:companyId/model-providers/:id/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    const providerId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    res.json({ models: await deps.service.listModels(companyId, providerId) });
  });

  router.post("/myrmidon/companies/:companyId/model-providers/:id/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    const providerId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = parse(setModelProviderModelsSchema, bodyOf(req));
    const models = await deps.service.setModels({
      companyId,
      providerId,
      models: body.models,
    });
    res.json({ models });
  });

  router.get("/myrmidon/companies/:companyId/model-providers/:id/channels", async (req, res) => {
    const companyId = req.params.companyId as string;
    const providerId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    const result = await deps.service.listChannels(companyId, providerId);
    res.json(result);
  });

  router.post("/myrmidon/companies/:companyId/model-providers/:id/account-status", async (req, res) => {
    const companyId = req.params.companyId as string;
    const providerId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = parse(reportAccountStatusSchema, bodyOf(req));
    const signal = reportPoolAccountStatus({
      companyId,
      providerId,
      account: {
        n: body.accountNumber,
        label: body.label || `Account #${body.accountNumber}`,
        state: body.state,
        plan: body.plan ?? null,
        windows: {
          primary: body.windows?.primary
            ? {
                usedPct: body.windows.primary.usedPct ?? null,
                windowMin: body.windows.primary.windowMin ?? null,
                resetsAt: body.windows.primary.resetsAt ?? null,
              }
            : null,
          secondary: body.windows?.secondary
            ? {
                usedPct: body.windows.secondary.usedPct ?? null,
                windowMin: body.windows.secondary.windowMin ?? null,
                resetsAt: body.windows.secondary.resetsAt ?? null,
              }
            : null,
        },
        limitedUntil: body.limitedUntil ?? null,
        lastOk: null,
        isBanned: body.isBanned ?? (body.state === "banned" || body.state === "token_expired"),
        isExhausted:
          body.isExhausted ??
          (body.state === "rate_limited" ||
            (body.windows?.primary?.usedPct !== undefined &&
              body.windows.primary.usedPct !== null &&
              body.windows.primary.usedPct >= 100) ||
            (body.windows?.secondary?.usedPct !== undefined &&
              body.windows.secondary.usedPct !== null &&
              body.windows.secondary.usedPct >= 100)),
      },
    });
    res.json({ ok: true, signal });
  });

  return router;
}

// server/src/myrmidon/container-scope/routes.ts
//
// myrmidon(CONTAINER-SCOPE): the API of the container axis.
//
//   GET    /api/myrmidon/companies/:companyId/container-scope
//   PUT    /api/myrmidon/companies/:companyId/container-scope/instances
//   DELETE /api/myrmidon/companies/:companyId/container-scope/instances/:kind/:scopeId
//   POST   /api/myrmidon/companies/:companyId/container-scope/recompute
//   POST   /api/myrmidon/companies/:companyId/container-scope/agents/:agentId/applied
//   POST   /api/myrmidon/companies/:companyId/container-scope/agents/:agentId/actions
//
// Reads need company access, every write needs instance-admin rights — the same
// rule the disk axis follows: a container decides which agents share memory,
// processes and a network namespace. Nothing here starts or stops a bot by
// itself; `actions` only says what an operator's request does to every member of
// the container, and `applied` is what the runtime reports back.

import { Router, type Request } from "express";
import {
  containerScopeActionSchema,
  markContainerAppliedSchema,
  putContainerInstanceSchema,
  SETTABLE_SCOPE_KINDS,
  type SettableScopeKind,
} from "@paperclipai/shared";
import { badRequest, notFound, unprocessable } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, hasCompanyAccess } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import type { ContainerScopeService } from "./service.js";
import type { ContainerScopeRoutesDeps } from "./domain.js";


const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function containerScopeRoutes(deps: ContainerScopeRoutesDeps) {
  const { db, service } = deps;
  const router = Router();

  /** One audit row per mutation, written with the actor of the request. */
  async function audit(
    req: Request,
    companyId: string,
    entry: { action: string; entityType: string; entityId: string; details?: Record<string, unknown> },
  ): Promise<void> {
    const actor = req.actor;
    await logActivity(db, {
      companyId,
      actorType: actor.type === "agent" ? "agent" : "user",
      actorId: actor.type === "agent" ? actor.agentId : (actor.userId ?? "board"),
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      details: entry.details ?? null,
    });
  }

  function companyIdOf(req: Request): string {
    const companyId = req.params.companyId as string;
    if (!hasCompanyAccess(req, companyId)) throw notFound("Company not found");
    assertCompanyAccess(req, companyId);
    return companyId;
  }
  function writeCompanyIdOf(req: Request): string {
    assertBoard(req);
    assertInstanceAdmin(req);
    return companyIdOf(req);
  }
  function uuidParam(req: Request, name: string, what: string): string {
    const value = req.params[name] as string;
    if (!UUID_PATTERN.test(value)) throw notFound(`${what} not found`);
    return value;
  }
  function settingTarget(req: Request): { kind: SettableScopeKind; ref: string } {
    const kind = req.params.kind as string;
    if (!(SETTABLE_SCOPE_KINDS as readonly string[]).includes(kind)) {
      throw badRequest(`Unknown scope kind "${kind}"`, { code: "scope_kind_invalid", kinds: SETTABLE_SCOPE_KINDS });
    }
    const ref = req.params.scopeId as string;
    if (!ref) throw notFound("Scope instance not found");
    return { kind: kind as SettableScopeKind, ref };
  }

  const base = "/myrmidon/companies/:companyId/container-scope";

  router.get(base, async (req, res) => {
    assertBoard(req);
    res.json(await service.overview(companyIdOf(req)));
  });

  router.put(`${base}/instances`, validate(putContainerInstanceSchema), async (req, res) => {
    const companyId = writeCompanyIdOf(req);
    const result = await service.setInstance(companyId, req.body);
    if (!result) {
      throw unprocessable("The instance does not name anything this company can put into one container", {
        code: "container_scope_instance_invalid",
      });
    }
    await audit(req, companyId, {
      action: "myrmidon.container_scope.instance_set",
      entityType: "container_scope_instance",
      entityId: `${req.body.kind}:${req.body.ref}`,
      details: { kind: req.body.kind, ref: req.body.ref, mode: req.body.mode, restartRequired: result.restartRequired },
    });
    res.json(result);
  });

  router.delete(`${base}/instances/:kind/:scopeId`, async (req, res) => {
    const companyId = writeCompanyIdOf(req);
    const { kind, ref } = settingTarget(req);
    const removed = await service.removeInstance(companyId, kind, ref);
    if (!removed) throw notFound("Scope instance not found");
    await audit(req, companyId, {
      action: "myrmidon.container_scope.instance_removed",
      entityType: "container_scope_instance",
      entityId: `${kind}:${ref}`,
    });
    res.status(204).end();
  });

  router.post(`${base}/recompute`, async (req, res) => {
    const companyId = writeCompanyIdOf(req);
    const recomputed = await service.recompute(companyId);
    await audit(req, companyId, {
      action: "myrmidon.container_scope.recomputed",
      entityType: "company",
      entityId: companyId,
      details: { agents: recomputed.agents, restartRequired: recomputed.restartRequired },
    });
    res.json(recomputed);
  });

  router.post(`${base}/agents/:agentId/applied`, validate(markContainerAppliedSchema), async (req, res) => {
    const companyId = writeCompanyIdOf(req);
    const agentId = uuidParam(req, "agentId", "Agent");
    const applied = await service.markApplied(companyId, agentId, req.body.containerKey);
    if (!applied) throw unprocessable("The agent does not resolve to that container", { code: "container_key_invalid" });
    await audit(req, companyId, {
      action: "myrmidon.container_scope.container_applied",
      entityType: "agent",
      entityId: agentId,
      details: { containerKey: req.body.containerKey },
    });
    res.json({ agent: applied });
  });

  router.post(`${base}/agents/:agentId/actions`, validate(containerScopeActionSchema), async (req, res) => {
    const companyId = writeCompanyIdOf(req);
    const agentId = uuidParam(req, "agentId", "Agent");
    const planned = await service.actions(companyId, { agentId, kind: req.body.kind });
    if (!planned) throw notFound("Agent not found");
    res.json(planned);
  });

  return router;
}
// server/src/myrmidon/bot-containers/scope-routes.ts
//
// myrmidon(BOT-DISK-F): the API behind the "Disk isolation" page.
//
//   GET    /api/myrmidon/companies/:companyId/bot-scopes
//   POST   /api/myrmidon/companies/:companyId/bot-scopes/groups
//   PATCH  /api/myrmidon/companies/:companyId/bot-scopes/groups/:groupId
//   DELETE /api/myrmidon/companies/:companyId/bot-scopes/groups/:groupId
//   PUT    /api/myrmidon/companies/:companyId/bot-scopes/settings/:kind/:scopeId
//   DELETE /api/myrmidon/companies/:companyId/bot-scopes/settings/:kind/:scopeId
//   PUT    /api/myrmidon/companies/:companyId/bot-scopes/agents/:agentId
//   POST   /api/myrmidon/companies/:companyId/bot-scopes/agents/:agentId/apply
//   POST   /api/myrmidon/companies/:companyId/bot-scopes/apply-all
//
// Reads are open to board members of the company; every write needs the same
// access plus instance-admin rights, the rule the bot-disk settings follow: a
// scope decides which agents' disks (and so their files) share a directory.
// Nothing here restarts a bot: a write only changes what the agent resolves to,
// and `apply` is the owner's go-ahead (see scope-service.ts). No restart of the
// server is needed for any of it.

import { Router, type Request } from "express";
import {
  createScopeGroupSchema,
  patchScopeGroupSchema,
  putScopeAgentPrefSchema,
  putScopeSettingSchema,
  SETTABLE_SCOPE_KINDS,
  type SettableScopeKind,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, hasCompanyAccess } from "../../routes/authz.js";
import type { BotScopeService } from "./scope-service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function botScopeRoutes(service: BotScopeService) {
  const router = Router();

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
  const base = "/myrmidon/companies/:companyId/bot-scopes";

  router.get(base, async (req, res) => {
    assertBoard(req);
    res.json(await service.overview(companyIdOf(req)));
  });

  router.post(`${base}/groups`, validate(createScopeGroupSchema), async (req, res) => {
    const companyId = writeCompanyIdOf(req);
    res.status(201).json(await service.createGroup(companyId, req.body));
  });

  router.patch(`${base}/groups/:groupId`, validate(patchScopeGroupSchema), async (req, res) => {
    const companyId = writeCompanyIdOf(req);
    res.json(await service.patchGroup(companyId, uuidParam(req, "groupId", "Group"), req.body));
  });

  router.delete(`${base}/groups/:groupId`, async (req, res) => {
    const companyId = writeCompanyIdOf(req);
    await service.deleteGroup(companyId, uuidParam(req, "groupId", "Group"));
    res.status(204).end();
  });

  function settingTarget(req: Request): { kind: SettableScopeKind; id: string } {
    const kind = req.params.kind as string;
    if (!(SETTABLE_SCOPE_KINDS as readonly string[]).includes(kind)) {
      throw badRequest(`Unknown scope kind "${kind}"`, { code: "scope_kind_invalid", kinds: SETTABLE_SCOPE_KINDS });
    }
    return { kind: kind as SettableScopeKind, id: req.params.scopeId as string };
  }

  router.put(`${base}/settings/:kind/:scopeId`, validate(putScopeSettingSchema), async (req, res) => {
    const companyId = writeCompanyIdOf(req);
    const { kind, id } = settingTarget(req);
    res.json(await service.putSetting(companyId, kind, id, req.body.mode));
  });

  router.delete(`${base}/settings/:kind/:scopeId`, async (req, res) => {
    const companyId = writeCompanyIdOf(req);
    const { kind, id } = settingTarget(req);
    res.json(await service.deleteSetting(companyId, kind, id));
  });

  router.put(`${base}/agents/:agentId`, validate(putScopeAgentPrefSchema), async (req, res) => {
    const companyId = writeCompanyIdOf(req);
    res.json(await service.putAgentPref(companyId, uuidParam(req, "agentId", "Agent"), req.body));
  });

  router.post(`${base}/agents/:agentId/apply`, async (req, res) => {
    const companyId = writeCompanyIdOf(req);
    res.json(await service.apply(companyId, uuidParam(req, "agentId", "Agent")));
  });

  router.post(`${base}/apply-all`, async (req, res) => {
    const companyId = writeCompanyIdOf(req);
    res.json(await service.applyAll(companyId));
  });

  return router;
}

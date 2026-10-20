import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, forbidden } from "../../errors.js";
import { getActorInfo } from "../../routes/authz.js";
import { authorizePoolChatInvocation } from "./access.js";
import { validateIdempotencyKey, validateRequestBody } from "./protocol.js";
import { poolChatService, type PoolChatTransportResolver } from "./service.js";

function routeScope(req: Request) {
  const channelId = typeof req.body?.channelId === "string" ? req.body.channelId : typeof req.query.channelId === "string" ? req.query.channelId : "http";
  const subjectId = typeof req.body?.subjectId === "string" ? req.body.subjectId : typeof req.query.subjectId === "string" ? req.query.subjectId : "http";
  return { channelId, subjectId };
}

export function poolChatRoutes(db: Db, resolveTransport: PoolChatTransportResolver) {
  const service = poolChatService(db, resolveTransport);
  const router = Router();
  const authorize = async (req: Request, companyId: string, moduleId: string) => {
    const actor = getActorInfo(req);
    const scope = routeScope(req);
    if (actor.actorType === "agent" && !actor.agentApiKeyId) {
      throw forbidden("Pool-chat invocation requires a scoped service principal");
    }
    const decision = await authorizePoolChatInvocation(db, { companyId, moduleId, channelId: scope.channelId, subjectId: scope.subjectId, principalType: actor.actorType, principalId: actor.actorId });
    if (!decision.allowed) throw forbidden("Pool-chat invocation is not authorized");
    return scope;
  };
  router.get("/companies/:companyId/modules/:moduleId/chat/capabilities", async (req, res) => {
    await authorize(req, req.params.companyId, req.params.moduleId);
    res.json(await service.capabilities(req.params.companyId, req.params.moduleId));
  });
  router.post("/companies/:companyId/modules/:moduleId/chat/requests", async (req, res) => {
    const idempotencyKey = req.header("Idempotency-Key");
    if (!validateIdempotencyKey(idempotencyKey)) throw badRequest("Idempotency-Key must be 16..128 printable ASCII characters");
    const companyId = req.params.companyId;
    const moduleId = req.params.moduleId;
    const scope = await authorize(req, companyId, moduleId);
    const capabilities = await service.capabilities(companyId, moduleId);
    const parsed = validateRequestBody(req.body, new Set(capabilities.models));
    if (!parsed.valid) throw badRequest(parsed.code);
    const result = await service.submit({ companyId, moduleId, channel: scope.channelId, subjectId: scope.subjectId, idempotencyKey, body: parsed.value });
    res.status(201).json({ request: result });
  });
  router.get("/companies/:companyId/modules/:moduleId/chat/requests/:requestId", async (req, res) => {
    // Authorize against the persisted request scope, not a caller-supplied
    // default. A guessed request id must not become a cross-scope read.
    const request = await service.status(req.params.companyId, req.params.moduleId, req.params.requestId);
    const actor = getActorInfo(req);
    // Status reads use the persisted request scope, but they still require the
    // same service-principal boundary as submit/capabilities. In particular,
    // an agent JWT must not be accepted as a pool-chat invocation credential.
    if (actor.actorType === "agent" && !actor.agentApiKeyId) {
      throw forbidden("Pool-chat invocation requires a scoped service principal");
    }
    const decision = await authorizePoolChatInvocation(db, {
      companyId: req.params.companyId,
      moduleId: req.params.moduleId,
      channelId: request.channel,
      subjectId: request.subjectId,
      principalType: actor.actorType,
      principalId: actor.actorId,
    });
    if (!decision.allowed) throw forbidden("Pool-chat invocation is not authorized");
    res.json({ request });
  });
  return router;
}

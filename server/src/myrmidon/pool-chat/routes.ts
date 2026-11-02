import { Router, type Request } from "express";
import { companies, type Db } from "@myrmidon/db";
import { badRequest, forbidden, notFound } from "../../errors.js";
import { getActorInfo } from "../../routes/authz.js";
import { secretService } from "../../services/index.js";
import {
  channelSettingsService,
  type ChannelSettingsService,
} from "../channel-settings/service.js";
import { authorizePoolChatInvocation } from "./access.js";
import { validateIdempotencyKey, validateRequestBody } from "./protocol.js";
import { poolChatService, type PoolChatService, type PoolChatTransportResolver } from "./service.js";
import {
  createTelegramPoolBridge,
  resolveTelegramPoolBotToken,
  type TelegramOutboxSender,
  type TelegramPoolBridgeOptions,
  type TelegramUpdate,
} from "./telegram-bridge.js";

function routeScope(req: Request) {
  const channelId = typeof req.body?.channelId === "string" ? req.body.channelId : typeof req.query.channelId === "string" ? req.query.channelId : "http";
  const subjectId = typeof req.body?.subjectId === "string" ? req.body.subjectId : typeof req.query.subjectId === "string" ? req.query.subjectId : "http";
  return { channelId, subjectId };
}

export interface PoolChatRoutesOptions {
  service?: PoolChatService;
  channelSettingsService?: ChannelSettingsService;
  secretResolver?: (companyId: string, name: string) => Promise<string | null>;
  sender?: TelegramOutboxSender;
  env?: NodeJS.ProcessEnv;
  defaultCompanyId?: string;
}

export function poolChatRoutes(
  db: Db,
  resolveTransport: PoolChatTransportResolver,
  options?: PoolChatRoutesOptions,
) {
  const service = options?.service ?? poolChatService(db, resolveTransport);
  const router = Router();
  const settingsSvc =
    options?.channelSettingsService ??
    channelSettingsService(db, { env: options?.env });

  const defaultSecretResolver = async (companyId: string, name: string): Promise<string | null> => {
    try {
      const secrets = secretService(db);
      const secret = await secrets.getByName(companyId, name);
      if (!secret) return null;
      return await secrets.resolveSecretValue(companyId, secret.id, "latest");
    } catch {
      return null;
    }
  };
  const secretResolver = options?.secretResolver ?? defaultSecretResolver;

  const bridgeRegistry = new Map<string, ReturnType<typeof createTelegramPoolBridge>>();

  const getOrCreateBridge = (
    moduleKey: string,
    bridgeOpts: TelegramPoolBridgeOptions,
  ) => {
    let bridge = bridgeRegistry.get(moduleKey);
    if (!bridge) {
      bridge = createTelegramPoolBridge(bridgeOpts);
      bridgeRegistry.set(moduleKey, bridge);
    } else {
      const currentModules = bridge.getModules();
      Object.assign(currentModules, bridgeOpts.modules);
    }
    return bridge;
  };

  router.post("/myrmidon/pool-chat/modules/:moduleId/telegram/webhook", async (req, res) => {
    const rawModuleId = req.params.moduleId;
    let provider: "chatgpt" | "gemini" | null = null;
    let normalizedModuleId = rawModuleId;

    if (rawModuleId === "chatgpt-pool" || rawModuleId === "chatgpt") {
      provider = "chatgpt";
      normalizedModuleId = "chatgpt-pool";
    } else if (
      rawModuleId === "google-ai-pool" ||
      rawModuleId === "gemini" ||
      rawModuleId === "google-ai"
    ) {
      provider = "gemini";
      normalizedModuleId = "google-ai-pool";
    }

    if (!provider) {
      res.status(404).json({ error: "unknown_module" });
      return;
    }

    let companyId = options?.defaultCompanyId;

    if (!companyId) {
      try {
        const companyRows = await db.select({ id: companies.id }).from(companies).limit(1);
        companyId = companyRows[0]?.id;
      } catch {
        // Fallback for mocks/tests without companies table
      }
    }
    if (!companyId) {
      companyId = "default-company";
    }

    const effectiveSettings = await settingsSvc.read();
    const enabled =
      provider === "chatgpt"
        ? effectiveSettings.telegramPoolChatGptEnabled.value
        : effectiveSettings.telegramPoolGeminiEnabled.value;

    const allowedChatId =
      provider === "chatgpt"
        ? effectiveSettings.telegramPoolChatGptChatId.value
        : effectiveSettings.telegramPoolGeminiChatId.value;

    const model =
      provider === "chatgpt"
        ? effectiveSettings.telegramPoolChatGptModel.value || "balanced"
        : effectiveSettings.telegramPoolGeminiModel.value || "gemini-2.0-flash";

    const botToken = await resolveTelegramPoolBotToken(provider, effectiveSettings, {
      companyId,
      env: options?.env,
      secretResolver,
    });

    const bridge = getOrCreateBridge(normalizedModuleId, {
      poolChatService: service,
      modules: {
        [normalizedModuleId]: {
          moduleKey: normalizedModuleId,
          moduleId: normalizedModuleId,
          provider,
          companyId,
          enabled,
          allowedChatId,
          model,
          botToken,
        },
      },
      defaultCompanyId: companyId,
      outboxSender: options?.sender,
    });

    const update = (req.body ?? {}) as TelegramUpdate;
    const result = await bridge.processUpdate(normalizedModuleId, update, { companyId });
    res.json(result);
  });
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
    // channelId/subjectId are routing scope (read by routeScope), not part of the chat payload.
    const { channelId: _channelId, subjectId: _subjectId, ...payload } = (req.body ?? {}) as Record<string, unknown>;
    const parsed = validateRequestBody(req.body && typeof req.body === "object" && !Array.isArray(req.body) ? payload : req.body, new Set(capabilities.models));
    if (!parsed.valid) throw badRequest(parsed.code);
    const result = await service.submit({ companyId, moduleId, channel: scope.channelId, subjectId: scope.subjectId, idempotencyKey, body: parsed.value });
    res.status(201).json({ request: result });
  });
  router.get("/companies/:companyId/modules/:moduleId/chat/requests/:requestId", async (req, res) => {
    const actor = getActorInfo(req);
    // Reject agent JWT/session callers before looking up the request. This
    // avoids turning a guessed request id into an existence oracle.
    if (actor.actorType === "agent" && !actor.agentApiKeyId) {
      throw forbidden("Pool-chat invocation requires a scoped service principal");
    }
    const routeScopeForRead = routeScope(req);
    const decision = await authorizePoolChatInvocation(db, {
      companyId: req.params.companyId,
      moduleId: req.params.moduleId,
      channelId: routeScopeForRead.channelId,
      subjectId: routeScopeForRead.subjectId,
      principalType: actor.actorType,
      principalId: actor.actorId,
    });
    if (!decision.allowed) throw notFound("Pool-chat request not found");
    const request = await service.status(req.params.companyId, req.params.moduleId, req.params.requestId);
    // Keep missing and unauthorized reads indistinguishable to callers.
    if (request.channel !== routeScopeForRead.channelId || request.subjectId !== routeScopeForRead.subjectId) {
      throw notFound("Pool-chat request not found");
    }
    res.json({ request });
  });
  return router;
}

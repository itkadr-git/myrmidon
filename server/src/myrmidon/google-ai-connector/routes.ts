// myrmidon(GOOGLE-AI-CONNECT-UI): routes.
//
//   GET    /api/myrmidon/google-ai-connector/state            — owner (screen data)
//   POST   /api/myrmidon/google-ai-connector/connect          — owner (cookie paste)
//   POST   /api/myrmidon/google-ai-connector/reconnect        — owner (new paste)
//   DELETE /api/myrmidon/google-ai-connector/connection       — owner
//   GET    /api/myrmidon/google-ai-connector/grants           — owner
//   PUT    /api/myrmidon/google-ai-connector/grants           — owner
//   DELETE /api/myrmidon/google-ai-connector/grants/:id       — owner
//   POST   /api/myrmidon/google-ai-connector/check            — owner (health now)
//   POST   /api/myrmidon/google-ai-connector/trial            — owner (trial image)
//   GET    /api/myrmidon/google-ai-connector/journal          — owner
//   POST   /api/myrmidon/google-ai-connector/call             — agent (grant-checked generate)
//   GET    /api/myrmidon/google-ai-connector/jobs/:id         — owner or calling agent
//
// "Owner" is a board user with an active owner (or instance admin) role on the
// company. Agents never reach the configuration routes; they only call tools,
// and the service confines every call to their grants. The cookie paste is
// write-only: no route here ever returns bundle material — not to the owner,
// not to the agent.
//
// The bridge-facing session delivery (mode `endpoint`) is a separate route
// below: the bridge pulls the rotated bundle with a token the operator
// provisioned once. It answers the bundle bytes and nothing else, logs only
// the outcome, and is inert when the delivery mode is `off` or `hook`.

import { Router, type Request } from "express";
import {
  gaiCallSchema,
  gaiCookiePasteSchema,
  gaiGrantPutSchema,
  gaiTrialSchema,
} from "@paperclipai/shared/myrmidon-google-ai-connector";
import { forbidden, HttpError, unauthorized } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertAuthenticated } from "../../routes/authz.js";
import { gaiAgentIdentity } from "./identity.js";
import type { GoogleAiConnectorService } from "./service.js";
import type { GaiSessionStore } from "./types.js";
import { isSessionBundleJson } from "./cookies.js";
import { logger } from "../../middleware/logger.js";

function toHttpError(error: unknown): unknown {
  if (error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number") {
    const status = (error as { status: number }).status;
    if ([400, 401, 403, 404, 409, 502].includes(status)) {
      const message = (error as { message?: unknown }).message;
      return new HttpError(status as 400, typeof message === "string" ? message : "request refused");
    }
  }
  return error;
}

function companyIdOf(req: Request): string | null {
  const raw = req.query.companyId;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return null;
}

function assertGaiOwner(req: Request, companyId: string | null): string {
  assertAuthenticated(req);
  if (req.actor.type !== "board") throw forbidden("Owner access required");
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return req.actor.userId ?? "board";
  if (!companyId || !((req.actor.companyIds ?? []).includes(companyId))) throw forbidden("Company access required");
  const membership = req.actor.memberships?.find((item) => item.companyId === companyId);
  if (!(membership?.status === "active" && String(membership.membershipRole) === "owner")) {
    throw forbidden("Owner access required");
  }
  return req.actor.userId ?? "board";
}

export interface GoogleAiConnectorRoutesDeps {
  service: GoogleAiConnectorService;
  /** Only the session-delivery route needs the bundle reader. */
  session: GaiSessionStore;
  /** Bearer token the bridge presents at /session (operator-provisioned;
   * compared hash-wise, never logged). Null disables the endpoint. */
  bridgeDeliveryToken: () => string | null;
}

export function googleAiConnectorRoutes(deps: GoogleAiConnectorRoutesDeps) {
  const router = Router();
  const { service } = deps;

  router.get("/myrmidon/google-ai-connector/state", async (req, res) => {
    const companyId = companyIdOf(req);
    assertGaiOwner(req, companyId);
    res.json(await service.state(companyId!));
  });

  router.post("/myrmidon/google-ai-connector/connect", validate(gaiCookiePasteSchema), async (req, res) => {
    const companyId = String(req.body.companyId);
    const userId = assertGaiOwner(req, companyId);
    try {
      res.json(await service.connect({ companyId, userId, cookieJson: req.body.cookieJson }));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.post("/myrmidon/google-ai-connector/reconnect", validate(gaiCookiePasteSchema), async (req, res) => {
    const companyId = String(req.body.companyId);
    const userId = assertGaiOwner(req, companyId);
    try {
      res.json(await service.reconnect({ companyId, userId, cookieJson: req.body.cookieJson }));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.delete("/myrmidon/google-ai-connector/connection", async (req, res) => {
    const companyId = companyIdOf(req);
    const userId = assertGaiOwner(req, companyId);
    res.json(await service.disconnect({ companyId: companyId!, userId }));
  });

  router.get("/myrmidon/google-ai-connector/grants", async (req, res) => {
    const companyId = companyIdOf(req);
    assertGaiOwner(req, companyId);
    res.json({ grants: await service.listGrants(companyId!) });
  });

  router.put("/myrmidon/google-ai-connector/grants", validate(gaiGrantPutSchema), async (req, res) => {
    const companyId = String(req.body.companyId);
    const actor = assertGaiOwner(req, companyId);
    try {
      res.json({ grant: await service.setGrant(req.body, actor) });
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.delete("/myrmidon/google-ai-connector/grants/:id", async (req, res) => {
    const companyId = companyIdOf(req);
    assertGaiOwner(req, companyId);
    res.json(await service.removeGrant(req.params.id as string, companyId!));
  });

  router.post("/myrmidon/google-ai-connector/check", async (req, res) => {
    const companyId = companyIdOf(req);
    assertGaiOwner(req, companyId);
    res.json(await service.checkHealth(companyId!, { kind: "owner" }));
  });

  router.post("/myrmidon/google-ai-connector/trial", validate(gaiTrialSchema), async (req, res) => {
    const companyId = String(req.body.companyId);
    const userId = assertGaiOwner(req, companyId);
    const prompt = req.body.prompt ?? "A small friendly lighthouse on a rocky coast at dusk, painterly style";
    try {
      res.json(await service.trialImage({ companyId, userId, prompt }));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.get("/myrmidon/google-ai-connector/journal", async (req, res) => {
    const companyId = companyIdOf(req);
    assertGaiOwner(req, companyId);
    res.json({ entries: await service.journal(companyId!) });
  });

  router.post("/myrmidon/google-ai-connector/call", validate(gaiCallSchema), async (req, res) => {
    const identity = await gaiAgentIdentity(service, req);
    try {
      res.json(await service.generate(identity, req.body));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  router.get("/myrmidon/google-ai-connector/jobs/:id", async (req, res) => {
    assertAuthenticated(req);
    if (req.actor.type !== "board" && req.actor.type !== "agent") throw unauthorized();
    const companyId = req.actor.type === "agent" ? req.actor.companyId : companyIdOf(req);
    if (!companyId) throw forbidden("Company access required");
    if (req.actor.type === "board") assertGaiOwner(req, companyId);
    const job = await service.jobStatus({ companyId, jobId: req.params.id as string });
    if (!job) throw new HttpError(404, "job not found");
    res.json(job);
  });

  // Bridge-facing session delivery. The bridge (mode `endpoint`) pulls the
  // current bundle with the operator-provisioned bearer token. Response shape
  // is exactly the frozen bundle ({name,value} array). Nothing else reads the
  // session secret, and nothing logs it: on failure the log carries the
  // outcome only. `off`/`hook` modes answer 404 so the endpoint disappears.
  router.get("/myrmidon/google-ai-connector/session", async (req, res) => {
    if (service.deliveryMode() !== "endpoint") throw new HttpError(404, "not found");
    const expected = deps.bridgeDeliveryToken();
    if (!expected) throw new HttpError(404, "not found");
    const header = req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (presented !== expected) {
      logger.warn({ route: "gai-session", outcome: "bad_token" }, "google-ai-connector session delivery refused");
      throw unauthorized("delivery token required");
    }
    const companiesWithConnection = await service.connectedCompanyIds();
    // The bridge serves one board; the first live connection is the session.
    const companyId = companyIdOf(req);
    const target = companyId && companiesWithConnection.includes(companyId) ? companyId : companiesWithConnection[0];
    if (!target) throw new HttpError(404, "no connection");
    const state = await service.state(target);
    if (!state.connection) throw new HttpError(404, "no connection");
    const bundle = await deps.session.read(target, state.connection.secretId);
    if (!bundle) throw new HttpError(409, "the session secret is unreadable — reconnect from the panel");
    let parsed: unknown;
    try {
      parsed = JSON.parse(bundle.value);
    } catch {
      parsed = null;
    }
    if (!isSessionBundleJson(parsed)) {
      logger.warn({ route: "gai-session", outcome: "bad_bundle" }, "google-ai-connector session bundle failed the shape check");
      throw new HttpError(409, "the stored session bundle is malformed — reconnect from the panel");
    }
    logger.info({ route: "gai-session", outcome: "served", version: bundle.version }, "google-ai-connector delivered the session bundle");
    res.json(parsed);
  });

  return router;
}

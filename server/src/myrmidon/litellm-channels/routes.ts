// server/src/myrmidon/litellm-channels/routes.ts
//
// myrmidon(1.6.7 OPE-9854): LiteLLM channel management routes.
// Enforces owner/admin check (assertCompanyAdmin) for mutations and propagates LiteLLM errors to UI.

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import { assertCompanyAccess, assertCompanyAdmin } from "../../routes/authz.js";
import { secretService } from "../../services/index.js";
import { createLitellmChannelsService, type LitellmChannelsDeps, type LitellmChannelsService } from "./service.js";

export function litellmChannelsRoutes(service: LitellmChannelsService): Router {
  const router = Router();

  // List channels
  router.get("/myrmidon/companies/:companyId/litellm/channels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const channels = await service.listChannels(companyId);
    res.json({ channels });
  });

  // Add channel (requires owner/admin)
  router.post("/myrmidon/companies/:companyId/litellm/channels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAdmin(req, companyId);
    const channel = await service.addChannel(companyId, req.body);
    res.status(201).json({ channel });
  });

  // Reorder channels (requires owner/admin)
  router.post("/myrmidon/companies/:companyId/litellm/channels/reorder", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAdmin(req, companyId);
    const orders = Array.isArray(req.body) ? req.body : req.body?.orders;
    const channels = await service.reorderChannels(companyId, orders);
    res.json({ channels });
  });

  // Disable channel (requires owner/admin)
  router.post("/myrmidon/companies/:companyId/litellm/channels/:channelId/disable", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channelId = req.params.channelId as string;
    assertCompanyAdmin(req, companyId);
    const channel = await service.disableChannel(companyId, channelId);
    res.json({ channel });
  });

  // Enable channel (requires owner/admin)
  router.post("/myrmidon/companies/:companyId/litellm/channels/:channelId/enable", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channelId = req.params.channelId as string;
    assertCompanyAdmin(req, companyId);
    const channel = await service.enableChannel(companyId, channelId);
    res.json({ channel });
  });

  // Update channel priority/weight/order/config (requires owner/admin)
  router.patch("/myrmidon/companies/:companyId/litellm/channels/:channelId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channelId = req.params.channelId as string;
    assertCompanyAdmin(req, companyId);
    const channel = await service.updateChannel(companyId, {
      ...req.body,
      channelId,
    });
    res.json({ channel });
  });

  // Delete channel (requires owner/admin)
  router.delete("/myrmidon/companies/:companyId/litellm/channels/:channelId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channelId = req.params.channelId as string;
    assertCompanyAdmin(req, companyId);
    await service.deleteChannel(companyId, channelId);
    res.json({ success: true, channelId });
  });

  return router;
}

/** The production wiring: secrets resolved from company secret store. */
export function myrmidonLitellmChannelsRoutes(
  db: Db,
  customDeps?: Partial<LitellmChannelsDeps>,
): Router {
  const secrets = secretService(db);
  const service = createLitellmChannelsService({
    db,
    readSecretValue: (companyId, secretName) =>
      secrets
        .getByName(companyId, secretName)
        .then((row) => (row ? secrets.resolveSecretValue(companyId, row.id, "latest") : null)),
    ...customDeps,
  });
  return litellmChannelsRoutes(service);
}

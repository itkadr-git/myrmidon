// POST /api/myrmidon/bots/me/disk-report (myrmidon 1.6.5 BOT-DISK-H4b, contract C4).
//
// botd sends the snapshot of the bot's disk. Only an agent actor (the bot's own
// PAPERCLIP_API_KEY) may call it, and the report is stored under the caller's own
// bot key: a body that names another bot is a 403, never a write. The body is
// capped at WS_DISK_REPORT_MAX_BODY_BYTES (413 above, checked on the raw bytes
// because the global JSON parser has already read it); a body that fails the
// `wsDiskReportSchema` is a 400 and leaves the previous report in place.
// The answer is exactly `wsDiskReportResponseSchema`.

import { Router, type Request } from "express";
import {
  WS_DISK_REPORT_MAX_ACTIONS,
  WS_DISK_REPORT_MAX_BODY_BYTES,
  wsDiskReportResponseSchema,
  wsDiskReportSchema,
} from "@paperclipai/shared";
import { badRequest, forbidden, payloadTooLarge, unauthorized } from "../../errors.js";
import { botKeyForAgent } from "./agent-config.js";
import { storeBotDiskReport } from "./bot-disk-report-store.js";

/** How soon botd should send the next report. */
export const BOT_DISK_NEXT_REPORT_SEC = 300;

function bodyBytes(req: Request): number {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (raw) return raw.length;
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared >= 0) return declared;
  return Buffer.byteLength(JSON.stringify(req.body ?? null));
}

export function botDiskReportRoutes(options: { nowMs?: () => number } = {}) {
  const router = Router();

  router.post("/myrmidon/bots/me/disk-report", (req, res) => {
    if (req.actor.type === "none") throw unauthorized();
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Only a bot's own agent key can send its disk report");
    }
    const botKey = botKeyForAgent(req.actor.agentId);
    if (!botKey) throw forbidden("The agent key does not belong to a bot container");

    if (bodyBytes(req) > WS_DISK_REPORT_MAX_BODY_BYTES) {
      throw payloadTooLarge(`Disk report is over ${WS_DISK_REPORT_MAX_BODY_BYTES} bytes`);
    }
    const parsed = wsDiskReportSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid disk report", parsed.error.issues);
    const report = parsed.data;
    if (report.actions.length > WS_DISK_REPORT_MAX_ACTIONS) {
      throw badRequest(`Disk report holds more than ${WS_DISK_REPORT_MAX_ACTIONS} actions`);
    }
    if (report.botKey !== botKey) throw forbidden("The report names another bot");

    storeBotDiskReport(botKey, report, options.nowMs?.());
    res.json(wsDiskReportResponseSchema.parse({ ok: true, nextReportSec: BOT_DISK_NEXT_REPORT_SEC }));
  });

  return router;
}

/** Router for app.ts, mounted under /api. */
export function myrmidonBotDiskReportRoutes() {
  return botDiskReportRoutes();
}

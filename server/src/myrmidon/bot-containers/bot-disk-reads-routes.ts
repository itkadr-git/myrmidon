// GET /api/myrmidon/bot-disk/reports and GET /api/myrmidon/bot-disk/physical
// (myrmidon 1.6.5 BOT-DISK-H4d: the read side of the bot disk panel).
//
// The panel (`ui/src/components/myrmidon/botDiskLifecycleApi.ts`) reads exactly
// these two paths: the newest C4 report of every bot and the physics of the bot
// partition (contract C5 — the dockergate answer, relayed as it comes). Both are
// board reads only: a report holds the disk state of every bot, so an agent key
// gets 403 and an anonymous call 401.
//
// The partition is read from dockergate (`GET /myrmidon/disk` over the same
// socket the docker driver uses) and never measured locally: the board container
// does not mount the bot partition, so a local statfs would describe the wrong
// filesystem (on 07.10.2026 the partition hit 100 % while the board volume was
// fine). When the gate does not answer, the route is a 503 and the panel says
// "not measured" rather than showing invented numbers.

import { Router, type Request } from "express";
import { wsDiskApiResponseSchema } from "@paperclipai/shared";
import { unauthorized } from "../../errors.js";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { readBotDiskReports } from "./bot-disk-report-store.js";
import { readDockergateDiskOrNull } from "./bot-quota.js";
import { dockergateDiskClientFromEnv, type DockergateDiskClient } from "./dockergate-disk-client.js";

/** What the panel gets from the physical read: the C5 answer of dockergate as is. */
export const BOT_DISK_PHYSICAL_UNAVAILABLE = "dockergate_unavailable";

export interface BotDiskReadsOptions {
  /** Tests inject a gate; production reads the socket from the environment. */
  gate?: Pick<DockergateDiskClient, "getDisk">;
}

/** A call without any actor is a 401, any other non-board actor is a 403 (as on the ingest route). */
function assertBoardRead(req: Request) {
  if (req.actor.type === "none") throw unauthorized();
  assertBoardOrgAccess(req);
}

export function botDiskReadsRoutes(options: BotDiskReadsOptions = {}) {
  const router = Router();
  const gate = options.gate ?? dockergateDiskClientFromEnv();

  // The last report of every bot, flattened: the panel type is the C4 report
  // itself (`BotDiskReportView`) plus the board's receive time, and an old
  // report may be partial — the panel treats a missing field as absent.
  router.get("/myrmidon/bot-disk/reports", (req, res) => {
    assertBoardRead(req);
    res.json({ reports: readBotDiskReports().map((entry) => ({ ...entry.report, receivedAt: entry.receivedAt })) });
  });

  // The physics of the bot partition (C5). `readDockergateDiskOrNull` never
  // throws: an unreachable or off-contract gate comes back as null.
  router.get("/myrmidon/bot-disk/physical", async (req, res) => {
    assertBoardRead(req);
    const disk = await readDockergateDiskOrNull(gate);
    if (!disk) {
      res.status(503).json({
        error: BOT_DISK_PHYSICAL_UNAVAILABLE,
        message: "dockergate did not answer GET /myrmidon/disk; the bot partition is not measured",
      });
      return;
    }
    // Serialize exactly the contract: an off-contract answer is a server bug, not a panel one.
    res.json(wsDiskApiResponseSchema.parse(disk));
  });

  return router;
}

/** Router for app.ts, mounted under /api. */
export function myrmidonBotDiskReadsRoutes(options: BotDiskReadsOptions = {}) {
  return botDiskReadsRoutes(options);
}
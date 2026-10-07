import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  patchHostDiskSettingsSchema,
  patchWsBotDiskPartitionSettingsSchema,
  wsBotDiskPartitionSettingsSchema,
  type HostDiskSettingsPatch,
  type WsBotDiskPartitionSettingsPatch,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { HostDiskService } from "./service.js";

/**
 * GET/PATCH /api/myrmidon/host-disk (myrmidon BOT-DISK, part E).
 *
 * GET reports the threshold in force, where it came from (stored settings,
 * the environment, or the default) and the state of the last sweep: usage,
 * growth rate and the biggest consumers. Any authenticated board member may
 * read it; the sweep keeps the numbers, so the route never walks a disk.
 * PATCH writes `instance_settings.general.hostDisk` and is instance-admin
 * only, the same rule the rest of the instance settings follow.
 */

export function hostDiskRoutes(_db: Db, service: HostDiskService) {
  const router = Router();

  router.get("/myrmidon/host-disk", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch(
    "/myrmidon/host-disk",
    validate(patchHostDiskSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      res.json(await service.update(req.body as HostDiskSettingsPatch, getActorInfo(req)));
    },
  );

  // myrmidon(1.6.5-BOT-DISK-H10): the bot-partition thresholds of contract C7.
  // GET reports the values in force with their source; PATCH is
  // instance-admin only and validates 85<90<95 ordering through the shared
  // schema (a patch that would break the ordering is a 422).
  router.get("/myrmidon/host-disk/partition", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.readPartition());
  });

  router.patch(
    "/myrmidon/host-disk/partition",
    validate(patchWsBotDiskPartitionSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const patch = req.body as WsBotDiskPartitionSettingsPatch;
      // The schema validates field shapes; the ordering invariant is checked
      // against the merged result, so a patch of one key that breaks
      // 85<90<95 against the stored values is rejected too.
      const current = await service.readPartition();
      const merged = {
        partitionThresholdPercent:
          patch.partitionThresholdPercent ?? current.thresholds.partitionThresholdPercent,
        partitionRefuseOpenPercent:
          patch.partitionRefuseOpenPercent ?? current.thresholds.partitionRefuseOpenPercent,
        partitionCriticalPercent:
          patch.partitionCriticalPercent ?? current.thresholds.partitionCriticalPercent,
      };
      const ordering = wsBotDiskPartitionSettingsSchema.safeParse(merged);
      if (!ordering.success) {
        res.status(422).json({
          error: "invalid_partition_thresholds",
          message:
            "partitionThresholdPercent < partitionRefuseOpenPercent < partitionCriticalPercent is required",
        });
        return;
      }
      res.json(await service.updatePartition(patch, getActorInfo(req)));
    },
  );

  return router;
}

// Pressure block of the bot's desired state (contract C3, BOT-DISK-H Д5).
//
// The physics come from the host-disk partition runtime (the dockergate
// measurement of the bot partition, refreshed by the sweep). `hard` at or above
// the refuse-open threshold, `soft` at or above the warn threshold, else `none`.
// `quotaPercent` stays null while the per-bot quota is off. Unmeasured partition
// (dockergate down / never measured) is "no data": null, so the service answers `none`.

import type { WsBotDiskPartitionSettings } from "@paperclipai/shared";
import type { BotPartitionThresholdState } from "../host-disk/partition.js";
import type { BotWorkspacePressure } from "./bot-workspaces-service.js";

export function botWorkspacePressureFromPartition(
  state: Pick<BotPartitionThresholdState, "partition" | "settings">,
): BotWorkspacePressure | null {
  const { partition, settings } = state;
  if (!partition || !settings) return null;
  return {
    quotaPercent: null,
    partitionPercent: Math.min(100, Math.max(0, partition.usedPercent)),
    level: pressureLevel(partition.usedPercent, settings),
  };
}

function pressureLevel(usedPercent: number, settings: WsBotDiskPartitionSettings): BotWorkspacePressure["level"] {
  if (usedPercent >= settings.partitionRefuseOpenPercent) return "hard";
  if (usedPercent >= settings.partitionThresholdPercent) return "soft";
  return "none";
}

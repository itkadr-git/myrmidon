// server/src/myrmidon/cto-chat/report-delivery.ts
//
// myrmidon(1.7-ACTIVE-CHANNEL): route the Commander (CTO-CHAT) report to the
// owner's active channel (roadmap-v1 §3.3).
//
// At the delivery point of the Commander report (CTO-CHAT):
//   - check owner active channel status via the active-channel service / store:
//       - active = "telegram" -> route notification to the Telegram X8 bridge;
//       - active = "web"      -> route notification to web notifications (board);
//       - active = null       -> default fallback behavior.
//
// Designed with injectable dependencies so unit tests can execute with a
// mocked active-channel status store and delivery sinks without needing a database.

import type { OwnerChannel } from "@myrmidon/shared";

export type CommanderReportTargetChannel = "telegram" | "web" | "default";

export interface CommanderReportDeliveryInput {
  companyId: string;
  ownerUserId: string;
  reportText: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface CommanderReportDeliveryResult {
  targetChannel: CommanderReportTargetChannel;
  delivered: boolean;
  destination: string;
  channelResolved: OwnerChannel | null;
}

export interface CommanderReportDeliveryDeps {
  /** Resolves the owner's active channel right now. */
  resolveActiveChannel: (ownerUserId: string, companyId: string) => Promise<OwnerChannel | null>;
  /** Sinks for the target channels. */
  deliverToTelegram: (input: CommanderReportDeliveryInput) => Promise<{ destination: string }>;
  deliverToWeb: (input: CommanderReportDeliveryInput) => Promise<{ destination: string }>;
  deliverDefault: (input: CommanderReportDeliveryInput) => Promise<{ destination: string }>;
}

/**
 * Determine the destination channel for the Commander report from the active channel status.
 */
export function resolveCommanderReportTarget(activeChannel: OwnerChannel | null): CommanderReportTargetChannel {
  if (activeChannel === "telegram") return "telegram";
  if (activeChannel === "web") return "web";
  return "default";
}

/**
 * Route and deliver the Commander report to the channel where the owner is currently active.
 */
export async function deliverCommanderReport(
  input: CommanderReportDeliveryInput,
  deps: CommanderReportDeliveryDeps,
): Promise<CommanderReportDeliveryResult> {
  let channel: OwnerChannel | null = null;
  try {
    channel = await deps.resolveActiveChannel(input.ownerUserId, input.companyId);
  } catch {
    channel = null;
  }
  const targetChannel = resolveCommanderReportTarget(channel);

  let destination = "";
  if (targetChannel === "telegram") {
    const res = await deps.deliverToTelegram(input);
    destination = res.destination;
  } else if (targetChannel === "web") {
    const res = await deps.deliverToWeb(input);
    destination = res.destination;
  } else {
    const res = await deps.deliverDefault(input);
    destination = res.destination;
  }

  return {
    targetChannel,
    delivered: true,
    destination,
    channelResolved: channel,
  };
}

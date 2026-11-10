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
// mocked active-channel status store and delivery sinks without needing a database,
// while provide createCommanderReportDeliveryDeps / deliverCommanderReportForDb
// for production routing backed by real board services.

import type { OwnerChannel } from "@myrmidon/shared";
import type { Db } from "@myrmidon/db";
import { chatEndpoints, chatPublications } from "@myrmidon/db";
import { and, eq } from "drizzle-orm";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { publishLiveEvent } from "../../services/live-events.js";
import { projectSafeChatPublication } from "../../services/chat-publication-projection.js";
import { resolveOwnerActiveChannel } from "../owner-active-channel/store.js";
import { readOwnerActiveChannelSettings } from "../owner-active-channel/settings.js";
import { findOwnerDmBindings } from "../owner-delivery/telegram-owner-bindings.js";

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

/**
 * Creates production delivery dependencies connected to the active channel store,
 * Telegram X8 bridge publications, and board web notifications.
 */
export function createCommanderReportDeliveryDeps(db: Db): CommanderReportDeliveryDeps {
  return {
    async resolveActiveChannel(ownerUserId: string) {
      const resolved = await readOwnerActiveChannelSettings({
        getGeneral: () => instanceSettingsService(db).getGeneral(),
      });
      return resolveOwnerActiveChannel(db, ownerUserId, {
        thresholdMin: resolved.thresholdMin,
      });
    },

    async deliverToWeb(input: CommanderReportDeliveryInput) {
      publishLiveEvent({
        companyId: input.companyId,
        type: "activity.logged",
        payload: {
          action: "commander_report.web_notification",
          ownerUserId: input.ownerUserId,
          title: input.title ?? "Commander Report",
          text: input.reportText,
          metadata: input.metadata ?? {},
        },
      });
      return { destination: `web:notification:${input.companyId}` };
    },

    async deliverToTelegram(input: CommanderReportDeliveryInput) {
      let agentId =
        (input.metadata?.agentId as string | undefined) ??
        (input.metadata?.createdByAgentId as string | undefined);

      if (!agentId) {
        // No explicit agent: fall back to the company's standing Telegram
        // endpoint assignee so the report still reaches the bridge.
        const [endpoint] = await db
          .select({ assignedAgentId: chatEndpoints.assignedAgentId })
          .from(chatEndpoints)
          .where(
            and(
              eq(chatEndpoints.companyId, input.companyId),
              eq(chatEndpoints.provider, "telegram"),
            ),
          )
          .limit(1);
        agentId = endpoint?.assignedAgentId ?? "";
      }

      if (agentId) {
        const bindings = await findOwnerDmBindings(db, {
          companyId: input.companyId,
          ownerUserId: input.ownerUserId,
          agentId,
        });

        if (bindings.length > 0) {
          const binding = bindings[0];
          const now = new Date();
          const publicationPayload = projectSafeChatPublication({
            classification: "external",
            source: "agent_comment",
            text: input.reportText,
          });

          const [publication] = await db
            .insert(chatPublications)
            .values({
              companyId: input.companyId,
              endpointId: binding.endpoint.id,
              conversationId: binding.conversation.id,
              issueId: binding.conversation.issueId,
              idempotencyKey: `commander-report:${Date.now()}:${binding.endpoint.id}`,
              payload: publicationPayload,
              state: "pending",
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: chatPublications.id });

          return { destination: `telegram:publication:${publication?.id ?? binding.endpoint.id}` };
        }
      }

      return { destination: `telegram:bridge:${input.companyId}` };
    },

    async deliverDefault(input: CommanderReportDeliveryInput) {
      return { destination: `default:board:${input.companyId}` };
    },
  };
}

/**
 * Route and deliver Commander report using production services backed by the database.
 */
export async function deliverCommanderReportForDb(
  db: Db,
  input: CommanderReportDeliveryInput,
  overrides?: Partial<CommanderReportDeliveryDeps>,
): Promise<CommanderReportDeliveryResult> {
  const deps = {
    ...createCommanderReportDeliveryDeps(db),
    ...overrides,
  };
  return deliverCommanderReport(input, deps);
}

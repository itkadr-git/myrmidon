// server/src/myrmidon/owner-active-channel/owner-delivery-gate.ts
//
// myrmidon(1.7-ACTIVE-CHANNEL): the owner-delivery entry point. The U2
// feature (questions and confirmations from ordinary tasks reaching the
// owner's standing Telegram DM) moved here unchanged; the active-channel gate
// of 1.7-ACTIVE-CHANNEL wraps it:
//
//   - the owner is active in Telegram (their `telegram` touch is the freshest
//     one and younger than the inactivity threshold) — the U2 Telegram
//     binding is used;
//   - the owner is active in the portal instead — the card stays board-only,
//     which is exactly where an owner active on the board reads it;
//   - no channel is active — the standing U2 rule: Telegram wins so a card
//     still reaches a passive owner off-portal.
//
// The vendor's own task-thread bindings always win (see the call site in
// services/chat-interaction-publications.ts); nothing here touches them.
import {
  telegramOwnerDeliveryBindings as telegramOwnerDeliveryBindingsU2,
  resolveOwnerDecisionRecipient,
  type OwnerDeliveryBinding,
  type OwnerDeliveryDb,
} from "../owner-delivery/telegram-owner-bindings.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { resolveOwnerActiveChannel } from "./store.js";
import { readOwnerActiveChannelSettings } from "./settings.js";
import type { Db } from "@myrmidon/db";
import { issues } from "@myrmidon/db";
import { and, eq } from "drizzle-orm";

export type { OwnerDeliveryBinding };
export { telegramOwnerDeliveryBindingsU2 };

/**
 * myrmidon(1.7-ACTIVE-CHANNEL): the Telegram binding path from U2, gated by
 * the owner's active channel. Returns [] when the owner is active on the
 * board right now — the card stays board-only — and applies the standing U2
 * rules in every other case. A settings or activity read failure never loses
 * the card: it falls back to the pre-gate U2 behavior.
 */
export async function telegramOwnerDeliveryBindings(
  db: OwnerDeliveryDb,
  input: {
    companyId: string;
    issueId: string;
    createdByAgentId: string | null | undefined;
    effectiveResolverPolicy?: string | null;
    addresseeAgentId?: string | null;
    addresseeUserId?: string | null;
  },
): Promise<OwnerDeliveryBinding[]> {
  // First run the standing U2 rules: if U2 says no bindings, nothing to deliver.
  const bindings = await telegramOwnerDeliveryBindingsU2(db, input);
  if (bindings.length === 0) return [];

  // U2 found bindings. Find the recipient ownerUserId to check active-channel status.
  const issueRows = await db
    .select({
      responsibleUserId: issues.responsibleUserId,
      createdByUserId: issues.createdByUserId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.id, input.issueId),
      ),
    );
  const issue = issueRows[0] ?? null;

  const chosen = await resolveOwnerDecisionRecipient(db, {
    companyId: input.companyId,
    agentId: input.createdByAgentId!,
    addresseeUserId: input.addresseeUserId,
    responsibleUserId: issue?.responsibleUserId,
    createdByUserId: issue?.createdByUserId,
  });

  const ownerUserId = chosen?.ownerUserId;
  if (ownerUserId) {
    let activeChannel: "web" | "telegram" | null = null;
    try {
      const resolved = await readOwnerActiveChannelSettings({
        getGeneral: () => instanceSettingsService(db as unknown as Db).getGeneral(),
      });
      activeChannel = await resolveOwnerActiveChannel(db as unknown as Db, ownerUserId, {
        thresholdMin: resolved.thresholdMin,
      });
    } catch {
      activeChannel = null;
    }
    // An owner active in the portal reads cards on the board; do not pull a
    // report into Telegram while they are here.
    if (activeChannel === "web") return [];
  }

  return bindings;
}

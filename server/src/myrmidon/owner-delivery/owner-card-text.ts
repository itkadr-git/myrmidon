// server/src/myrmidon/owner-delivery/owner-card-text.ts
//
// myrmidon(1.6.5-OWNER-DM-FILTER): the human-readable text of a card that
// goes to the task owner's Telegram DM (the U2 branch). The vendor's own
// card-text functions stay byte-for-byte untouched; this prefix is applied
// only when the owner-delivery bindings carried the card.
//
// The prefix is built from the interaction's own human-facing fields (title,
// question prompt, confirmation prompt, option labels). It must never carry
// internal identifiers: no uuids, no run ids, no commit hashes, no internal
// jargon — the text is the first thing the owner reads.

import type { IssueThreadInteraction } from "@paperclipai/shared";

const OWNER_DECISION_PREFIX = "Нужно ваше решение";

/**
 * A short human-readable summary line of the card: the question prompt, the
 * confirmation prompt, or the card title — whichever the interaction carries.
 * Returns null when nothing human-readable exists (the prefix then stands
 * alone above the vendor text).
 */
function ownerFacingPrompt(interaction: IssueThreadInteraction): string | null {
  if (interaction.kind === "ask_user_questions") {
    const first = interaction.payload.questions[0];
    const prompt = first?.prompt?.trim();
    if (prompt) return prompt;
    const title = interaction.payload.title ?? interaction.title;
    const trimmed = title?.trim();
    return trimmed ? trimmed : null;
  }
  if (interaction.kind === "request_confirmation") {
    const prompt = interaction.payload.prompt?.trim();
    if (prompt) return prompt;
  }
  const title = interaction.title;
  const trimmed = title?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The owner-DM card text: a one-line human-readable header followed by the
 * vendor text unchanged. Internal tokens (uuids, run ids, commit shas) never
 * appear in the header; the vendor body below it is the vendor's own text,
 * which the projection layer already sanitizes.
 */
export function ownerDeliveryCardText(
  interaction: IssueThreadInteraction,
  vendorText: string,
): string {
  const prompt = ownerFacingPrompt(interaction);
  const header = prompt
    ? `${OWNER_DECISION_PREFIX}: ${prompt}`
    : `${OWNER_DECISION_PREFIX}.`;
  return header + "\n\n" + vendorText;
}

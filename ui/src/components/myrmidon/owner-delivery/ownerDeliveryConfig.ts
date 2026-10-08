// myrmidon(1.6.5-OWNER-DM-FILTER): the delivery modes the settings screen
// offers, with the wording shown next to each radio card. Kept apart from the
// screen so the copy and the values live in one place; the wire contract itself
// is in ownerDeliveryApi.ts.
import type { OwnerDeliveryMode } from "./ownerDeliveryApi";

export interface OwnerDeliveryModeOption {
  value: OwnerDeliveryMode;
  title: string;
  description: string;
}

export const OWNER_DELIVERY_MODE_OPTIONS: OwnerDeliveryModeOption[] = [
  {
    value: "via_bot",
    title: "Message from the bot",
    description:
      "No cards with buttons. The agent that raised the question writes the owner a plain message that explains what to decide and why; the owner answers in the chat and the agent records the decision. The default.",
  },
  {
    value: "owner_decisions_only",
    title: "Owner decisions only",
    description:
      "Only cards that wait for the owner — a question or an approval an agent raised to unblock its task.",
  },
  {
    value: "all",
    title: "All cards",
    description:
      "Every card an agent raises for the owner, including notes and reports that need no answer.",
  },
];

/** The title of a mode as the screen shows it. */
export function ownerDeliveryModeTitle(mode: OwnerDeliveryMode): string {
  return OWNER_DELIVERY_MODE_OPTIONS.find((option) => option.value === mode)?.title ?? mode;
}
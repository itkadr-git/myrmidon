// myrmidon(TEAM-LIVENESS-SETTINGS): pure helpers for the "Team liveness"
// section of the agent card.
//
// The card stores `adapterConfig.teamLiveness = { autoResume?, runStall?,
// idlePickup? }`. Each switch is three-state: absent means "follow the instance
// settings", an explicit value overrides it for this one agent. The card never
// carries numbers — the wake budget and the wake throttle are company-wide
// ceilings, and an agent must not be able to raise them.
//
// The shapes and the resolution live in the shared contract
// (packages/shared/src/myrmidon-team-liveness.ts); this file only reads and
// writes the card block.

import {
  agentTeamLivenessCardSchema,
  type AgentTeamLivenessCard,
} from "@paperclipai/shared";

export const TEAM_LIVENESS_SWITCH_KEYS = ["autoResume", "runStall", "idlePickup"] as const;

export type TeamLivenessSwitchKey = (typeof TEAM_LIVENESS_SWITCH_KEYS)[number];

/** What one switch says: follow the instance settings, or override them. */
export type TeamLivenessCardChoice = "inherit" | "on" | "off";

/** The stored block as a plain object; anything else reads as "no override". */
export function readTeamLivenessBlock(value: unknown): AgentTeamLivenessCard {
  const parsed = agentTeamLivenessCardSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

export function teamLivenessChoice(
  block: AgentTeamLivenessCard,
  key: TeamLivenessSwitchKey,
): TeamLivenessCardChoice {
  const value = block[key];
  if (value === undefined) return "inherit";
  return value ? "on" : "off";
}

/**
 * Writes the block and drops an emptied one entirely, so a card that follows
 * the instance settings still reads as a card with no override rather than an
 * object full of nothing.
 */
export function setTeamLivenessChoice(
  block: AgentTeamLivenessCard,
  key: TeamLivenessSwitchKey,
  choice: TeamLivenessCardChoice,
): AgentTeamLivenessCard | undefined {
  const next: AgentTeamLivenessCard = { ...block };
  if (choice === "inherit") delete next[key];
  else next[key] = choice === "on";
  return Object.keys(next).length === 0 ? undefined : next;
}
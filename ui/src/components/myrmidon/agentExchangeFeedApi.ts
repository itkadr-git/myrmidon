// The owner-facing feed of agent discussion rooms (myrmidon 1.7
// AGENT-EXCHANGE-B):
//
//   GET   /api/myrmidon/companies/:companyId/agent-exchange/feed
//   POST  /api/myrmidon/companies/:companyId/agent-exchange/rooms/:roomId/skill-candidate
//   GET   /api/myrmidon/agent-exchange/feed/settings
//   PATCH /api/myrmidon/agent-exchange/feed/settings
//
// The feed shows the rooms of a company with their outcome, their price tag
// and the link to the task. One button turns an outcome into a skill
// candidate: the skill lands in the library as a candidate and waits for an
// approval — nothing is promoted from here.
import type {
  AgentExchangeFeedResponse,
  AgentExchangeFeedRoom,
  AgentExchangeFeedSettingSource,
  AgentExchangeFeedSettingsPatch,
  AgentExchangeSkillCandidateResult,
  ResolvedAgentExchangeFeedSettings,
} from "@paperclipai/shared";
import { api } from "@/api/client";

export const agentExchangeFeedSettingsQueryKey = ["myrmidon", "agent-exchange-feed", "settings"] as const;

export function agentExchangeFeedQueryKey(companyId: string) {
  return ["myrmidon", "agent-exchange-feed", "company", companyId] as const;
}

export const agentExchangeFeedApi = {
  feed: (companyId: string) =>
    api.get<AgentExchangeFeedResponse>(`/myrmidon/companies/${companyId}/agent-exchange/feed`),
  settings: () =>
    api.get<ResolvedAgentExchangeFeedSettings>("/myrmidon/agent-exchange/feed/settings"),
  updateSettings: (patch: AgentExchangeFeedSettingsPatch) =>
    api.patch<ResolvedAgentExchangeFeedSettings>("/myrmidon/agent-exchange/feed/settings", patch),
  createSkillCandidate: (companyId: string, roomId: string, body: { name?: string; note?: string } = {}) =>
    api.post<AgentExchangeSkillCandidateResult>(
      `/myrmidon/companies/${companyId}/agent-exchange/rooms/${roomId}/skill-candidate`,
      body,
    ),
};

/** Where an effective setting came from, as the settings panel shows it. */
export function describeAgentExchangeFeedSource(source: AgentExchangeFeedSettingSource): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "Forced by the server environment";
    default:
      return "Default";
  }
}

/**
 * The price tag of a room. The server records hundredths of a cent (part A's
 * `agentExchangeCallCostCents`); a room that spent tokens without a known
 * price reads as "unknown", never as free.
 */
export function formatAgentExchangeRoomCost(room: {
  costCents: number;
  costKnown: boolean;
  tokensUsed: number;
}): string {
  if (!room.costKnown) return `unknown (${room.tokensUsed.toLocaleString()} tokens)`;
  if (room.costCents === 0) return "free";
  return `$${(room.costCents / 10_000).toFixed(4)}`;
}

/** `OPE-4172 — the title`, or just the title / the id when one is missing. */
export function formatAgentExchangeRoomLabel(room: {
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueId: string;
}): string {
  const parts = [room.issueIdentifier, room.issueTitle].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" — ") : room.issueId;
}

/** The status of a room in words: open / stopped / completed. */
export function formatAgentExchangeRoomStatus(room: {
  status: string;
  stopReason: string | null;
}): string {
  if (room.status === "stopped") return room.stopReason === "owner_stop" ? "stopped by the owner" : "stopped";
  if (room.status === "completed") return "completed";
  return "open";
}
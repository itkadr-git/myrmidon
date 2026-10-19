// myrmidon(CA-A): API client for the channel allowlist screen — the board
// list of who may write to the company's bots (channel identity; a board
// account is optional). The server routes are /api/myrmidon/channel-allowlist.
import { api } from "@/api/client";
import type { ChannelAllowedUser } from "@paperclipai/shared";

export type { ChannelAllowedUser };

export const channelAllowlistQueryKey = (companyId: string) =>
  ["myrmidon", "channel-allowlist", companyId] as const;

const path = (companyId?: string) => {
  const base = "/myrmidon/channel-allowlist";
  return companyId && companyId.length > 0
    ? `${base}?companyId=${encodeURIComponent(companyId)}`
    : base;
};

export interface ChannelAllowlistCreateInput {
  provider: string;
  externalId: string;
  handle?: string | null;
  displayName?: string | null;
  scope: "company" | "endpoint";
  endpointId?: string | null;
}

export const channelAllowlistApi = {
  list: (companyId: string) =>
    api.get<{ allowedUsers: ChannelAllowedUser[] }>(path(companyId)),
  create: (companyId: string, input: ChannelAllowlistCreateInput) =>
    api.post<{ allowedUser: ChannelAllowedUser }>(path(companyId), input),
  revoke: (companyId: string, id: string) =>
    api.patch<{ allowedUser: ChannelAllowedUser }>(
      `/myrmidon/channel-allowlist/${encodeURIComponent(id)}?companyId=${encodeURIComponent(companyId)}`,
      { status: "revoked" },
    ),
  restore: (companyId: string, id: string) =>
    api.patch<{ allowedUser: ChannelAllowedUser }>(
      `/myrmidon/channel-allowlist/${encodeURIComponent(id)}?companyId=${encodeURIComponent(companyId)}`,
      { status: "active" },
    ),
};

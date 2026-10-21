// myrmidon(1.7-ACTIVE-CHANNEL): the owner active-channel status for the shell.
//
// The shell used to show a hardcoded "Web · now" literal; this hook reads the
// real status from GET /api/myrmidon/owner/active-channel — the channel the
// owner is active in (portal or Telegram), or null when no channel is recent
// enough. The rail and the phone header label themselves from it.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OwnerActiveChannelView, OwnerChannel } from "@paperclipai/shared";
import { api } from "@/api/client";

export const ownerActiveChannelQueryKey = ["myrmidon", "owner-active-channel"] as const;

export const ownerActiveChannelApi = {
  get: () => api.get<OwnerActiveChannelView>("/myrmidon/owner/active-channel"),
};

/** What the shell needs: the active channel, or null (unknown / no touch fresh enough). */
export type Ui2OwnerActiveChannel = OwnerChannel | null;

/** How often the shell re-reads the status: a channel switch shows up without a reload. */
export const OWNER_ACTIVE_CHANNEL_POLL_MS = 30_000;

export function useOwnerActiveChannel(): Ui2OwnerActiveChannel {
  const query = useQuery({
    // A stable array identity: an inline literal would re-subscribe the
    // polling query on every render (react-query identity rule).
    queryKey: ownerActiveChannelQueryKey,
    queryFn: () => ownerActiveChannelApi.get(),
    refetchInterval: OWNER_ACTIVE_CHANNEL_POLL_MS,
    staleTime: OWNER_ACTIVE_CHANNEL_POLL_MS,
  });
  const channel = query.data?.channel ?? null;
  return useMemo(() => channel, [channel]);
}

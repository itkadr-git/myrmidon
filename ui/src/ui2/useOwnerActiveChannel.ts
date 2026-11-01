// myrmidon(1.7-ACTIVE-CHANNEL): the owner active-channel status for the shell.
//
// The shell used to show a hardcoded "Web · now" literal; this hook reads the
// real status from GET /api/myrmidon/owner/active-channel — the channel the
// owner is active in (portal or Telegram), or null when no channel is recent
// enough. The rail and the phone header label themselves from it, including
// human-readable relative freshness of the last activity.
import { useContext, useMemo } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import {
  type OwnerActiveChannelView,
  type OwnerChannel,
  OWNER_CHANNELS,
} from "@myrmidon/shared";
import { api } from "@/api/client";

let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

export const ownerActiveChannelQueryKey = ["myrmidon", "owner-active-channel"] as const;

export const ownerActiveChannelApi = {
  get: () => api.get<OwnerActiveChannelView>("/myrmidon/owner/active-channel"),
};

/** What the shell needs: the active channel and the last activity ISO timestamp. */
export interface Ui2OwnerActiveChannel {
  channel: OwnerChannel | null;
  lastActiveAt: string | null;
}

/** How often the shell re-reads the status: a channel switch shows up without a reload. */
export const OWNER_ACTIVE_CHANNEL_POLL_MS = 30_000;

export function useOwnerActiveChannel(): Ui2OwnerActiveChannel {
  const contextClient = useContext(QueryClientContext);
  const query = useQuery(
    {
      // A stable array identity: an inline literal would re-subscribe the
      // polling query on every render (react-query identity rule).
      queryKey: ownerActiveChannelQueryKey,
      queryFn: () => ownerActiveChannelApi.get(),
      enabled: contextClient != null,
      refetchInterval: OWNER_ACTIVE_CHANNEL_POLL_MS,
      staleTime: OWNER_ACTIVE_CHANNEL_POLL_MS,
    },
    contextClient ?? getDetachedClient(),
  );

  const data = query.data;
  const channel = data?.channel ?? null;

  const lastActiveAt = useMemo(() => {
    if (!data) return null;
    if (channel && data.lastActiveAt?.[channel]) {
      return data.lastActiveAt[channel];
    }
    if (data.lastActiveAt) {
      let latest: string | null = null;
      for (const ch of OWNER_CHANNELS) {
        const at = data.lastActiveAt[ch];
        if (at && (!latest || Date.parse(at) > Date.parse(latest))) {
          latest = at;
        }
      }
      return latest;
    }
    return null;
  }, [data, channel]);

  return useMemo(() => ({ channel, lastActiveAt }), [channel, lastActiveAt]);
}

export function formatOwnerActiveChannelFreshness(
  lastActiveAt: string | null | undefined,
  options: { locale?: string; now?: number; t?: (key: string, opts?: any) => string } = {},
): string | null {
  if (!lastActiveAt) return null;
  const at = Date.parse(lastActiveAt);
  if (!Number.isFinite(at)) return null;

  const now = options.now ?? Date.now();
  const diffMs = Math.max(0, now - at);

  if (diffMs < 60_000) {
    if (options.t) {
      return options.t("time.justNow", { defaultValue: "just now" });
    }
    return options.locale?.startsWith("ru") ? "только что" : "just now";
  }

  const locale = options.locale ?? "en";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) {
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
    return formatter.format(-minutes, "minute");
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
    return formatter.format(-hours, "hour");
  }

  const days = Math.round(hours / 24);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  return formatter.format(-days, "day");
}

export function formatOwnerActiveChannelLabel(
  activeChannel: Ui2OwnerActiveChannel,
  t: (key: string, opts?: any) => string,
  options: { locale?: string; now?: number } = {},
): string {
  const channel = activeChannel.channel;
  if (!channel) {
    return t("ui2.shell.activeChannel.none", { defaultValue: "Active · not seen recently" });
  }

  const channelLabel =
    channel === "telegram"
      ? t("ui2.shell.activeChannel.telegram", { defaultValue: "Active · Telegram" })
      : t("ui2.shell.activeChannel.web", { defaultValue: "Active · Web" });

  const freshness = formatOwnerActiveChannelFreshness(activeChannel.lastActiveAt, {
    locale: options.locale,
    now: options.now,
    t,
  });

  if (!freshness) {
    return channelLabel;
  }
  return `${channelLabel} · ${freshness}`;
}

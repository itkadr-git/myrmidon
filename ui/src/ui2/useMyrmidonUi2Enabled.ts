import { useContext, useEffect, useState } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import {
  UI2_OVERRIDE_EVENT,
  readUi2PersonalOverride,
  rememberUi2PersonalOverride,
  resolveMyrmidonUi2Enabled,
  ui2OverrideFromSearch,
} from "@/lib/myrmidonUi2PersonalOverride";

export * from "@/lib/myrmidonUi2PersonalOverride";

let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

export function useMyrmidonUi2Enabled(): { enabled: boolean; loaded: boolean } {
  const contextClient = useContext(QueryClientContext);
  const query = useQuery(
    {
      queryKey: queryKeys.instance.experimentalSettings,
      queryFn: () => instanceSettingsApi.getExperimental(),
      enabled: contextClient != null,
    },
    contextClient ?? getDetachedClient(),
  );

  const [, setOverrideVersion] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => setOverrideVersion((v) => v + 1);
    window.addEventListener(UI2_OVERRIDE_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(UI2_OVERRIDE_EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, []);

  // Personal override beats the instance flag (lead annex: the operator can
  // force ui2 locally for review even while the flag is off company-wide,
  // and force the 1.x shell while the flag is on).
  const personal =
    typeof window !== "undefined" ? ui2OverrideFromSearch(window.location.search) : null;
  if (personal != null) {
    if (typeof window !== "undefined") rememberUi2PersonalOverride(personal);
    return { enabled: personal === "2", loaded: true };
  }
  const remembered = readUi2PersonalOverride();
  if (remembered != null) {
    return { enabled: remembered === "2", loaded: true };
  }

  if (!contextClient) return { enabled: false, loaded: true };

  return {
    enabled: resolveMyrmidonUi2Enabled(query.data),
    loaded: query.isFetched,
  };
}

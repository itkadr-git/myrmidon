import { useContext, useEffect, useState } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import type { InstanceExperimentalSettings } from "@myrmidon/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

export const UI_OVERRIDE_STORAGE_KEY = "myr.ui2.personal";
export const UI2_OVERRIDE_EVENT = "myr:ui2-override";

export type Ui2PersonalOverride = "1" | "2" | null;

let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

export function resolveMyrmidonUi2Enabled(
  settings: Pick<InstanceExperimentalSettings, "enableMyrmidonUi2"> | null | undefined,
): boolean {
  return settings?.enableMyrmidonUi2 === true;
}

export function getSafeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readUi2PersonalOverride(storage?: Storage | null): Ui2PersonalOverride {
  try {
    const s = storage !== undefined ? storage : getSafeLocalStorage();
    const raw = s?.getItem(UI_OVERRIDE_STORAGE_KEY);
    return raw === "1" || raw === "2" ? raw : null;
  } catch {
    return null;
  }
}

export function rememberUi2PersonalOverride(
  value: "1" | "2" | null,
  storage?: Pick<Storage, "setItem" | "removeItem"> | null,
): void {
  try {
    const s = storage !== undefined ? storage : getSafeLocalStorage();
    if (value === null) s?.removeItem(UI_OVERRIDE_STORAGE_KEY);
    else s?.setItem(UI_OVERRIDE_STORAGE_KEY, value);
  } catch {
    // Ignore storage quota/permission errors
  }
}

export function setUi2PersonalOverride(value: Ui2PersonalOverride): void {
  rememberUi2PersonalOverride(value);
  if (typeof window !== "undefined") {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("ui")) {
        url.searchParams.delete("ui");
        const cleanUrl = url.pathname + (url.search ? url.search : "") + url.hash;
        window.history.replaceState(window.history.state, "", cleanUrl);
      }
    } catch {
      // Ignore URL parsing errors
    }
    try {
      window.dispatchEvent(new CustomEvent(UI2_OVERRIDE_EVENT, { detail: value }));
      window.dispatchEvent(new Event("storage"));
    } catch {
      // Ignore event dispatch errors
    }
  }
}

export function ui2OverrideFromSearch(search: string): "1" | "2" | null {
  const params = new URLSearchParams(search);
  const raw = params.get("ui");
  return raw === "1" || raw === "2" ? raw : null;
}

export function useMyrmidonUi2PersonalOverride(): {
  override: Ui2PersonalOverride;
  effectiveEnabled: boolean;
  instanceEnabled: boolean;
  setOverride: (value: Ui2PersonalOverride) => void;
} {
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

  const override = readUi2PersonalOverride();
  const instanceEnabled = resolveMyrmidonUi2Enabled(query.data);
  const searchOverride =
    typeof window !== "undefined" ? ui2OverrideFromSearch(window.location.search) : null;
  const effectiveOverride = searchOverride ?? override;

  const effectiveEnabled =
    effectiveOverride === "2" ? true : effectiveOverride === "1" ? false : instanceEnabled;

  return {
    override,
    effectiveEnabled,
    instanceEnabled,
    setOverride: setUi2PersonalOverride,
  };
}

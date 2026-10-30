// myrmidon(UI-0a): UI-2.0 shell — own clean-room tree (owner decision 02.10:
// new components under ui/src/ui2/, no edits to vendor UI files beyond the
// single mount point in App.tsx and the token import in index.css).
//
// Hook for the instance experimental flag `enableMyrmidonUi2` (default off)
// plus the personal `?ui=1|2` override remembered client-side (lead annex:
// localStorage, screen-map §4 mechanics). Precedence: personal override >
// instance flag. Missing settings, loading and read failures all resolve to
// `false`: the 2.0 shell is opt-in and must never flash or self-activate on
// a read error.
import { useContext, useEffect, useState } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import type { InstanceExperimentalSettings } from "@myrmidon/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

const UI_OVERRIDE_STORAGE_KEY = "myr.ui2.personal";
export const UI2_OVERRIDE_EVENT = "myr:ui2-override";

export type Ui2PersonalOverride = "1" | "2" | null;

export function resolveMyrmidonUi2Enabled(
  settings: Pick<InstanceExperimentalSettings, "enableMyrmidonUi2"> | null | undefined,
): boolean {
  return settings?.enableMyrmidonUi2 === true;
}

export function readUi2PersonalOverride(storage: Storage | null | undefined): Ui2PersonalOverride {
  try {
    const raw = storage?.getItem(UI_OVERRIDE_STORAGE_KEY);
    return raw === "1" || raw === "2" ? raw : null;
  } catch {
    return null;
  }
}

export function rememberUi2PersonalOverride(
  value: "1" | "2" | null,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined | null = typeof window !== "undefined"
    ? window.localStorage
    : undefined,
): void {
  try {
    if (value === null) storage?.removeItem(UI_OVERRIDE_STORAGE_KEY);
    else storage?.setItem(UI_OVERRIDE_STORAGE_KEY, value);
  } catch {
    // Storage access throws in some privacy modes; the override is cosmetic.
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
      // URL parsing / history state might fail in mock environments
    }
    try {
      window.dispatchEvent(new CustomEvent(UI2_OVERRIDE_EVENT, { detail: value }));
      window.dispatchEvent(new Event("storage"));
    } catch {
      // Event dispatch fallback
    }
  }
}

/** One-shot: pick the override from ?ui=1|2 of the current location, if any. */
export function ui2OverrideFromSearch(search: string): "1" | "2" | null {
  const params = new URLSearchParams(search);
  const raw = params.get("ui");
  return raw === "1" || raw === "2" ? raw : null;
}

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
  const remembered =
    typeof window !== "undefined" ? readUi2PersonalOverride(window.localStorage) : null;
  if (remembered != null) {
    return { enabled: remembered === "2", loaded: true };
  }

  if (!contextClient) return { enabled: false, loaded: true };

  return {
    enabled: resolveMyrmidonUi2Enabled(query.data),
    loaded: query.isFetched,
  };
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

  const instanceEnabled = resolveMyrmidonUi2Enabled(query.data);
  const personalFromUrl =
    typeof window !== "undefined" ? ui2OverrideFromSearch(window.location.search) : null;
  const remembered =
    typeof window !== "undefined" ? readUi2PersonalOverride(window.localStorage) : null;
  const currentOverride = personalFromUrl ?? remembered;

  const effectiveEnabled =
    currentOverride === "2"
      ? true
      : currentOverride === "1"
        ? false
        : instanceEnabled;

  return {
    override: currentOverride,
    effectiveEnabled,
    instanceEnabled,
    setOverride: setUi2PersonalOverride,
  };
}

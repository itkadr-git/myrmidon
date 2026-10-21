// myrmidon(BROWSER-CONSOLE): the screen session panel — timers, the auto-close
// warning, the Done button, the periodic activity heartbeat and (part B) the
// live Guacamole frame. The panel drives the session lifecycle and keeps the
// screen open by reporting activity; the pixels arrive through the signed
// console token the panel asks the server for (console-token route), the same
// way the fleet console frame does.
//
// mousemove/keydown inside the Guacamole iframe are invisible to the host
// page, so activity comes from pointer/key events on the panel itself plus
// window focus and visibility changes; the 30-second keep-alive heartbeat
// stays activity=false between interactions.

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/api/client";
import { browsersApi, browsersQueryKey, formatDuration } from "./browsersApi";
import type {
  BrowserConsoleStatus,
  BrowserScreenConsoleTokenResponse,
  BrowserScreenStatusResponse,
} from "@paperclipai/shared/myrmidon-browser-console";

const HEARTBEAT_MS = 30_000;
/** Interaction bursts must not hammer the heartbeat endpoint; one report per window is enough. */
const ACTIVITY_DEBOUNCE_MS = 5_000;

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export interface ScreenPanelState {
  active: boolean;
  autoCloseAt: number | null;
  warnAt: number | null;
  closedBy: string | null;
  error: string | null;
  remainingMs: number;
}

export function useScreenSession(browser: BrowserConsoleStatus, companyId: string) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ScreenPanelState>({
    active: false,
    autoCloseAt: null,
    warnAt: null,
    closedBy: null,
    error: null,
    remainingMs: 0,
  });
  const [now, setNow] = useState(Date.now());
  const browserIdRef = useRef(browser.id);
  browserIdRef.current = browser.id;
  const lastActivityReportRef = useRef(0);

  const heartbeatMutation = useMutation({
    mutationFn: (activity: boolean) => browsersApi.heartbeat(browserIdRef.current, companyId, activity),
    onMutate: () => setState((current) => ({ ...current, error: null })),
    onSuccess: (result) => {
      if (!result.active) {
        setState({ active: false, autoCloseAt: null, warnAt: null, closedBy: result.closedBy ?? null, error: null, remainingMs: 0 });
        void queryClient.invalidateQueries({ queryKey: browsersQueryKey });
        return;
      }
      setState((current) => ({
        ...current,
        active: true,
        autoCloseAt: result.autoCloseAt ? Date.parse(result.autoCloseAt) : null,
        warnAt: result.warnAt ? Date.parse(result.warnAt) : null,
        closedBy: result.closedBy ?? null,
        remainingMs: result.autoCloseAt ? Math.max(0, Date.parse(result.autoCloseAt) - Date.now()) : 0,
      }));
    },
    onError: (error) => setState((current) => ({ ...current, error: readable(error) })),
  });

  const doneMutation = useMutation({
    mutationFn: () => browsersApi.done(browserIdRef.current, companyId),
    onSuccess: () => {
      setState({ active: false, autoCloseAt: null, warnAt: null, closedBy: "done", error: null, remainingMs: 0 });
      void queryClient.invalidateQueries({ queryKey: browsersQueryKey });
    },
    onError: (error) => setState((current) => ({ ...current, error: readable(error) })),
  });

  // Part B: the signed Guacamole blob for this session. Issued once when the
  // session becomes live; Reconnect asks the server for a fresh one (the blob
  // only has to survive the frame's connection attempt — an already-open
  // Guacamole picture keeps streaming after `expiresAt` passes).
  const [screen, setScreen] = useState<BrowserScreenConsoleTokenResponse | null>(null);
  const tokenMutation = useMutation({
    mutationFn: () => browsersApi.consoleToken(browserIdRef.current, companyId),
    onMutate: () => setState((current) => ({ ...current, error: null })),
    onSuccess: (issued) => setScreen(issued),
    onError: (error) => setState((current) => ({ ...current, error: readable(error) })),
  });

  // Adopt an existing session (another tab, a page reload).
  const openScreenQuery = useQuery({
    queryKey: ["myrmidon", "browsers", "screen", browser.id],
    queryFn: () => browsersApi.heartbeat(browser.id, companyId, false),
    enabled: browser.sessionActive,
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const result = openScreenQuery.data as (BrowserScreenStatusResponse & { active: boolean }) | undefined;
    if (!result) return;
    if (result.active) {
      setState((current) => ({
        ...current,
        active: true,
        autoCloseAt: result.autoCloseAt ? Date.parse(result.autoCloseAt) : null,
        warnAt: result.warnAt ? Date.parse(result.warnAt) : null,
        closedBy: null,
        remainingMs: result.autoCloseAt ? Math.max(0, Date.parse(result.autoCloseAt) - Date.now()) : 0,
      }));
    }
  }, [openScreenQuery.data]);

  // Issue the console token on the live edge; drop it when the session ends.
  useEffect(() => {
    if (!state.active) {
      setScreen(null);
      return;
    }
    tokenMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.active]);

  // While the session is live: tick the clock, send keep-alive heartbeats.
  useEffect(() => {
    if (!state.active) return;
    const clock = setInterval(() => {
      setNow(Date.now());
      setState((current) => ({
        ...current,
        remainingMs: current.autoCloseAt !== null ? Math.max(0, current.autoCloseAt - Date.now()) : 0,
      }));
    }, 1_000);
    const beat = setInterval(() => heartbeatMutation.mutate(false), HEARTBEAT_MS);
    return () => {
      clearInterval(clock);
      clearInterval(beat);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.active]);

  // Part B activity: pointer/key events over the panel plus window focus and
  // tab visibility report activity=true (debounced). Events inside the
  // Guacamole frame are invisible here — the frame keeps the owner busy, and
  // any pointer return to the panel chrome counts.
  const reportActivity = useCallback(() => {
    if (!state.active) return;
    const stamp = Date.now();
    if (stamp - lastActivityReportRef.current < ACTIVITY_DEBOUNCE_MS) return;
    lastActivityReportRef.current = stamp;
    heartbeatMutation.mutate(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.active]);
  useEffect(() => {
    if (!state.active) return;
    const onWindowSeen = () => {
      if (document.visibilityState === "hidden") return;
      reportActivity();
    };
    window.addEventListener("focus", onWindowSeen);
    document.addEventListener("visibilitychange", onWindowSeen);
    return () => {
      window.removeEventListener("focus", onWindowSeen);
      document.removeEventListener("visibilitychange", onWindowSeen);
    };
  }, [state.active, reportActivity]);

  // The auto-close warning window: warnAt <= now.
  const warning = state.active && state.warnAt !== null && now >= state.warnAt && state.remainingMs <= 60_000;
  const tokenRemainingMs = screen ? Math.max(0, Date.parse(screen.expiresAt) - now) : 0;

  return {
    state,
    warning,
    now,
    heartbeatMutation,
    doneMutation,
    screen,
    tokenRemainingMs,
    reconnect: () => tokenMutation.mutate(),
    reconnectPending: tokenMutation.isPending,
  };
}

export function BrowserScreenPanelView({
  browserId,
  state,
  warning,
  onActivity,
  onDone,
  donePending,
  screenUrl = null,
  tokenRemainingMs = 0,
  onReconnect,
  reconnectPending = false,
}: {
  browserId: string;
  state: ScreenPanelState;
  warning: boolean;
  onActivity: () => void;
  onDone: () => void;
  donePending: boolean;
  /** Part B: the Guacamole client URL with the signed blob; null until issued. */
  screenUrl?: string | null;
  /** Part B: ms left on the issued blob (an open picture survives it). */
  tokenRemainingMs?: number;
  onReconnect?: () => void;
  reconnectPending?: boolean;
}) {
  if (!state.active) {
    if (state.closedBy === "done") {
      return (
        <p className="text-xs text-muted-foreground" data-testid={`myrmidon-browser-screen-closed-${browserId}`}>
          Screen closed. Bots resumed.
        </p>
      );
    }
    return null;
  }
  return (
    <div
      className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3"
      data-testid={`myrmidon-browser-screen-${browserId}`}
      onPointerMove={onActivity}
      onKeyDown={onActivity}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">Screen session</div>
        <Button size="sm" variant="default" disabled={donePending} onClick={onDone} data-testid={`myrmidon-browser-screen-done-${browserId}`}>
          Done
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">
        Auto-close in {formatDuration(state.remainingMs)} (idle or at the hard limit).
      </div>
      {warning && (
        <p className="text-xs text-amber-500" data-testid={`myrmidon-browser-screen-warning-${browserId}`}>
          The screen closes soon. Press Done when you are finished.
        </p>
      )}
      {screenUrl ? (
        <div className="space-y-1" data-testid={`myrmidon-browser-screen-frame-wrap-${browserId}`}>
          <iframe
            className="h-96 w-full rounded-md border border-border bg-background"
            src={screenUrl}
            title={`Browser screen: ${browserId}`}
            data-testid={`myrmidon-browser-screen-frame-${browserId}`}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Token valid for {formatDuration(tokenRemainingMs)} (the open picture keeps streaming).</span>
            <a
              className="underline"
              href={screenUrl}
              target="_blank"
              rel="noreferrer"
              data-testid={`myrmidon-browser-screen-newtab-${browserId}`}
            >
              Open in a new tab
            </a>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid={`myrmidon-browser-screen-no-frame-${browserId}`}>
          {state.error ? "The screen console could not be reached. Fix the settings, then reconnect." : "Requesting the screen console…"}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {onReconnect && (
          <Button
            size="sm"
            variant="outline"
            disabled={reconnectPending}
            onClick={onReconnect}
            data-testid={`myrmidon-browser-screen-reconnect-${browserId}`}
          >
            Reconnect
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onActivity} data-testid={`myrmidon-browser-screen-activity-${browserId}`}>
          Report activity
        </Button>
      </div>
      {state.error && <p className="text-xs text-destructive">{state.error}</p>}
    </div>
  );
}

export function BrowserScreenPanel({ browser, companyId }: { browser: BrowserConsoleStatus; companyId: string }) {
  const { state, warning, heartbeatMutation, doneMutation, screen, tokenRemainingMs, reconnect, reconnectPending } =
    useScreenSession(browser, companyId);
  return (
    <BrowserScreenPanelView
      browserId={browser.id}
      state={state}
      warning={warning}
      onActivity={() => heartbeatMutation.mutate(true)}
      onDone={() => doneMutation.mutate()}
      donePending={doneMutation.isPending}
      screenUrl={screen?.consoleUrl ?? null}
      tokenRemainingMs={tokenRemainingMs}
      onReconnect={reconnect}
      reconnectPending={reconnectPending}
    />
  );
}

// myrmidon(BROWSER-CONSOLE): Settings → Browsers page.
// The registry (id, display name, egress routes, who is using it), the screen
// session with its timers, the site-data clear and the session journal.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/api/client";
import {
  browsersApi,
  browsersJournalQueryKey,
  browsersQueryKey,
  egressSummary,
  formatDuration,
} from "./browsersApi";
import { bridgeApi, bridgeSettingsQueryKey, type BridgeSettings, type BridgeSigningSettings } from "../connectorPanelApi";
import type { BrowserConsoleStatus } from "@paperclipai/shared/myrmidon-browser-console";
import { BrowserScreenPanel } from "./BrowserScreenPanel";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

function ClearSiteDataForm({ browser, companyId }: { browser: BrowserConsoleStatus; companyId: string }) {
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState<string | null>(null);

  const clearMutation = useMutation({
    mutationFn: () => browsersApi.clearSiteData(browser.id, companyId, domain.trim()),
    onMutate: () => {
      setError(null);
      setCleared(null);
    },
    onSuccess: (result) => {
      setCleared(result.domain);
      setDomain("");
    },
    onError: (err) => setError(readable(err)),
  });

  return (
    <div className="space-y-2" data-testid={`myrmidon-browser-clear-${browser.id}`}>
      <div className="flex gap-2">
        <Input
          placeholder="example.com"
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
          aria-label="Domain to clear"
          data-testid={`myrmidon-browser-clear-domain-${browser.id}`}
          className="max-w-xs"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={clearMutation.isPending || domain.trim().length === 0}
          onClick={() => clearMutation.mutate()}
          data-testid={`myrmidon-browser-clear-button-${browser.id}`}
        >
          Clear site data
        </Button>
      </div>
      {cleared && <p className="text-xs text-muted-foreground">Cleared cookies and storage of {cleared}.</p>}
      {error && <p className="text-xs text-destructive" data-testid={`myrmidon-browser-clear-error-${browser.id}`}>{error}</p>}
    </div>
  );
}

// myrmidon(SETTINGS-UI C-3): the emergency stop of document signing lives in the
// connector panel; this block is its counterpart on the browsers page — it shows
// whether signing is on and turns it back on after a stop, with a confirmation
// step and the policy that is stored right now.
function SigningStatusSection({
  settings,
  loading,
  error,
}: {
  settings: BridgeSettings | null;
  loading: boolean;
  error: string | null;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const signing: BridgeSigningSettings | null = settings?.signing ?? null;

  const reenableMutation = useMutation({
    mutationFn: (current: BridgeSigningSettings) => bridgeApi.updateSettings({ signing: { ...current, enabled: true } }),
    onMutate: () => {
      setActionError(null);
    },
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: bridgeSettingsQueryKey });
    },
    onError: (err) => {
      setConfirming(false);
      setActionError(readable(err));
    },
  });

  return (
    <section className="space-y-2 rounded-md border border-border px-3 py-3" data-testid="myrmidon-signing">
      <h2 className="text-sm font-semibold">Document signing</h2>
      {loading ? (
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-signing-loading">
          Loading signing settings...
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" data-testid="myrmidon-signing-read-error">
          {error}
        </p>
      ) : null}
      {signing ? (
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-signing-state">
          {signing.enabled
            ? "Signing is on. The bridge signs documents under the policy of the connector panel."
            : "Signing is off after an emergency stop: every sign action is refused until it is turned back on here."}
        </p>
      ) : null}
      {signing && !signing.enabled ? (
        confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Turn signing back on with the stored policy?</span>
            <Button
              size="sm"
              disabled={reenableMutation.isPending}
              onClick={() => reenableMutation.mutate(signing)}
              data-testid="myrmidon-signing-reenable-confirm"
            >
              {reenableMutation.isPending ? "Re-enabling..." : "Re-enable signing"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={reenableMutation.isPending}
              onClick={() => setConfirming(false)}
              data-testid="myrmidon-signing-reenable-cancel"
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            onClick={() => {
              setActionError(null);
              setConfirming(true);
            }}
            data-testid="myrmidon-signing-reenable"
          >
            Re-enable signing
          </Button>
        )
      ) : null}
      {actionError ? (
        <p className="text-xs text-destructive" data-testid="myrmidon-signing-reenable-error">
          {actionError}
        </p>
      ) : null}
    </section>
  );
}

function BrowserCard({ browser, companyId }: { browser: BrowserConsoleStatus; companyId: string }) {
  return (
    <li className="space-y-3 rounded-md border border-border px-3 py-3" data-testid={`myrmidon-browser-${browser.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">{browser.displayName}</div>
          <div className="text-xs text-muted-foreground">
            {browser.id} · egress {egressSummary(browser.egress)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {browser.sessionActive ? (
            <span className="text-xs text-muted-foreground" data-testid={`myrmidon-browser-in-use-${browser.id}`}>
              In use by {browser.usedBy}
            </span>
          ) : null}
          <OpenScreenButton browser={browser} companyId={companyId} />
        </div>
      </div>
      <ClearSiteDataForm browser={browser} companyId={companyId} />
      <BrowserScreenPanel browser={browser} companyId={companyId} />
    </li>
  );
}

function OpenScreenButton({ browser, companyId }: { browser: BrowserConsoleStatus; companyId: string }) {
  const [error, setError] = useState<string | null>(null);
  const openMutation = useMutation({
    mutationFn: () => browsersApi.openScreen(browser.id, companyId),
    onError: (err) => setError(readable(err)),
    onSuccess: () => setError(null),
  });

  return (
    <div className="space-y-1">
      <Button
        size="sm"
        disabled={openMutation.isPending || browser.sessionActive}
        onClick={() => openMutation.mutate()}
        data-testid={`myrmidon-browser-open-${browser.id}`}
      >
        Open screen
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function BrowsersSettingsPageView({
  browsers,
  journal,
  companyId,
  loading,
  error,
  signing = null,
  signingLoading = false,
  signingError = null,
}: {
  browsers: BrowserConsoleStatus[];
  journal: Array<{ browserId: string; userId: string; startedAt: string; durationMs: number | null; closedBy: string | null }>;
  companyId: string;
  loading: boolean;
  error: string | null;
  signing?: BridgeSettings | null;
  signingLoading?: boolean;
  signingError?: string | null;
}) {
  const signingSection = <SigningStatusSection settings={signing} loading={signingLoading} error={signingError} />;
  if (loading) {
    return (
      <div className="space-y-6">
        {signingSection}
        <p className="text-sm text-muted-foreground">Loading browsers...</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-6">
        {signingSection}
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }
  if (browsers.length === 0) {
    return (
      <div className="space-y-6">
        {signingSection}
        <p className="text-sm text-muted-foreground" data-testid="myrmidon-browsers-empty">
          No browsers are configured on this instance.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {signingSection}
      <ul className="space-y-3">
        {browsers.map((browser) => (
          <BrowserCard key={browser.id} browser={browser} companyId={companyId} />
        ))}
      </ul>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Session journal</h2>
        {journal.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="myrmidon-browsers-journal-empty">
            No screen sessions yet.
          </p>
        ) : (
          <ul className="space-y-1 text-xs text-muted-foreground" data-testid="myrmidon-browsers-journal">
            {journal.map((entry) => (
              <li key={`${entry.browserId}-${entry.startedAt}`} data-testid="myrmidon-browsers-journal-entry">
                {entry.browserId} · {entry.userId} · {new Date(entry.startedAt).toLocaleString()} ·{" "}
                {entry.durationMs !== null ? formatDuration(entry.durationMs) : "open"} · closed by {entry.closedBy ?? "—"}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function BrowsersSettingsPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Settings", href: "/company/settings" }, { label: "Browsers" }]);
  }, [setBreadcrumbs]);

  const browsersQuery = useQuery({
    queryKey: browsersQueryKey,
    queryFn: () => browsersApi.list(),
    refetchInterval: 15_000,
  });
  const journalQuery = useQuery({
    queryKey: browsersJournalQueryKey,
    queryFn: () => browsersApi.journal(),
  });
  // myrmidon(SETTINGS-UI C-3): the signing policy the bridge applies now; a
  // re-enable writes it back through the same PATCH the connector panel uses.
  const signingQuery = useQuery({
    queryKey: bridgeSettingsQueryKey,
    queryFn: () => bridgeApi.getSettings(),
  });

  const browsers = useMemo(() => browsersQuery.data?.browsers ?? [], [browsersQuery.data]);
  const companyId = selectedCompanyId ?? "";

  // The journal refreshes after a session closes.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: browsersJournalQueryKey });
  }, [browsers.some((browser) => browser.sessionActive), queryClient, browsers]);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Monitor className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Browsers</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Live browser screens for sign-ins. While a screen is open, bots do not drive the browser; sessions close on
          their own after idle or at the hard limit.
        </p>
      </div>
      <BrowsersSettingsPageView
        browsers={browsers}
        journal={(journalQuery.data?.entries ?? []).map((entry) => ({
          browserId: entry.browserId,
          userId: entry.userId,
          startedAt: entry.startedAt,
          durationMs: entry.durationMs,
          closedBy: entry.closedBy,
        }))}
        companyId={companyId}
        loading={browsersQuery.isLoading}
        error={browsersQuery.error ? readable(browsersQuery.error) : null}
        signing={signingQuery.data ?? null}
        signingLoading={signingQuery.isLoading}
        signingError={signingQuery.error ? readable(signingQuery.error) : null}
      />
    </div>
  );
}

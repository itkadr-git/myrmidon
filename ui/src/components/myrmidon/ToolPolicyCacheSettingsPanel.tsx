// Tool gateway policy cache (myrmidon DB-PERF-C-P4): the TTL field of the
// instance setting behind `GET/PATCH /api/myrmidon/tool-policy-cache`.
//
// The operator thinks in seconds; the setting is stored in milliseconds. The
// field accepts 0 (cache off: every gateway decision reads the policy tables
// fresh) up to the server maximum. A saved value applies to the next gateway
// call, no restart; a policy change made through the board is visible to the
// next decision whatever the TTL says.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database } from "lucide-react";
import type { PatchToolPolicyCacheSettings } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toolPolicyCacheApi, toolPolicyCacheQueryKey, type ToolPolicyCacheView } from "./toolPolicyCacheApi";

export interface ToolPolicyCacheDraftParse {
  patch: PatchToolPolicyCacheSettings | null;
  error: string | null;
}

/** Seconds typed by the operator -> the PATCH body (milliseconds), or the reason it is not valid. */
export function parseToolPolicyCacheDraft(raw: string, maxTtlMs: number): ToolPolicyCacheDraftParse {
  const trimmed = raw.trim();
  const seconds = trimmed === "" ? Number.NaN : Number(trimmed);
  const maxSeconds = Math.floor(maxTtlMs / 1000);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > maxSeconds) {
    return { patch: null, error: `Enter a whole number of seconds from 0 to ${maxSeconds}` };
  }
  return { patch: { ttlMs: seconds * 1000 }, error: null };
}

export function ToolPolicyCacheSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: ToolPolicyCacheView | null | undefined;
  onSave: (patch: PatchToolPolicyCacheSettings) => void;
  pending: boolean;
  error: string | null;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const effective = view?.effective;
  const shown = draft ?? (effective ? String(effective.ttlMs / 1000) : "");
  const parsed = effective ? parseToolPolicyCacheDraft(shown, effective.maxTtlMs) : null;
  const dirty = draft !== null;

  return (
    <section className="space-y-4" data-testid="myrmidon-tool-policy-cache">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Tool gateway policy cache</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          The tool gateway keeps one snapshot of a company&apos;s tool policies, profiles, bindings and profile entries
          in memory instead of reading four tables on every call. A change made through the board shows up on the very
          next decision; this window only bounds changes written to the database by other means. Saving applies to the
          next gateway call without a restart. 0 switches the cache off.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {effective ? (
        <div className="space-y-3">
          <div className="max-w-xs space-y-1">
            <Label htmlFor="tool-policy-cache-ttl">Snapshot lifetime, seconds</Label>
            <Input
              id="tool-policy-cache-ttl"
              inputMode="numeric"
              value={shown}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="text-xs text-muted-foreground">
              <span data-testid="tool-policy-cache-current">
                now {effective.cacheEnabled ? `${effective.ttlMs / 1000} s` : "off"}
              </span>
              <span className="ml-2">default {effective.defaultTtlMs / 1000} s</span>
              {dirty && parsed?.error ? (
                <span data-testid="tool-policy-cache-error" className="ml-2 text-destructive">
                  {parsed.error}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground" data-testid="tool-policy-cache-counters">
              This process: {effective.cachedCompanies} compan{effective.cachedCompanies === 1 ? "y" : "ies"} cached,{" "}
              {effective.hits} hits, {effective.misses} misses.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="tool-policy-cache-save"
              disabled={pending || !dirty || !parsed?.patch}
              onClick={() => {
                if (parsed?.patch) onSave(parsed.patch);
              }}
            >
              {pending ? "Saving..." : "Save cache lifetime"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="tool-policy-cache-default"
              disabled={pending || view?.settings.ttlMs === undefined}
              onClick={() => onSave({ ttlMs: null })}
            >
              Use the default
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading tool policy cache settings...</p>
      )}
    </section>
  );
}

export function ToolPolicyCacheSettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: toolPolicyCacheQueryKey,
    queryFn: () => toolPolicyCacheApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: toolPolicyCacheApi.update,
    onMutate: () => setError(null),
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Saving the tool policy cache settings failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: toolPolicyCacheQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error
          ? query.error.message
          : "Failed to load the tool policy cache settings."}
      </div>
    );
  }

  return (
    <ToolPolicyCacheSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}

// myrmidon(1.7 AUTO-UPDATE-SETTINGS, OPE-10186): UI component for manual update check
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import type { CheckUpdatesResponse, UpdateChannel } from "@myrmidon/shared";
import { checkUpdatesApi, checkUpdatesQueryKey } from "./checkUpdatesApi";

export interface CheckUpdatesCardProps {
  className?: string;
  defaultChannel?: UpdateChannel;
}

export function CheckUpdatesCard({
  className = "",
  defaultChannel = "stable",
}: CheckUpdatesCardProps) {
  const [channel, setChannel] = useState<UpdateChannel>(defaultChannel);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: [...checkUpdatesQueryKey, channel],
    queryFn: () => checkUpdatesApi.get(channel),
    retry: false,
    staleTime: 60_000,
  });

  const checkMutation = useMutation({
    mutationFn: (chan: UpdateChannel) =>
      checkUpdatesApi.check({ channel: chan, force: true }),
    onSuccess: (data) => {
      queryClient.setQueryData([...checkUpdatesQueryKey, channel], data);
    },
  });

  const isPending = query.isLoading || checkMutation.isPending;
  const currentData: CheckUpdatesResponse | undefined =
    checkMutation.data ?? query.data;
  const error = checkMutation.error || query.error;

  const handleCheck = () => {
    checkMutation.mutate(channel);
  };

  return (
    <div
      data-testid="myrmidon-check-updates-card"
      className={`rounded-lg border border-border p-4 space-y-3 ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Check for Updates</h3>
          <p className="text-xs text-muted-foreground">
            Query upstream registry and repository for available releases and builds.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="check-updates-channel" className="text-xs text-muted-foreground">
            Channel:
          </label>
          <select
            id="check-updates-channel"
            data-testid="myrmidon-check-updates-channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as UpdateChannel)}
            disabled={isPending}
            className="text-xs bg-background border border-border rounded px-2 py-1"
          >
            <option value="stable">Stable</option>
            <option value="rc">Release Candidate (RC)</option>
            <option value="canary">Canary (Latest Main)</option>
          </select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="myrmidon-check-updates-button"
            disabled={isPending}
            onClick={handleCheck}
          >
            {isPending ? "Checking..." : "Check now"}
          </Button>
        </div>
      </div>

      {error ? (
        <div
          data-testid="myrmidon-check-updates-error"
          className="text-xs text-destructive bg-destructive/10 rounded p-2"
        >
          Failed to check for updates: {error instanceof Error ? error.message : String(error)}
        </div>
      ) : null}

      {currentData ? (
        <div data-testid="myrmidon-check-updates-result" className="text-xs space-y-1 pt-1 border-t border-border/50">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Status:</span>
            <span
              data-testid="myrmidon-check-updates-status"
              className={
                currentData.updateAvailable
                  ? "font-medium text-primary"
                  : "text-muted-foreground"
              }
            >
              {currentData.updateAvailable ? (
                <>
                  Update available:{" "}
                  <span className="font-mono font-semibold">
                    {currentData.latestVersion ?? currentData.latestCommit?.slice(0, 7)}
                  </span>
                </>
              ) : (
                "You are running the latest version."
              )}
            </span>
          </div>

          {currentData.latestVersion ? (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Latest release:</span>
              <span className="font-mono">{currentData.latestVersion}</span>
            </div>
          ) : null}

          {currentData.releaseUrl ? (
            <div className="pt-1">
              <a
                href={currentData.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground text-xs"
              >
                View release notes
              </a>
            </div>
          ) : null}

          <div className="text-muted-foreground text-xs pt-1">
            Checked at {new Date(currentData.checkedAt).toLocaleTimeString()}
          </div>
        </div>
      ) : null}
    </div>
  );
}

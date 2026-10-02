// myrmidon(TRACING-HEALTH): the "LLM tracing" status card.
//
// One card in the Fleet/Myrmidon settings surfaces of the company: green dot
// + summary when tracing delivers, red dot + the failing leg's note when it
// does not, and "not enabled" with the setting names when the instance has
// not configured the probes. The card is read-only — the operator fixes the
// pipeline (Langfuse v4 ClickHouse `events_core`, the LiteLLM callbacks),
// the board only reports. The red state also raises an operator attention
// card (server side); this surface is the glanceable summary.
//
// The layout reuses the FleetConsolePanel card style (border, header with
// icon + title, muted notes), tokens only — no raw colors or sizes.

import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import {
  formatWindowLabel,
  tracingHealthApi,
  tracingHealthKey,
  type TracingHealthCard,
} from "./tracingHealthApi";

export interface TracingHealthCardViewProps {
  card: TracingHealthCard | null;
  loading: boolean;
  error: string | null;
}

export function TracingHealthCardView({ card, loading, error }: TracingHealthCardViewProps) {
  const status = card?.status ?? "ok";
  const red = status === "red" && card?.enabled !== false;
  return (
    <div className="rounded-lg border border-border bg-background" data-testid="myrmidon-tracing-health-card">
      <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-base font-medium">LLM tracing</span>
        </div>
        <div className="flex items-center gap-2" data-testid="myrmidon-tracing-health-status">
          <span
            aria-hidden="true"
            className={red ? "h-2 w-2 rounded-full bg-destructive" : "h-2 w-2 rounded-full bg-emerald-500"}
          />
          <span className="text-xs font-medium text-muted-foreground">
            {card && card.enabled === false ? "not enabled" : red ? "red" : "ok"}
          </span>
        </div>
      </div>
      <div className="px-5 pb-5 pt-1 space-y-1.5">
        {loading ? (
          <p className="text-sm text-muted-foreground" data-testid="myrmidon-tracing-health-loading">
            Loading tracing health...
          </p>
        ) : error ? (
          <p className="text-sm text-destructive" data-testid="myrmidon-tracing-health-error">
            {error}
          </p>
        ) : card ? (
          <>
            <p
              className={red ? "text-sm text-destructive" : "text-sm text-foreground"}
              data-testid="myrmidon-tracing-health-summary"
            >
              {card.summary}
            </p>
            {card.enabled && (
              <ul className="text-xs text-muted-foreground space-y-0.5" data-testid="myrmidon-tracing-health-checks">
                <li>{card.checks.gatewayTraffic.note}</li>
                <li>{card.checks.eventsCore.note}</li>
                <li>{card.checks.callbackErrors.note}</li>
              </ul>
            )}
            <p className="text-xs text-muted-foreground/70">
              window {formatWindowLabel(card.windowMs)} · checked {new Date(card.checkedAt).toLocaleTimeString()}
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function TracingHealthCard() {
  const { selectedCompanyId } = useCompany();
  const { data, isLoading, error } = useQuery({
    queryKey: tracingHealthKey(selectedCompanyId ?? "none"),
    queryFn: () => tracingHealthApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 60_000,
    retry: false,
  });
  return (
    <TracingHealthCardView
      card={data ?? null}
      loading={isLoading}
      error={error instanceof Error ? error.message : null}
    />
  );
}

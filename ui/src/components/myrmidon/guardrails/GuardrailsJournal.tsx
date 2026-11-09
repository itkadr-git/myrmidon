// myrmidon(1.6.6 OPE-9650): the firing journal block of the "Guardrails"
// screen — newest guardrail events with equality filters (rule, mode, level,
// agent, severity, surface, runId) and offset-based pagination. Owns its own
// query; the container passes companyId, agent list, and the filter state.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/api/client";
import { guardrailsApi, guardrailsEventsQueryKey, type GuardrailEventFilters } from "./guardrailsApi";
import type { GuardrailsAgentRow } from "./GuardrailsScreen";

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

const ANY = "__any__";

export function GuardrailsJournal({
  companyId,
  agents,
  filters,
  onFiltersChange,
}: {
  companyId: string;
  agents?: GuardrailsAgentRow[];
  filters: GuardrailEventFilters;
  onFiltersChange: (filters: GuardrailEventFilters) => void;
}) {
  const { t } = useTranslation();
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  const page = Math.floor(offset / limit) + 1;

  const eventsQuery = useQuery({
    queryKey: guardrailsEventsQueryKey(companyId, filters),
    queryFn: () => guardrailsApi.listEvents(companyId, filters),
    enabled: companyId.length > 0,
    retry: false,
  });

  const agentsMap = useMemo(() => {
    const map = new Map<string, string>();
    if (agents) {
      for (const a of agents) {
        map.set(a.agentId, a.name);
      }
    }
    return map;
  }, [agents]);

  const severityClass = (severity: string): string => {
    if (severity === "error") return "font-medium text-destructive";
    if (severity === "warn") return "text-muted-foreground";
    return "text-muted-foreground";
  };

  const count = eventsQuery.data?.events.length ?? 0;
  const hasMore = count >= limit;

  return (
    <section className="space-y-2" data-testid="myrmidon-guardrails-journal">
      <h3 className="text-sm font-medium">{t("guardrails.journalTitle")}</h3>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="guardrails-journal-rule">{t("guardrails.filterRule")}</Label>
          <Select
            value={filters.rule ?? filters.kind ?? ANY}
            onValueChange={(value) =>
              onFiltersChange({
                ...filters,
                rule: value === ANY ? undefined : value,
                kind: value === ANY ? undefined : value,
                offset: 0,
              })
            }
          >
            <SelectTrigger id="guardrails-journal-rule" data-testid="guardrails-journal-rule" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t("guardrails.filterAny")}</SelectItem>
              <SelectItem value="secret">{t("guardrails.rule.secret")}</SelectItem>
              <SelectItem value="pii">{t("guardrails.rule.pii")}</SelectItem>
              <SelectItem value="injection">{t("guardrails.rule.injection")}</SelectItem>
            </SelectContent>
          </Select>
          {/* Legacy id hook for backward compatibility with existing tests */}
          <span id="guardrails-journal-kind" className="sr-only" aria-hidden="true" />
        </div>

        <div className="space-y-1">
          <Label htmlFor="guardrails-journal-mode">{t("guardrails.filterMode")}</Label>
          <Select
            value={filters.mode ?? ANY}
            onValueChange={(value) =>
              onFiltersChange({
                ...filters,
                mode: value === ANY ? undefined : value,
                offset: 0,
              })
            }
          >
            <SelectTrigger id="guardrails-journal-mode" data-testid="guardrails-journal-mode" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t("guardrails.filterAny")}</SelectItem>
              <SelectItem value="flag">{t("guardrails.mode.flag")}</SelectItem>
              <SelectItem value="mask">{t("guardrails.mode.mask")}</SelectItem>
              <SelectItem value="block">{t("guardrails.mode.block")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="guardrails-journal-level">{t("guardrails.filterLevel")}</Label>
          <Select
            value={filters.level ?? ANY}
            onValueChange={(value) =>
              onFiltersChange({
                ...filters,
                level: value === ANY ? undefined : value,
                offset: 0,
              })
            }
          >
            <SelectTrigger id="guardrails-journal-level" data-testid="guardrails-journal-level" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t("guardrails.filterAny")}</SelectItem>
              <SelectItem value="run">{t("guardrails.level.run")}</SelectItem>
              <SelectItem value="agent">{t("guardrails.level.agent")}</SelectItem>
              <SelectItem value="caste">{t("guardrails.level.caste")}</SelectItem>
              <SelectItem value="company">{t("guardrails.level.company")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="guardrails-journal-agent">{t("guardrails.filterAgent")}</Label>
          <Select
            value={filters.agentId ?? filters.agent ?? ANY}
            onValueChange={(value) =>
              onFiltersChange({
                ...filters,
                agentId: value === ANY ? undefined : value,
                agent: value === ANY ? undefined : value,
                offset: 0,
              })
            }
          >
            <SelectTrigger id="guardrails-journal-agent" data-testid="guardrails-journal-agent" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t("guardrails.filterAny")}</SelectItem>
              {agents?.map((agent) => (
                <SelectItem key={agent.agentId} value={agent.agentId}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="guardrails-journal-severity">{t("guardrails.filterSeverity")}</Label>
          <Select
            value={filters.severity ?? ANY}
            onValueChange={(value) =>
              onFiltersChange({
                ...filters,
                severity: value === ANY ? undefined : value,
                offset: 0,
              })
            }
          >
            <SelectTrigger id="guardrails-journal-severity" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t("guardrails.filterAny")}</SelectItem>
              <SelectItem value="info">info</SelectItem>
              <SelectItem value="warn">warn</SelectItem>
              <SelectItem value="error">error</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="guardrails-journal-run">{t("guardrails.filterRunId")}</Label>
          <Input
            id="guardrails-journal-run"
            className="w-48"
            placeholder={t("guardrails.filterAny")}
            value={filters.runId ?? ""}
            onChange={(event) =>
              onFiltersChange({
                ...filters,
                runId: event.target.value.trim() || undefined,
                offset: 0,
              })
            }
          />
        </div>
      </div>

      {eventsQuery.isError ? (
        <p className="text-sm text-destructive" data-testid="guardrails-journal-error">
          {eventsQuery.error instanceof ApiError
            ? eventsQuery.error.message
            : t("guardrails.journalError")}
        </p>
      ) : null}

      {eventsQuery.data ? (
        eventsQuery.data.events.length > 0 ? (
          <>
            <table className="w-full text-sm" data-testid="guardrails-journal-table">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-4 font-medium">{t("guardrails.colTime")}</th>
                  <th className="py-1 pr-4 font-medium">{t("guardrails.colRule")}</th>
                  <th className="py-1 pr-4 font-medium">{t("guardrails.colMode")}</th>
                  <th className="py-1 pr-4 font-medium">{t("guardrails.colLevel")}</th>
                  <th className="py-1 pr-4 font-medium">{t("guardrails.colAgent")}</th>
                  <th className="py-1 pr-4 font-medium">{t("guardrails.colDecision")}</th>
                  <th className="py-1 pr-4 font-medium">{t("guardrails.colSurface")}</th>
                  <th className="py-1 pr-4 font-medium">{t("guardrails.filterSeverity")}</th>
                  <th className="py-1 pr-4 font-medium">{t("guardrails.colRun")}</th>
                  <th className="py-1 pr-4 font-medium">{t("guardrails.colSnippet")}</th>
                </tr>
              </thead>
              <tbody>
                {eventsQuery.data.events.map((event) => {
                  const agentId = event.agentId ?? event.agent;
                  const agentName = agentId ? agentsMap.get(agentId) ?? agentId : "—";
                  return (
                    <tr key={event.id} className="border-t border-border">
                      <td className="py-1.5 pr-4 whitespace-nowrap">{formatTime(event.occurredAt ?? event.ts ?? "")}</td>
                      <td className="py-1.5 pr-4">{event.rule ?? event.kind ?? "—"}</td>
                      <td className="py-1.5 pr-4">{event.mode ?? "—"}</td>
                      <td className="py-1.5 pr-4">{event.level ?? "—"}</td>
                      <td className="py-1.5 pr-4">{agentName}</td>
                      <td className="py-1.5 pr-4 font-mono text-xs">{event.decision ?? "—"}</td>
                      <td className="py-1.5 pr-4">{event.surface}</td>
                      <td className={`py-1.5 pr-4 ${severityClass(event.severity)}`}>{event.severity}</td>
                      <td className="py-1.5 pr-4 font-mono text-xs">{event.runId ?? "—"}</td>
                      <td className="py-1.5 pr-4 max-w-md truncate" title={event.snippet ?? undefined}>
                        {event.snippet ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="flex items-center justify-between pt-2">
              <div className="text-xs text-muted-foreground" data-testid="guardrails-journal-page">
                {t("guardrails.paginationPage", { page })}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="guardrails-journal-prev"
                  disabled={offset <= 0}
                  onClick={() =>
                    onFiltersChange({
                      ...filters,
                      offset: Math.max(0, offset - limit),
                    })
                  }
                >
                  {t("guardrails.paginationPrev")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="guardrails-journal-next"
                  disabled={!hasMore}
                  onClick={() =>
                    onFiltersChange({
                      ...filters,
                      offset: offset + limit,
                    })
                  }
                >
                  {t("guardrails.paginationNext")}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="guardrails-journal-empty">
            {t("guardrails.journalEmpty")}
          </p>
        )
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="guardrails-journal-loading">
          {t("guardrails.journalLoading")}
        </p>
      )}
    </section>
  );
}

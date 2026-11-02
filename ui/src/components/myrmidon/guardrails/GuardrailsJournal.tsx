// myrmidon(1.7-GRD-MODES): the firing journal block of the "Guardrails"
// screen — newest guardrail events with equality filters (kind, severity,
// surface, runId). Owns its own query; the container passes the company and
// the filter state.
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
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

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

const ANY = "__any__";

export function GuardrailsJournal({
  companyId,
  filters,
  onFiltersChange,
}: {
  companyId: string;
  filters: GuardrailEventFilters;
  onFiltersChange: (filters: GuardrailEventFilters) => void;
}) {
  const { t } = useTranslation();
  const eventsQuery = useQuery({
    queryKey: guardrailsEventsQueryKey(companyId, filters),
    queryFn: () => guardrailsApi.listEvents(companyId, filters),
    enabled: companyId.length > 0,
    retry: false,
  });

  const severityClass = (severity: string): string => {
    if (severity === "error") return "font-medium text-destructive";
    if (severity === "warn") return "text-muted-foreground";
    return "text-muted-foreground";
  };

  return (
    <section className="space-y-2" data-testid="myrmidon-guardrails-journal">
      <h3 className="text-sm font-medium">{t("guardrails.journalTitle")}</h3>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="guardrails-journal-kind">{t("guardrails.filterKind")}</Label>
          <Select
            value={filters.kind ?? ANY}
            onValueChange={(value) =>
              onFiltersChange({ ...filters, kind: value === ANY ? undefined : value })
            }
          >
            <SelectTrigger id="guardrails-journal-kind" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t("guardrails.filterAny")}</SelectItem>
              <SelectItem value="secret">{t("guardrails.rule.secret")}</SelectItem>
              <SelectItem value="pii">{t("guardrails.rule.pii")}</SelectItem>
              <SelectItem value="injection">{t("guardrails.rule.injection")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="guardrails-journal-severity">{t("guardrails.filterSeverity")}</Label>
          <Select
            value={filters.severity ?? ANY}
            onValueChange={(value) =>
              onFiltersChange({ ...filters, severity: value === ANY ? undefined : value })
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
          <table className="w-full text-sm" data-testid="guardrails-journal-table">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-4 font-medium">{t("guardrails.colTime")}</th>
                <th className="py-1 pr-4 font-medium">{t("guardrails.filterKind")}</th>
                <th className="py-1 pr-4 font-medium">{t("guardrails.colSurface")}</th>
                <th className="py-1 pr-4 font-medium">{t("guardrails.filterSeverity")}</th>
                <th className="py-1 pr-4 font-medium">{t("guardrails.colRun")}</th>
                <th className="py-1 pr-4 font-medium">{t("guardrails.colSnippet")}</th>
              </tr>
            </thead>
            <tbody>
              {eventsQuery.data.events.map((event) => (
                <tr key={event.id} className="border-t border-border">
                  <td className="py-1.5 pr-4 whitespace-nowrap">{formatTime(event.occurredAt)}</td>
                  <td className="py-1.5 pr-4">{event.kind}</td>
                  <td className="py-1.5 pr-4">{event.surface}</td>
                  <td className={`py-1.5 pr-4 ${severityClass(event.severity)}`}>{event.severity}</td>
                  <td className="py-1.5 pr-4 font-mono text-xs">{event.runId ?? "—"}</td>
                  <td className="py-1.5 pr-4 max-w-md truncate" title={event.snippet ?? undefined}>
                    {event.snippet ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

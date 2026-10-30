import { KeyRound, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { useTranslation } from "@/i18n";
import { accessKindLabel } from "./accessKindLabel";
import {
  ACCESS_KIND_ORDER,
  ALL_GRANTEES,
  formatAccessMoment,
  grantedAgents,
  hostNamesFor,
  usedByBindings,
  type AccessHost,
  type AccessKind,
  type AccessListFilters,
  type AccessRecord,
} from "./accessHubApi";

export interface AccessAgentOption {
  id: string;
  name: string;
}

export interface AccessListViewProps {
  records: AccessRecord[];
  hosts: AccessHost[];
  agents: AccessAgentOption[];
  filters: AccessListFilters;
  loading?: boolean;
  error?: string | null;
  onFiltersChange: (next: AccessListFilters) => void;
  onSelect: (secretId: string) => void;
  onCreate: () => void;
}

function KindBadge({ kind }: { kind: AccessKind }) {
  const { t } = useTranslation();
  return (
    <Badge variant="outline" data-testid="access-hub-kind-badge">
      {accessKindLabel(t, kind)}
    </Badge>
  );
}

function GranteesCell({ record }: { record: AccessRecord }) {
  const { t } = useTranslation();
  const grantees = grantedAgents(record);
  if (grantees.length === 0) return <span className="text-muted-foreground">{t("area.access-hub.access-list.nobody")}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {grantees.map((binding) => (
        <Badge key={binding.targetId} variant="secondary">
          {binding.targetName}
        </Badge>
      ))}
    </span>
  );
}

function UsageCell({ record, hosts }: { record: AccessRecord; hosts: AccessHost[] }) {
  const { t } = useTranslation();
  const usages = usedByBindings(record);
  const hostNames = hostNamesFor(record, hosts);
  if (usages.length === 0 && hostNames.length === 0) {
    return <span className="text-muted-foreground">{t("area.access-hub.access-list.unused")}</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      {usages.map((binding) => (
        <span key={`${binding.targetType}:${binding.targetId}`} className="min-w-0 truncate" title={binding.configPath ?? undefined}>
          {binding.targetName}
          <span className="text-muted-foreground"> · {binding.targetType}</span>
        </span>
      ))}
      {hostNames.length > 0 ? (
        <span className="min-w-0 truncate text-muted-foreground">{t("area.access-hub.access-list.hosts", { names: hostNames.join(", ") })}</span>
      ) : null}
    </span>
  );
}

/**
 * The access hub list. Renders only the fields the API is allowed to report —
 * there is no value column and none may be added here (see the secrecy guard
 * test next to this file).
 */
export function AccessListView({
  records,
  hosts,
  agents,
  filters,
  loading = false,
  error = null,
  onFiltersChange,
  onSelect,
  onCreate,
}: AccessListViewProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3" data-testid="access-hub-list">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-48 sm:w-64">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.search}
            onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
            placeholder={t("area.access-hub.access-list.searchPlaceholder")}
            aria-label={t("area.access-hub.access-list.searchLabel")}
            className="pl-7 text-xs sm:text-sm"
          />
        </div>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {t("area.access-hub.access-list.type")}
          <select
            value={filters.kind}
            aria-label={t("area.access-hub.access-list.filterByType")}
            onChange={(event) =>
              onFiltersChange({ ...filters, kind: event.target.value as AccessKind | "all" })
            }
            className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          >
            <option value="all">{t("area.access-hub.access-list.allTypes")}</option>
            {ACCESS_KIND_ORDER.map((kind) => (
              <option key={kind} value={kind}>
                {accessKindLabel(t, kind)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {t("area.access-hub.access-list.agent")}
          <select
            value={filters.agent}
            aria-label={t("area.access-hub.access-list.filterByAgent")}
            onChange={(event) => onFiltersChange({ ...filters, agent: event.target.value })}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          >
            <option value={ALL_GRANTEES}>{t("area.access-hub.access-list.allAgents")}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" className="ml-auto" onClick={onCreate}>
          <Plus className="mr-1 h-3.5 w-3.5" /> {t("area.access-hub.access-list.newAccess")}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {!loading && records.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          message={t("area.access-hub.access-list.emptyMessage")}
          action={t("area.access-hub.access-list.newAccess")}
          onAction={onCreate}
        />
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-0 border-collapse text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">{t("area.access-hub.access-list.columns.name")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t("area.access-hub.access-list.columns.type")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t("area.access-hub.access-list.columns.grantedTo")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t("area.access-hub.access-list.columns.usedBy")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t("area.access-hub.access-list.columns.created")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t("area.access-hub.access-list.columns.rotated")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t("area.access-hub.access-list.columns.version")}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr
                  key={record.secretId}
                  data-testid="access-hub-row"
                  className="border-b border-border/60 align-top hover:bg-accent/40"
                >
                  <td className="py-2.5 pr-3">
                    <button
                      type="button"
                      onClick={() => onSelect(record.secretId)}
                      className="min-w-0 max-w-72 truncate text-left font-medium text-foreground hover:underline"
                    >
                      {record.name}
                    </button>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{record.key}</span>
                  </td>
                  <td className="py-2.5 pr-3">
                    <KindBadge kind={record.kind} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <GranteesCell record={record} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <UsageCell record={record} hosts={hosts} />
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-xs text-muted-foreground">
                    {formatAccessMoment(record.createdAt)}
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-xs text-muted-foreground">
                    {formatAccessMoment(record.lastRotatedAt)}
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-xs text-muted-foreground">v{record.latestVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
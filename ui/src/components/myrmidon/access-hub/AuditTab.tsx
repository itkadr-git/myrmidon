import { ScrollText } from "lucide-react";
import { useTranslation } from "@/i18n";
import { EmptyState } from "@/components/EmptyState";
import {
  DEFAULT_AUDIT_LIMIT,
  formatAccessMoment,
  latestAuditEntries,
  type AccessAuditEntry,
} from "./accessHubApi";

export interface AuditTabViewProps {
  entries: AccessAuditEntry[];
  /** How many of the newest journal lines to show. */
  limit?: number;
  loading?: boolean;
  error?: string | null;
}

/**
 * The journal: who touched which access, when, and which version came out of
 * it. Journal lines carry names and versions — never values.
 */
export function AuditTabView({ entries, limit = DEFAULT_AUDIT_LIMIT, loading = false, error = null }: AuditTabViewProps) {
  const { t } = useTranslation();
  const visible = latestAuditEntries(entries, limit);

  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }

  if (!loading && visible.length === 0) {
    return (
      <EmptyState
        icon={ScrollText}
        message={t("area.access-hub.audit-tab.emptyMessage")}
      />
    );
  }

  return (
    <div className="min-w-0 overflow-x-auto" data-testid="access-hub-audit">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pr-3 font-medium">{t("area.access-hub.audit-tab.columns.when")}</th>
            <th scope="col" className="py-2 pr-3 font-medium">{t("area.access-hub.audit-tab.columns.actor")}</th>
            <th scope="col" className="py-2 pr-3 font-medium">{t("area.access-hub.audit-tab.columns.action")}</th>
            <th scope="col" className="py-2 pr-3 font-medium">{t("area.access-hub.audit-tab.columns.access")}</th>
            <th scope="col" className="py-2 pr-3 font-medium">{t("area.access-hub.audit-tab.columns.target")}</th>
            <th scope="col" className="py-2 pr-3 font-medium">{t("area.access-hub.audit-tab.columns.version")}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((entry, index) => (
            <tr
              key={`${entry.at}:${entry.actor}:${entry.action}:${entry.secretName}:${index}`}
              data-testid="access-hub-audit-row"
              className="border-b border-border/60"
            >
              <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{formatAccessMoment(entry.at)}</td>
              <td className="py-2 pr-3">{entry.actor}</td>
              <td className="py-2 pr-3">{entry.action}</td>
              <td className="py-2 pr-3">{entry.secretName}</td>
              <td className="py-2 pr-3 text-muted-foreground">{entry.targetName ?? "—"}</td>
              <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                {typeof entry.version === "number" ? `v${entry.version}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { Bot, User, Cog, ChevronDown, ListFilter } from "lucide-react";
import type { CaseEvent, CaseEventKind } from "@/api/cases";
import { Button } from "@/components/ui/button";
import { StatusIcon } from "@/components/StatusIcon";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, relativeTime } from "@/lib/utils";
import { i18n, useTranslation } from "@/i18n";

function eventLabels(): Record<CaseEventKind, string> {
  return {
    created: i18n.t("area.pipelines-cases.case-activity-feed.event.created"),
    updated: i18n.t("area.pipelines-cases.case-activity-feed.event.updated"),
    fields_changed: i18n.t("area.pipelines-cases.case-activity-feed.event.fieldsChanged"),
    status_changed: i18n.t("area.pipelines-cases.case-activity-feed.event.statusChanged"),
    issue_linked: i18n.t("area.pipelines-cases.case-activity-feed.event.issueLinked"),
    issue_unlinked: i18n.t("area.pipelines-cases.case-activity-feed.event.issueUnlinked"),
    document_revised: i18n.t("area.pipelines-cases.case-activity-feed.event.documentRevised"),
    child_linked: i18n.t("area.pipelines-cases.case-activity-feed.event.childLinked"),
    attachment_added: i18n.t("area.pipelines-cases.case-activity-feed.event.attachmentAdded"),
    label_added: i18n.t("area.pipelines-cases.case-activity-feed.event.labelAdded"),
    label_removed: i18n.t("area.pipelines-cases.case-activity-feed.event.labelRemoved"),
  };
}

/** Human label for the actor, preferring the resolved agent name. */
function actorLabel(event: CaseEvent): string {
  if (event.actorType === "agent") return event.actorAgentName ?? i18n.t("area.pipelines-cases.case-activity-feed.actorAgent");
  if (event.actorType === "user") return i18n.t("area.pipelines-cases.case-activity-feed.actorUser");
  return i18n.t("area.pipelines-cases.case-activity-feed.actorSystem");
}

function ActorIcon({ event }: { event: CaseEvent }) {
  const Icon = event.actorType === "agent" ? Bot : event.actorType === "user" ? User : Cog;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}

function issueRelationLabel(event: CaseEvent): string {
  return event.kind === "issue_linked" || event.kind === "issue_unlinked" ? i18n.t("area.pipelines-cases.case-activity-feed.relationIssue") : i18n.t("area.pipelines-cases.case-activity-feed.relationVia");
}

/** One event with actor + run→issue attribution (P4 §1). */
export function CaseEventRow({ event, compact = false }: { event: CaseEvent; compact?: boolean }) {
  useTranslation();
  const labels = eventLabels();
  const detail =
    event.kind === "status_changed" && event.payload
      ? `${(event.payload.previousStatus as string) ?? "?"} → ${(event.payload.status as string) ?? "?"}`
      : "";
  return (
    <div className={cn("flex items-start gap-2 text-xs", compact ? "py-1.5" : "py-2")}>
      <span className="mt-1"><ActorIcon event={event} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="font-medium">{labels[event.kind] ?? event.kind}</span>
          {detail && <span className="text-muted-foreground">· {detail}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
          <span>{actorLabel(event)}</span>
          {event.issue && (
            <>
              <span aria-hidden>·</span>
              <span>{issueRelationLabel(event)}</span>
              <Link
                to={`/issues/${event.issue.identifier}`}
                className="inline-flex min-w-0 items-center gap-1 text-foreground/80 hover:underline"
                title={event.issue.title}
              >
                <StatusIcon status={event.issue.status} size="sm" />
                <span className="shrink-0 font-mono">{event.issue.identifier}</span>
                <span className="min-w-0 truncate">{event.issue.title}</span>
              </Link>
            </>
          )}
          <span aria-hidden>·</span>
          <span>{relativeTime(event.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

/** The full activity feed with kind filters (detail-page Activity tab). */
export function CaseActivityFeed({ events }: { events: CaseEvent[] }) {
  const { t } = useTranslation();
  const labels = eventLabels();
  const [active, setActive] = useState<Set<CaseEventKind>>(new Set());

  // Only offer filters for kinds actually present, in first-seen order.
  const presentKinds = useMemo(() => {
    const seen: CaseEventKind[] = [];
    for (const e of events) if (!seen.includes(e.kind)) seen.push(e.kind);
    return seen;
  }, [events]);

  const filtered = useMemo(
    () => (active.size === 0 ? events : events.filter((e) => active.has(e.kind))),
    [events, active],
  );

  function toggle(kind: CaseEventKind) {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  const filterLabel = active.size === 0
    ? t("area.pipelines-cases.case-activity-feed.allActivity")
    : active.size === 1
      ? labels[[...active][0]!] ?? [...active][0]!
      : t("area.pipelines-cases.case-activity-feed.filtersCount", { count: active.size });

  if (events.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{t("area.pipelines-cases.case-activity-feed.emptyTitle")}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("area.pipelines-cases.case-activity-feed.eventsShown", { shown: filtered.length, total: events.length })}
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <ListFilter className="h-3.5 w-3.5" />
              {filterLabel}
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>{t("area.pipelines-cases.case-activity-feed.filterLabel")}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setActive(new Set())}>
              {t("area.pipelines-cases.case-activity-feed.allActivity")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {presentKinds.map((kind) => (
              <DropdownMenuCheckboxItem
                key={kind}
                checked={active.has(kind)}
                onCheckedChange={() => toggle(kind)}
              >
                {labels[kind] ?? kind}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("area.pipelines-cases.case-activity-feed.noMatch")}</p>
      ) : (
        <div className="divide-y divide-border">
          {filtered.map((event) => (
            <CaseEventRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}

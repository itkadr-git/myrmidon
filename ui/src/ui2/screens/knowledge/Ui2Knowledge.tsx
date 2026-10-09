// ui/src/ui2/screens/knowledge/Ui2Knowledge.tsx
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-4): the Knowledge screen in the new shell,
// behind `enableMyrmidonUi2` — "человек читает и одобряет без плагина".
//
// Layout follows knowledge-architecture §3.9: the tree of spaces on the left,
// the page on the right, then the panel of sources (edges to tasks / pull
// requests / decisions), then revisions with a line diff and the rollback verb
// gated by `approver_kind` (the a/o marker of the epic).
//
// The screen is a reader: search, open, compare, roll back. The editor and the
// frontmatter form are not part of K-4.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { Link, useParams } from "@/lib/router";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import type { Ui2MessageKey } from "../../i18n/locales";
import {
  Ui2EmptyStateView,
  Ui2ErrorState,
  Ui2SkeletonRows,
} from "../../components/ui2StateViews";
import { Ui2Page, Ui2Section, Ui2StatusDot } from "../../components/ui2Primitives";
import { knowledgeApi, knowledgeQueryKeys } from "./knowledgeApi";
import type { KnowledgeSearchMode } from "./knowledgeApi";
import {
  buildKnowledgeTree,
  diffKnowledgeRevisions,
  isKnowledgeReviewDue,
  knowledgeApproverLabelKey,
  knowledgeDiffChangeCount,
  knowledgeHref,
  knowledgeLinkHref,
  knowledgeLinkLabel,
  knowledgeSourceLink,
  knowledgeStatusTone,
  knowledgeWriteGate,
  parseKnowledgeBody,
} from "./knowledgeModel";
import type {
  KnowledgeBodySegment,
  KnowledgeDiffLine,
  KnowledgeItemDetail,
  KnowledgeItemSummary,
  KnowledgeRevisionSummary,
  KnowledgeSourceRef,
  KnowledgeTreeNode,
} from "./knowledgeModel";

type MessageKey = Ui2MessageKey;
type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

const WHEN: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "short" };

/** Rendered dates stay raw when the payload does not carry a valid one. */
function formatWhen(value: string | null | undefined): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString(undefined, WHEN);
}

function sourceKindKey(kind: string): MessageKey {
  switch ((kind ?? "").toLowerCase()) {
    case "task":
      return "ui2.knowledge.source.kind.task";
    case "issue":
      return "ui2.knowledge.source.kind.issue";
    case "pr":
    case "pull_request":
      return "ui2.knowledge.source.kind.pr";
    case "decision":
      return "ui2.knowledge.source.kind.decision";
    case "run":
      return "ui2.knowledge.source.kind.run";
    case "url":
      return "ui2.knowledge.source.kind.url";
    default:
      return "ui2.knowledge.source.kind.other";
  }
}

/**
 * The write verb of an item is gated on the facade's `approver_kind` /
 * `verdict` pair; the summary type stays minimal, so read them defensively.
 */
function itemGate(item: KnowledgeItemDetail) {
  const raw = item as unknown as {
    approverKind?: unknown;
    approver_kind?: unknown;
    verdict?: unknown;
  };
  return knowledgeWriteGate({
    approverKind: raw.approverKind ?? raw.approver_kind,
    verdict: raw.verdict,
  });
}

function revisionKey(summary: KnowledgeItemSummary): string {
  return `${summary.spaceKey}/${summary.slug}`;
}

function BodySegments({
  segments,
  spaceKey,
}: {
  segments: KnowledgeBodySegment[];
  spaceKey: string;
}) {
  return (
    <div className="ui2-knowledge-body flex flex-col gap-2 text-sm leading-relaxed whitespace-pre-wrap">
      {segments.map((segment, index) =>
        segment.type === "link" ? (
          <Link
            key={`link-${index}`}
            to={knowledgeLinkHref(segment, spaceKey)}
            className="ui2-knowledge-link text-primary underline underline-offset-2"
          >
            {knowledgeLinkLabel(segment)}
          </Link>
        ) : (
          <span key={`text-${index}`} className="ui2-knowledge-text">
            {segment.text}
          </span>
        ),
      )}
    </div>
  );
}

function SourceRow({ source, t }: { source: KnowledgeSourceRef; t: Translate }) {
  const link = knowledgeSourceLink(source);
  const label = source.label ?? source.ref;
  const kind = t(sourceKindKey(source.kind));
  if (!link) {
    return (
      <li className="ui2-knowledge-source flex items-center gap-2 text-xs text-muted-foreground">
        <span className="ui2-knowledge-source-kind rounded-sm border border-border px-1.5 py-0.5">
          {kind}
        </span>
        <span className="ui2-knowledge-source-label">{label}</span>
        <span className="ui2-knowledge-source-untargeted">{t("ui2.knowledge.source.untargeted")}</span>
      </li>
    );
  }
  return (
    <li className="ui2-knowledge-source flex items-center gap-2 text-xs">
      <span className="ui2-knowledge-source-kind rounded-sm border border-border px-1.5 py-0.5 text-muted-foreground">
        {kind}
      </span>
      {link.kind === "internal" ? (
        <Link className="ui2-knowledge-source-link text-primary underline underline-offset-2" to={link.to}>
          {label}
        </Link>
      ) : (
        <a
          className="ui2-knowledge-source-link text-primary underline underline-offset-2"
          href={link.href}
          target="_blank"
          rel="noreferrer"
        >
          {label}
        </a>
      )}
    </li>
  );
}

function SourcePanel({
  title,
  sources,
  emptyLabel,
  t,
}: {
  title: string;
  sources: KnowledgeSourceRef[] | undefined;
  emptyLabel: string;
  t: Translate;
}) {
  const rows = sources ?? [];
  return (
    <Ui2Section title={title}>
      {rows.length === 0 ? (
        <p className="ui2-knowledge-sources-empty text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="ui2-knowledge-sources flex flex-col gap-1">
          {rows.map((source, index) => (
            <SourceRow key={`${source.kind}-${source.ref}-${index}`} source={source} t={t} />
          ))}
        </ul>
      )}
    </Ui2Section>
  );
}

function DiffRow({ line, t }: { line: KnowledgeDiffLine; t: Translate }) {
  const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
  const label =
    line.kind === "add"
      ? t("ui2.knowledge.diff.added")
      : line.kind === "remove"
        ? t("ui2.knowledge.diff.removed")
        : t("ui2.knowledge.diff.unchanged");
  const tone =
    line.kind === "add"
      ? "text-emerald-600"
      : line.kind === "remove"
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <div className={`ui2-knowledge-diff-row flex gap-2 font-mono text-xs ${tone}`} data-diff={line.kind}>
      <span aria-hidden="true">{prefix}</span>
      <span className="sr-only">{label}</span>
      <span className="ui2-knowledge-diff-text whitespace-pre-wrap">{line.text}</span>
    </div>
  );
}

function TreeBranch({
  node,
  activeKey,
  onSelect,
}: {
  node: KnowledgeTreeNode;
  activeKey: string | null;
  onSelect: (item: KnowledgeItemSummary) => void;
}) {
  const key = revisionKey(node.item);
  const active = key === activeKey;
  return (
    <li className="ui2-knowledge-tree-node" data-depth={node.depth}>
      <button
        type="button"
        className={`ui2-knowledge-tree-item w-full rounded-md px-2 py-1 text-left text-sm hover:bg-accent ${
          active ? "bg-accent font-medium" : "text-muted-foreground"
        }`}
        style={{ paddingLeft: `${8 + node.depth * 12}px` }}
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect(node.item)}
      >
        {node.item.title}
      </button>
      {node.children.length > 0 ? (
        <ul className="ui2-knowledge-tree-children flex flex-col gap-0.5">
          {node.children.map((child) => (
            <TreeBranch key={revisionKey(child.item)} node={child} activeKey={activeKey} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function RevisionPicker({
  revisions,
  from,
  to,
  onFrom,
  onTo,
  t,
}: {
  revisions: KnowledgeRevisionSummary[];
  from: number | null;
  to: number | null;
  onFrom: (revision: number) => void;
  onTo: (revision: number) => void;
  t: Translate;
}) {
  return (
    <div className="ui2-knowledge-revision-pickers flex flex-wrap items-center gap-3 text-xs">
      <label className="ui2-knowledge-revision-from flex items-center gap-1">
        <span className="text-muted-foreground">{t("ui2.knowledge.revisions.from")}</span>
        <select
          className="rounded-md border border-input bg-background px-2 py-1"
          value={from ?? ""}
          onChange={(event) => onFrom(Number(event.target.value))}
        >
          {revisions.map((revision) => (
            <option key={`from-${revision.revision}`} value={revision.revision}>
              {revision.revision}
            </option>
          ))}
        </select>
      </label>
      <label className="ui2-knowledge-revision-to flex items-center gap-1">
        <span className="text-muted-foreground">{t("ui2.knowledge.revisions.to")}</span>
        <select
          className="rounded-md border border-input bg-background px-2 py-1"
          value={to ?? ""}
          onChange={(event) => onTo(Number(event.target.value))}
        >
          {revisions.map((revision) => (
            <option key={`to-${revision.revision}`} value={revision.revision}>
              {revision.revision}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function RevisionsPanel({
  companyId,
  item,
  t,
}: {
  companyId: string;
  item: KnowledgeItemDetail;
  t: Translate;
}) {
  const revisions = useMemo(
    () => [...(item.revisions ?? [])].sort((left, right) => left.revision - right.revision),
    [item.revisions],
  );
  const latest = revisions.length > 0 ? revisions[revisions.length - 1] : undefined;
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const left = from ?? (revisions.length > 1 ? revisions[0]?.revision ?? null : null);
  const right = to ?? latest?.revision ?? null;
  const olderQuery = useQuery({
    queryKey: knowledgeQueryKeys.item(companyId, item.spaceKey, item.slug, left),
    queryFn: () => knowledgeApi.item(companyId, item.spaceKey, item.slug, { revision: left }),
    enabled: Boolean(companyId) && revisions.length > 1 && left !== null,
  });

  const rollback = useMutation({
    mutationFn: (target: number) => knowledgeApi.rollback(companyId, item.spaceKey, item.slug, target),
    onSuccess: (_data, target) => setNote(t("ui2.knowledge.revisions.rollbackDone", { revision: target })),
    onError: () => setNote(t("ui2.knowledge.revisions.rollbackFailed")),
  });

  const gate = itemGate(item);
  const diff = useMemo(() => {
    if (revisions.length < 2 || left === null) return null;
    const older = olderQuery.data?.item.body ?? "";
    const newer = item.body ?? "";
    return diffKnowledgeRevisions(older, newer);
  }, [olderQuery.data, item.body, left, revisions.length]);
  const changed = diff ? knowledgeDiffChangeCount(diff) : 0;

  if (revisions.length === 0) {
    return (
      <Ui2Section title={t("ui2.knowledge.revisions.title")}>
        <p className="ui2-knowledge-revisions-empty text-xs text-muted-foreground">
          {t("ui2.knowledge.revisions.empty")}
        </p>
      </Ui2Section>
    );
  }

  return (
    <Ui2Section
      title={t("ui2.knowledge.revisions.title")}
      footer={
        <span className="ui2-knowledge-gate-note">
          {t(gate.reasonKey as MessageKey)} —{" "}
          {t("ui2.knowledge.approver.prefix", { who: t(knowledgeApproverLabelKey(gate.approverKind) as MessageKey) })}
        </span>
      }
    >
      <ul className="ui2-knowledge-revision-list flex flex-col gap-1 text-xs">
        {revisions.map((revision) => (
          <li key={revision.revision} className="ui2-knowledge-revision-row flex items-center gap-2">
            <Ui2StatusDot tone={revision.revision === item.revision ? "ok" : "muted"} />
            <span className="ui2-knowledge-revision-number font-medium">
              {t("ui2.knowledge.item.revision", { revision: revision.revision })}
            </span>
            <span className="ui2-knowledge-revision-when text-muted-foreground">
              {formatWhen(revision.at)}
            </span>
            <span className="ui2-knowledge-revision-by text-muted-foreground">{revision.by}</span>
            {revision.note ? (
              <span className="ui2-knowledge-revision-note text-muted-foreground">{revision.note}</span>
            ) : null}
            {revision.revision < item.revision ? (
              <button
                type="button"
                className="ui2-knowledge-rollback rounded-md border border-border px-2 py-0.5 hover:bg-accent disabled:opacity-50"
                disabled={!gate.allowed || rollback.isPending}
                title={t("ui2.knowledge.revisions.rollbackTo", { revision: revision.revision })}
                onClick={() => rollback.mutate(revision.revision)}
              >
                {t("ui2.knowledge.revisions.rollback")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {revisions.length > 1 ? (
        <div className="ui2-knowledge-diff flex flex-col gap-2">
          <RevisionPicker
            revisions={revisions}
            from={left}
            to={right}
            onFrom={setFrom}
            onTo={setTo}
            t={t}
          />
          <p className="ui2-knowledge-diff-count text-xs text-muted-foreground">
            {t("ui2.knowledge.revisions.changed", { count: changed })}
          </p>
          {diff && changed > 0 ? (
            <div className="ui2-knowledge-diff-body flex flex-col rounded-md border border-border bg-background p-2">
              {diff.map((line, index) => (
                <DiffRow key={`diff-${index}`} line={line} t={t} />
              ))}
            </div>
          ) : (
            <p className="ui2-knowledge-diff-empty text-xs text-muted-foreground">
              {t("ui2.knowledge.revisions.noChanges")}
            </p>
          )}
        </div>
      ) : null}

      {note ? <p className="ui2-knowledge-rollback-note text-xs text-muted-foreground">{note}</p> : null}
    </Ui2Section>
  );
}

function KnowledgePagePane({
  companyId,
  item,
  t,
}: {
  companyId: string;
  item: KnowledgeItemDetail;
  t: Translate;
}) {
  const segments = useMemo(() => parseKnowledgeBody(item.body ?? ""), [item.body]);
  const reviewDue = isKnowledgeReviewDue(item);
  return (
    <div className="ui2-knowledge-page flex flex-col gap-4">
      <div className="ui2-knowledge-page-header flex flex-col gap-1">
        <div className="ui2-knowledge-page-title-row flex items-center gap-2">
          <Ui2StatusDot tone={knowledgeStatusTone(item.status)} />
          <h2 className="ui2-knowledge-page-title text-lg font-medium">{item.title}</h2>
        </div>
        <div className="ui2-knowledge-page-meta flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="ui2-knowledge-page-revision">
            {t("ui2.knowledge.item.revision", { revision: item.revision })}
          </span>
          <span className="ui2-knowledge-page-updated">
            {t("ui2.knowledge.item.updated", { when: formatWhen(item.updatedAt) })}
          </span>
          {item.language ? (
            <span className="ui2-knowledge-page-language">
              {t("ui2.knowledge.item.language", { language: item.language })}
            </span>
          ) : null}
          {reviewDue ? (
            <span className="ui2-knowledge-page-review-due text-amber-600">
              {t("ui2.knowledge.item.reviewDue")}
            </span>
          ) : item.reviewDueAt ? (
            <span className="ui2-knowledge-page-review-at">
              {t("ui2.knowledge.item.reviewDueAt", { when: formatWhen(item.reviewDueAt) })}
            </span>
          ) : null}
        </div>
      </div>

      <BodySegments segments={segments} spaceKey={item.spaceKey} />

      <SourcePanel
        title={t("ui2.knowledge.sources.title")}
        sources={item.sources}
        emptyLabel={t("ui2.knowledge.sources.empty")}
        t={t}
      />
      <SourcePanel
        title={t("ui2.knowledge.backlinks.title")}
        sources={item.backlinks}
        emptyLabel={t("ui2.knowledge.backlinks.empty")}
        t={t}
      />
      <RevisionsPanel companyId={companyId} item={item} t={t} />
    </div>
  );
}

function SearchPanel({
  companyId,
  query,
  mode,
  onQuery,
  onMode,
  t,
}: {
  companyId: string;
  query: string;
  mode: KnowledgeSearchMode;
  onQuery: (value: string) => void;
  onMode: (mode: KnowledgeSearchMode) => void;
  t: Translate;
}) {
  const trimmed = query.trim();
  const searchQuery = useQuery({
    queryKey: knowledgeQueryKeys.search(companyId, trimmed, mode),
    queryFn: () => knowledgeApi.search(companyId, trimmed, mode),
    enabled: Boolean(companyId) && trimmed.length >= 2,
  });
  const hits = searchQuery.data?.hits ?? [];

  return (
    <Ui2Section title={t("ui2.knowledge.search.placeholder")}>
      <div className="ui2-knowledge-search-controls flex flex-wrap items-center gap-2">
        <input
          className="ui2-knowledge-search-input flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
          value={query}
          placeholder={t("ui2.knowledge.search.placeholder")}
          aria-label={t("ui2.knowledge.search.placeholder")}
          onChange={(event) => onQuery(event.target.value)}
        />
        <button
          type="button"
          className={`ui2-knowledge-search-mode rounded-md border border-border px-2 py-1 text-xs hover:bg-accent ${
            mode === "fulltext" ? "bg-accent" : ""
          }`}
          aria-pressed={mode === "fulltext"}
          onClick={() => onMode("fulltext")}
        >
          {t("ui2.knowledge.search.mode.fulltext")}
        </button>
        <button
          type="button"
          className={`ui2-knowledge-search-mode rounded-md border border-border px-2 py-1 text-xs hover:bg-accent ${
            mode === "semantic" ? "bg-accent" : ""
          }`}
          aria-pressed={mode === "semantic"}
          onClick={() => onMode("semantic")}
        >
          {t("ui2.knowledge.search.mode.semantic")}
        </button>
      </div>
      {trimmed.length >= 2 && searchQuery.isSuccess ? (
        <div className="ui2-knowledge-search-results flex flex-col gap-2" aria-label={t("ui2.knowledge.search.resultsLabel")}>
          <p className="ui2-knowledge-search-count text-xs text-muted-foreground">
            {t("ui2.knowledge.search.results", { count: hits.length })}
          </p>
          <ul className="ui2-knowledge-search-list flex flex-col gap-1">
            {hits.map((hit) => (
              <li key={revisionKey(hit.item)} className="ui2-knowledge-search-hit flex flex-col gap-0.5">
                <Link
                  className="ui2-knowledge-search-hit-title text-sm text-primary underline underline-offset-2"
                  to={knowledgeHref({ spaceKey: hit.item.spaceKey, slug: hit.item.slug, anchor: null })}
                >
                  {hit.item.title}
                </Link>
                <span className="ui2-knowledge-search-snippet text-xs text-muted-foreground">
                  {hit.snippet}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Ui2Section>
  );
}

export function Ui2Knowledge() {
  const { t } = useUi2I18n();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const params = useParams<{ spaceKey?: string; slug?: string }>();
  const [localSelection, setLocalSelection] = useState<{ spaceKey: string; slug: string } | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<KnowledgeSearchMode>("fulltext");

  const paramSelection =
    params.spaceKey && params.slug ? { spaceKey: params.spaceKey, slug: params.slug } : null;
  const selection = localSelection ?? paramSelection;

  const listQuery = useQuery({
    queryKey: knowledgeQueryKeys.items(companyId),
    queryFn: () => knowledgeApi.items(companyId),
    enabled: Boolean(companyId),
  });

  const itemQuery = useQuery({
    queryKey: knowledgeQueryKeys.item(companyId, selection?.spaceKey ?? "", selection?.slug ?? "", null),
    queryFn: () =>
      knowledgeApi.item(companyId, selection?.spaceKey ?? "", selection?.slug ?? "", {}),
    enabled: Boolean(companyId) && Boolean(selection),
  });

  // One pass + one sort per level; the budget of §3.9 (<300 ms) is pinned in
  // the model and checked by the unit test, not by stopwatch here.
  const tree = useMemo(() => buildKnowledgeTree(listQuery.data?.items ?? []), [listQuery.data]);

  const activeKey = selection ? `${selection.spaceKey}/${selection.slug}` : null;

  return (
    <Ui2Page title={t("ui2.knowledge.title")} subtitle={t("ui2.knowledge.subtitle")}>
      <SearchPanel
        companyId={companyId}
        query={query}
        mode={mode}
        onQuery={setQuery}
        onMode={setMode}
        t={t}
      />

      {listQuery.isLoading ? (
        <Ui2SkeletonRows rows={4} />
      ) : listQuery.isError ? (
        <Ui2ErrorState
          message={t("ui2.common.error")}
          detail={listQuery.error instanceof Error ? listQuery.error.message : null}
          retryLabel={t("ui2.common.retry")}
          onRetry={() => {
            void listQuery.refetch();
          }}
          withCache={false}
        />
      ) : tree.length === 0 ? (
        <Ui2EmptyStateView title={t("ui2.knowledge.tree.empty")} variant="done" />
      ) : (
        <div className="ui2-knowledge-layout flex flex-col gap-4 md:flex-row">
          <Ui2Section title={t("ui2.knowledge.tree.aria")}>
            <ul className="ui2-knowledge-tree flex flex-col gap-0.5" aria-label={t("ui2.knowledge.tree.aria")}>
              {tree.map((node) => (
                <TreeBranch
                  key={revisionKey(node.item)}
                  node={node}
                  activeKey={activeKey}
                  onSelect={(item) => setLocalSelection({ spaceKey: item.spaceKey, slug: item.slug })}
                />
              ))}
            </ul>
          </Ui2Section>

          <div className="ui2-knowledge-detail flex min-w-0 flex-1 flex-col gap-4">
            {!selection ? (
              <Ui2EmptyStateView title={t("ui2.knowledge.item.empty")} variant="filtered" />
            ) : itemQuery.isLoading ? (
              <Ui2SkeletonRows rows={3} />
            ) : itemQuery.isError ? (
              <Ui2ErrorState
                message={t("ui2.common.error")}
                detail={itemQuery.error instanceof Error ? itemQuery.error.message : null}
                retryLabel={t("ui2.common.retry")}
                onRetry={() => {
                  void itemQuery.refetch();
                }}
                withCache={false}
              />
            ) : itemQuery.data ? (
              <KnowledgePagePane companyId={companyId} item={itemQuery.data.item} t={t} />
            ) : null}
          </div>
        </div>
      )}
    </Ui2Page>
  );
}
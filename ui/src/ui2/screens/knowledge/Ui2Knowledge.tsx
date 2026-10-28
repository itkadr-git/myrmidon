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
import { Link, useNavigate, useParams } from "@/lib/router";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import type { Ui2MessageKey } from "../../i18n/locales";
import {
  Ui2EmptyStateView,
  Ui2ErrorState,
  Ui2SkeletonRows,
} from "../../components/ui2StateViews";
import { Ui2Page, Ui2Section, Ui2StatusDot } from "../../components/ui2Primitives";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";
import { knowledgeApi, knowledgeQueryKeys } from "./knowledgeApi";
import type { KnowledgeSearchMode } from "./knowledgeApi";
import {
  buildKnowledgeTree,
  diffKnowledgeRevisions,
  isKnowledgeReviewDue,
  knowledgeApproverLabelKey,
  knowledgeDiffChangeCount,
  knowledgeHref,
  knowledgeSourceLink,
  knowledgeStatusTone,
  knowledgeWriteGate,
} from "./knowledgeModel";
import type {
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
    case "page":
      return "ui2.knowledge.source.kind.page";
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

function SourceRow({
  source,
  basePath,
  t,
}: {
  source: KnowledgeSourceRef;
  basePath: string;
  t: Translate;
}) {
  const link =
    source.kind === "page" && source.ref
      ? ({
          kind: "internal",
          to: knowledgeHref({ spaceKey: source.space ?? "", slug: source.ref, anchor: null }, basePath),
        } as const)
      : knowledgeSourceLink(source);
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
  basePath,
  t,
}: {
  basePath: string;
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
            <SourceRow key={`${source.kind}-${source.ref}-${index}`} source={source} basePath={basePath} t={t} />
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
  from: string | number | null;
  to: string | number | null;
  onFrom: (revision: string | number) => void;
  onTo: (revision: string | number) => void;
  t: Translate;
}) {
  return (
    <div className="ui2-knowledge-revision-pickers flex flex-wrap items-center gap-3 text-xs">
      <label className="ui2-knowledge-revision-from flex items-center gap-1">
        <span className="text-muted-foreground">{t("ui2.knowledge.revisions.from")}</span>
        <select
          className="rounded-md border border-input bg-background px-2 py-1"
          value={from ?? ""}
          onChange={(event) => onFrom(event.target.value)}
        >
          {revisions.map((revision) => (
            <option key={revision.id ?? revision.revision} value={revision.id ?? revision.revision}>
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
          onChange={(event) => onTo(event.target.value)}
        >
          {revisions.map((revision) => (
            <option key={`to-${revision.id ?? revision.revision}`} value={revision.id ?? revision.revision}>
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
  const [from, setFrom] = useState<string | number | null>(null);
  const [to, setTo] = useState<string | number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const leftId = from ?? (revisions.length > 1 ? revisions[0]?.id ?? null : null);
  const rightId = to ?? latest?.id ?? null;
  const leftRevision = revisions.find((revision) => revision.id === leftId)?.revision ?? null;
  const rightRevision = revisions.find((revision) => revision.id === rightId)?.revision ?? null;
  const olderQuery = useQuery({
    queryKey: knowledgeQueryKeys.item(companyId, item.spaceKey, item.slug, leftId),
    queryFn: () => knowledgeApi.item(companyId, item.spaceKey, item.slug, { revision: leftRevision }),
    enabled: Boolean(companyId) && revisions.length > 1 && leftRevision !== null,
  });

  const rollback = useMutation({
    mutationFn: (target: KnowledgeRevisionSummary) => {
      if (!target.id) throw new Error("The revision has no rollback identifier.");
      return knowledgeApi.rollback(companyId, item.spaceKey, item.slug, String(target.id));
    },
    onSuccess: (_data: unknown, target: KnowledgeRevisionSummary) => setNote(t("ui2.knowledge.revisions.rollbackDone", { revision: target.revision })),
    onError: () => setNote(t("ui2.knowledge.revisions.rollbackFailed")),
  });

  const gate = itemGate(item);
  const diff = useMemo(() => {
    if (revisions.length < 2 || leftRevision === null) return null;
    const older = olderQuery.data?.item.body ?? "";
    const newer = item.body ?? "";
    return diffKnowledgeRevisions(older, newer);
  }, [olderQuery.data, item.body, leftRevision, revisions.length]);
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
                onClick={() => rollback.mutate(revision)}
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
            from={leftId}
            to={rightId}
            onFrom={(revision) => setFrom(revision)}
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
  basePath,
  t,
}: {
  companyId: string;
  item: KnowledgeItemDetail;
  basePath: string;
  t: Translate;
}) {
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

      <KnowledgeMarkdown body={item.body ?? ""} spaceKey={item.spaceKey} basePath={basePath} />

      <SourcePanel
        title={t("ui2.knowledge.sources.title")}
        sources={item.sources}
        emptyLabel={t("ui2.knowledge.sources.empty")}
        basePath={basePath}
        t={t}
      />
      <SourcePanel
        title={t("ui2.knowledge.backlinks.title")}
        sources={item.backlinks}
        emptyLabel={t("ui2.knowledge.backlinks.empty")}
        basePath={basePath}
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
  basePath,
  t,
}: {
  companyId: string;
  basePath: string;
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
                  to={knowledgeHref({ spaceKey: hit.item.spaceKey, slug: hit.item.slug, anchor: null }, basePath)}
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

/**
 * `basePath` is where the screen is mounted. UI2 keeps the default
 * (`/knowledge`, selection held in local state); the current interface mounts
 * the same screen at `/wiki` and passes it, so links, search hits and tree
 * selection are real routes there (OPE-9222).
 */
export function Ui2Knowledge({ basePath }: { basePath?: string } = {}) {
  const { t } = useUi2I18n();
  const navigate = useNavigate();
  const linkBase = basePath ?? "/knowledge";
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
        basePath={linkBase}
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
          <div className="ui2-knowledge-tree-pane md:sticky md:top-0 md:w-72 md:shrink-0 md:self-start">
          <Ui2Section title={t("ui2.knowledge.tree.aria")}>
            <div className="ui2-knowledge-tree-scroll max-h-[40dvh] overflow-y-auto md:max-h-[calc(100dvh-24rem)]" data-testid="knowledge-tree-scroll">
            <ul className="ui2-knowledge-tree flex flex-col gap-0.5" aria-label={t("ui2.knowledge.tree.aria")}>
              {tree.map((node) => (
                <TreeBranch
                  key={revisionKey(node.item)}
                  node={node}
                  activeKey={activeKey}
                  onSelect={(item) => {
                    if (basePath) navigate(knowledgeHref({ spaceKey: item.spaceKey, slug: item.slug, anchor: null }, basePath));
                    else setLocalSelection({ spaceKey: item.spaceKey, slug: item.slug });
                  }}
                />
              ))}
            </ul>
            </div>
          </Ui2Section>
          </div>

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
              <KnowledgePagePane companyId={companyId} item={itemQuery.data.item} basePath={linkBase} t={t} />
            ) : null}
          </div>
        </div>
      )}
    </Ui2Page>
  );
}
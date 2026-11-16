import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { heartbeatRunEvents, issueWorkProducts, workspaceRuntimeServices } from "@myrmidon/db";
import type { IssueWorkProduct } from "@myrmidon/shared";
import { HttpError } from "../errors.js";
import { insertRowsInChunks } from "./batch-insert.js";
import {
  createPullRequestMergeDetailsResolver,
  extractGitHubPullRequestReferences,
  type PullRequestMergeDetailsResolver,
} from "./github-pull-request-merge.js";
import {
  createGitHubCommitDiffDetailsResolver,
  extractGitHubCommitReference,
  type GitHubCommitDiffDetailsResolver,
} from "./github-commit-details.js";
import type { ImportIssueWorkProductRow } from "./import-write-types.js";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;

export interface WorkProductDiffSummary {
  additions: number | null;
  deletions: number | null;
  changedFiles: number;
}

type GithubPullRequestRef = { repository: string; number: number };

const GITHUB_PULL_REQUEST_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const GITHUB_PULL_REQUEST_EXTERNAL_ID_RE = /^([^/\s#]+\/[^/\s#]+)#pull\/(\d+)$/i;

function positivePullNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * myrmidon(AGENT-PR-WP-NORMALIZE): the GitHub webhook finds pull_request work
 * products only by `external_id = <owner>/<repo>#pull/<N>` (see
 * github-connection-events.ts). Agents register the PR by url alone, so derive
 * the webhook-format reference from the url, the external id or the metadata.
 */
export function parseGithubPullRequestRef(input: {
  url?: string | null;
  externalId?: string | null;
  metadata?: Record<string, unknown> | null;
}): GithubPullRequestRef | null {
  const metadata = input.metadata ?? {};
  const idMatch = input.externalId ? GITHUB_PULL_REQUEST_EXTERNAL_ID_RE.exec(input.externalId.trim()) : null;
  if (idMatch) return { repository: idMatch[1]!, number: Number(idMatch[2]) };
  const repository = typeof metadata.repo === "string" ? metadata.repo
    : typeof metadata.repository === "string" ? metadata.repository
    : null;
  const number = positivePullNumber(metadata.number);
  if (repository && repository.includes("/") && number) return { repository, number };
  const metadataUrl = typeof metadata.url === "string" ? metadata.url.trim() : "";
  for (const candidate of [input.url?.trim(), metadataUrl]) {
    const match = candidate ? GITHUB_PULL_REQUEST_URL_RE.exec(candidate) : null;
    if (match) return { repository: `${match[1]}/${match[2]}`, number: Number(match[3]) };
  }
  return null;
}

/** Drops the PR reference keys so a new url re-derives them instead of keeping the old PR's. */
function withoutPullRequestRef(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const { repo: _repo, repository: _repository, number: _number, url: _url, ...rest } = metadata as Record<string, unknown>;
  return rest;
}

/** Fills externalId and metadata repo/repository/number for a github pull_request; other rows pass through. */
export function normalizeGithubPullRequestWorkProduct<T extends {
  type?: string | null;
  provider?: string | null;
  url?: string | null;
  externalId?: string | null;
  metadata?: unknown;
}>(data: T): T {
  if (data.type !== "pull_request" || data.provider?.toLowerCase() !== "github") return data;
  const metadata = (data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
    ? data.metadata : {}) as Record<string, unknown>;
  const ref = parseGithubPullRequestRef({ url: data.url, externalId: data.externalId, metadata });
  if (!ref) return data;
  return {
    ...data,
    externalId: data.externalId || `${ref.repository}#pull/${ref.number}`,
    metadata: {
      ...metadata,
      repo: typeof metadata.repo === "string" ? metadata.repo : ref.repository,
      repository: typeof metadata.repository === "string" ? metadata.repository : ref.repository,
      number: positivePullNumber(metadata.number) ?? ref.number,
    },
  };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function workProductDiffSummaryFromEventPayload(payload: unknown): WorkProductDiffSummary | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const outer = payload as Record<string, unknown>;
  const wrappedEvent = outer.prpEvent && typeof outer.prpEvent === "object" && !Array.isArray(outer.prpEvent)
    ? outer.prpEvent as Record<string, unknown>
    : null;
  const eventPayload = wrappedEvent?.payload ?? (outer.schema === "paperclip.prp.event.v1" ? outer.payload : outer);
  if (!eventPayload || typeof eventPayload !== "object" || Array.isArray(eventPayload)) return null;
  const totals = (eventPayload as Record<string, unknown>).totals;
  if (!totals || typeof totals !== "object" || Array.isArray(totals)) return null;
  const values = totals as Record<string, unknown>;
  const changedFiles = nonNegativeInteger(values.files);
  if (changedFiles === null) return null;
  return {
    additions: values.additions === null ? null : nonNegativeInteger(values.additions),
    deletions: values.deletions === null ? null : nonNegativeInteger(values.deletions),
    changedFiles,
  };
}

export function enrichWorkProductMetadataWithDiff(
  metadata: Record<string, unknown> | null | undefined,
  summary: WorkProductDiffSummary | null,
): Record<string, unknown> | null {
  if (!summary) return metadata ?? null;
  return {
    ...(metadata ?? {}),
    ...(summary.additions === null ? {} : { additions: summary.additions }),
    ...(summary.deletions === null ? {} : { deletions: summary.deletions }),
    changedFiles: summary.changedFiles,
  };
}

export async function refreshPullRequestWorkProductMetadata(
  products: IssueWorkProduct[],
  resolvePullRequestDetails: PullRequestMergeDetailsResolver,
): Promise<IssueWorkProduct[]> {
  return await Promise.all(products.map(async (product) => {
    if (product.type !== "pull_request") return product;
    const metadata = product.metadata ?? {};
    const repo = typeof metadata.repo === "string" ? metadata.repo : null;
    const number = nonNegativeInteger(metadata.number);
    const references = extractGitHubPullRequestReferences([
      product.url,
      repo && number ? `${repo}#${number}` : null,
    ]);
    const reference = references[0];
    if (!reference) return product;
    try {
      const details = await resolvePullRequestDetails(product.companyId, reference);
      if (!details.workProductState) return product;
      return {
        ...product,
        metadata: {
          ...metadata,
          repo: repo ?? `${reference.owner}/${reference.repo}`,
          number: number ?? reference.number,
          ...(details.baseRef ? { baseRef: details.baseRef } : {}),
          ...(details.headRef ? { headRef: details.headRef } : {}),
          ...(nonNegativeInteger(details.additions) === null ? {} : { additions: details.additions }),
          ...(nonNegativeInteger(details.deletions) === null ? {} : { deletions: details.deletions }),
          ...(nonNegativeInteger(details.changedFiles) === null ? {} : { changedFiles: details.changedFiles }),
          state: details.workProductState,
          draft: details.workProductState === "draft" || details.draft === true,
        },
      };
    } catch {
      return product;
    }
  }));
}

function toIssueWorkProduct(row: IssueWorkProductRow): IssueWorkProduct {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    issueId: row.issueId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    runtimeServiceId: row.runtimeServiceId ?? null,
    type: row.type as IssueWorkProduct["type"],
    provider: row.provider,
    externalId: row.externalId ?? null,
    title: row.title,
    url: row.url ?? null,
    status: row.status,
    reviewState: row.reviewState as IssueWorkProduct["reviewState"],
    isPrimary: row.isPrimary,
    healthStatus: row.healthStatus as IssueWorkProduct["healthStatus"],
    summary: row.summary ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    sourceTrust: row.sourceTrust ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Refresh runtime-service work products from the live runtime rows they point at
 * (PAP-17572).
 *
 * A runtime URL is only valid for as long as the process holds that port. A
 * managed restart can relocate it, which used to leave a user-facing preview link
 * that answers with somebody else's service or nothing at all. The runtime row is
 * the authoritative publication record, so it wins over the stored copy.
 *
 * Read-path only and deliberately non-destructive: a work product whose runtime
 * row is gone keeps its recorded URL and is reported closed rather than silently
 * blanked, so the history of what was published survives.
 */
export function reconcileRuntimeServiceWorkProducts(
  products: IssueWorkProduct[],
  liveRuntimeServices: Array<{
    id: string;
    url: string | null;
    status: string;
    healthStatus: string;
  }>,
): IssueWorkProduct[] {
  if (products.length === 0) return products;
  const liveById = new Map(liveRuntimeServices.map((service) => [service.id, service]));
  return products.map((product) => {
    if (product.type !== "runtime_service" || !product.runtimeServiceId) return product;
    const live = liveById.get(product.runtimeServiceId);
    if (!live) {
      return product.status === "closed" && product.healthStatus === "unhealthy"
        ? product
        : { ...product, status: "closed", healthStatus: "unhealthy" };
    }
    const isServing = live.status === "running" && live.healthStatus === "healthy";
    const url = live.url ?? product.url;
    const status = live.status === "running" ? product.status : "closed";
    const healthStatus: IssueWorkProduct["healthStatus"] = isServing ? "healthy" : "unhealthy";
    if (product.url === url && product.status === status && product.healthStatus === healthStatus) return product;
    return { ...product, url, status, healthStatus };
  });
}

export function workProductService(
  db: Db,
  opts: {
    resolvePullRequestDetails?: PullRequestMergeDetailsResolver;
    resolveCommitDetails?: GitHubCommitDiffDetailsResolver;
  } = {},
) {
  const resolvePullRequestDetails = opts.resolvePullRequestDetails ?? createPullRequestMergeDetailsResolver(db);
  const resolveCommitDetails = opts.resolveCommitDetails ?? createGitHubCommitDiffDetailsResolver(db);
  return {
    listForIssue: async (issueId: string, options: { refreshPullRequests?: boolean } = {}) => {
      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt));
      const products = rows.map(toIssueWorkProduct);
      const runtimeServiceIds = products
        .map((product) => (product.type === "runtime_service" ? product.runtimeServiceId : null))
        .filter((value): value is string => Boolean(value));
      const reconciled = runtimeServiceIds.length === 0
        ? products
        : reconcileRuntimeServiceWorkProducts(products, await db
            .select({
              id: workspaceRuntimeServices.id,
              url: workspaceRuntimeServices.url,
              status: workspaceRuntimeServices.status,
              healthStatus: workspaceRuntimeServices.healthStatus,
            })
            .from(workspaceRuntimeServices)
            .where(inArray(workspaceRuntimeServices.id, [...new Set(runtimeServiceIds)])));
      return options.refreshPullRequests
        ? refreshPullRequestWorkProductMetadata(reconciled, resolvePullRequestDetails)
        : reconciled;
    },

    latestRunDiffSummary: async (runId: string): Promise<WorkProductDiffSummary | null> => {
      const rows = await db
        .select({ payload: heartbeatRunEvents.payload })
        .from(heartbeatRunEvents)
        .where(and(
          eq(heartbeatRunEvents.runId, runId),
          inArray(heartbeatRunEvents.eventType, ["workspace.change.updated", "workspace.diff.recorded"]),
        ))
        .orderBy(desc(heartbeatRunEvents.seq))
        .limit(20);
      for (const row of rows) {
        const summary = workProductDiffSummaryFromEventPayload(row.payload);
        if (summary) return summary;
      }
      return null;
    },

    resolveCommitDiffSummary: async (
      companyId: string,
      input: { provider: string; url?: string | null; metadata?: Record<string, unknown> | null },
    ): Promise<WorkProductDiffSummary | null> => {
      if (input.provider.toLowerCase() !== "github") return null;
      const metadata = input.metadata ?? {};
      const repo = typeof metadata.repo === "string" ? metadata.repo : null;
      const sha = typeof metadata.sha === "string" ? metadata.sha : null;
      const reference = extractGitHubCommitReference([
        input.url,
        repo && sha ? `${repo}@${sha}` : null,
      ]);
      return reference ? await resolveCommitDetails(companyId, reference) : null;
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    createForIssue: async (issueId: string, companyId: string, data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">) => {
      // myrmidon(OPE-12024): a pull_request work product without url/externalId is
      // unreadable by the CI review path.  Derive the missing fields from the
      // PR metadata when they are absent; refuse the write when neither the
      // top-level fields nor the metadata carry enough information.
      if (data.type === "pull_request" && data.provider === "github") {
        const metadata = (data.metadata ?? {}) as Record<string, unknown>;
        // myrmidon(OPE-12024): prefer an explicit metadata.url (the address the
        // agent recorded) over a synthesized one; fall back to repo + number.
        const metadataUrl = typeof metadata.url === "string" && metadata.url.trim() !== "" ? metadata.url : null;
        const repo = typeof metadata.repo === "string" ? metadata.repo
          : typeof metadata.repository === "string" ? metadata.repository
          : null;
        const number = typeof metadata.number === "number" && Number.isSafeInteger(metadata.number) && metadata.number > 0
          ? metadata.number
          : null;
        if (!data.url && !data.externalId && !metadataUrl && !(repo && number)) {
          throw new HttpError(
            422,
            "pull_request work product requires url or externalId, or metadata with url or repo/repository and number",
          );
        }
        // Fill missing url/externalId from metadata.
        if (!data.url) {
          if (metadataUrl) {
            data = { ...data, url: metadataUrl };
          } else if (repo && number) {
            data = { ...data, url: `https://github.com/${repo}/pull/${number}` };
          }
        }
        data = normalizeGithubPullRequestWorkProduct(data);
      }
      const row = await db.transaction(async (tx) => {
        // myrmidon(AGENT-PR-WP-NORMALIZE): one record per PR and task. A repeated
        // registration (same external id or url) updates the existing record.
        const duplicate = data.type === "pull_request" && data.provider.toLowerCase() === "github" && (data.externalId || data.url)
          ? await tx
              .select()
              .from(issueWorkProducts)
              .where(and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, "pull_request"),
                eq(issueWorkProducts.provider, data.provider),
                or(
                  ...(data.externalId ? [sql`lower(${issueWorkProducts.externalId}) = lower(${data.externalId})`] : []),
                  ...(data.url ? [eq(issueWorkProducts.url, data.url)] : []),
                ),
              ))
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
        if (duplicate) {
          // The stored record owns status, review state, primary flag and PR state (headSha, merged, ...), which
          // the webhook keeps current. A repeated registration only fills what is missing.
          const incomingMetadata = (data.metadata as Record<string, unknown> | null) ?? {};
          return await tx
            .update(issueWorkProducts)
            .set({
              externalId: duplicate.externalId ?? data.externalId ?? null,
              url: duplicate.url ?? data.url ?? null,
              title: duplicate.title || data.title,
              summary: duplicate.summary ?? data.summary ?? null,
              metadata: { ...incomingMetadata, ...((duplicate.metadata as Record<string, unknown> | null) ?? {}) },
              updatedAt: new Date(),
            })
            .where(eq(issueWorkProducts.id, duplicate.id))
            .returning()
            .then((rows) => rows[0] ?? null);
        }
        if (data.isPrimary) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, data.type),
              ),
            );
        }
        return await tx
          .insert(issueWorkProducts)
          .values({
            ...data,
            companyId,
            issueId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    update: async (id: string, patch: Partial<typeof issueWorkProducts.$inferInsert>) => {
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        if (patch.isPrimary === true) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, existing.companyId),
                eq(issueWorkProducts.issueId, existing.issueId),
                eq(issueWorkProducts.type, existing.type),
              ),
            );
        }

        // myrmidon(AGENT-PR-WP-NORMALIZE): keep the webhook-format external id and
        // repo/number metadata on github pull_request records after a PATCH.
        const urlChanged = typeof patch.url === "string" && patch.url !== existing.url;
        const merged = normalizeGithubPullRequestWorkProduct({
          type: patch.type ?? existing.type,
          provider: patch.provider ?? existing.provider,
          url: patch.url ?? existing.url,
          externalId: patch.externalId ?? (urlChanged ? null : existing.externalId),
          metadata: patch.metadata ?? (urlChanged ? withoutPullRequestRef(existing.metadata) : existing.metadata),
        });
        if (merged.externalId && merged.externalId !== (patch.externalId ?? existing.externalId)) {
          patch = { ...patch, externalId: merged.externalId };
        }
        if (merged.metadata && merged.metadata !== (patch.metadata ?? existing.metadata)) {
          patch = { ...patch, metadata: merged.metadata as Record<string, unknown> };
        }
        return await tx
          .update(issueWorkProducts)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(issueWorkProducts.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    /**
     * Batched work-product insert for company import.
     *
     * {@link createForIssue} clears the prior primary of the same type on every
     * call; imported issues are brand new, so the only primaries in play are the
     * imported rows themselves. We reproduce "last primary wins" within each
     * (issue, type) group and insert the whole batch in chunked statements.
     */
    createManyForImport: async (rows: ImportIssueWorkProductRow[]): Promise<void> => {
      if (rows.length === 0) return;
      const lastPrimaryIndexByGroup = new Map<string, number>();
      rows.forEach((row, index) => {
        if (row.isPrimary) lastPrimaryIndexByGroup.set(`${row.issueId}:${row.type}`, index);
      });
      const values = rows.map((row, index) => ({
        companyId: row.companyId,
        issueId: row.issueId,
        projectId: row.projectId ?? null,
        type: row.type,
        provider: row.provider,
        externalId: row.externalId ?? null,
        title: row.title,
        url: row.url ?? null,
        status: row.status,
        reviewState: row.reviewState,
        isPrimary: row.isPrimary
          ? lastPrimaryIndexByGroup.get(`${row.issueId}:${row.type}`) === index
          : false,
        healthStatus: row.healthStatus,
        summary: row.summary ?? null,
        metadata: row.metadata ?? null,
        executionWorkspaceId: row.executionWorkspaceId ?? null,
        runtimeServiceId: row.runtimeServiceId ?? null,
        createdByRunId: row.createdByRunId ?? null,
        sourceTrust: row.sourceTrust ?? null,
      }));
      // Chunked writes are wrapped in a single transaction so a large import
      // that spans multiple insert statements is atomic: if a later chunk
      // fails, the earlier chunks roll back rather than leaving a partial
      // prefix behind (which a retry would then duplicate). Mirrors the
      // per-writer transaction the batched issue/document writers use.
      await db.transaction(async (tx) => {
        await insertRowsInChunks(tx, issueWorkProducts, values);
      });
    },

    remove: async (id: string) => {
      const row = await db
        .delete(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },
  };
}

export { toIssueWorkProduct };

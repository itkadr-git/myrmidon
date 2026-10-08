// myrmidon(1.6.5-BOT-DISK-H4a): builds the desired-state document of one bot
// (contract C3, `GET /api/myrmidon/bots/me/workspaces`).
//
// The tasks come from the board: those assigned to the bot, plus those it lost
// by reassignment lately (read from the activity log). Pull-request facts are
// the work products the task-pr-sync keeps current; this service only reads
// them. The repository is the task's project repository (Repo URL of its
// workspace) or, failing that, the latest pull request's repository, or,
// failing that, the instance's `general.botDisk.defaultRepo`. The
// pressure block comes from the last dockergate snapshot when one is wired in;
// without it the level is `none`.
//
// myrmidon(1.6.5-BOT-DISK-H LOAD): BOT-DISK-H polls this document about 30 times
// a minute across the fleet. The per-bot result — and the `enabled` settings read
// the route does in front of it — is cached in process memory for
// WS_DESIRED_STATE_TTL_MS (300 s, the same window as the report cadence the bot
// is told to honor), so one bot costs the board at most one store pass per
// window. The 5-minute slack is contract-safe: `closing` stays valid for 14
// days, and a woken bot gets SIGUSR1 from its run anyway. No event
// invalidation: TTL is enough.

import { and, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import {
  activityLog,
  issueWorkProducts,
  issues,
  projectWorkspaces,
  type Db,
} from "@paperclipai/db";
import {
  WS_BOT_DISK_SETTING_DEFAULTS,
  WS_TASK_BRANCH_PREFIX,
  myrWsIssueKeySchema,
  normalizeStoredBotDiskSettings,
  resolveBotDiskSettings,
  myrWsRepoNameSchema,
  wsBotDiskSettingsSchema,
  type WsDesiredState,
  type WsDesiredWorkspace,
} from "@paperclipai/shared";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { effectivePullRequestState, readPullRequestMetadata } from "../task-pr-sync/policy.js";
import { prStateOf, workspaceStateOf, type WorkspacePrFact } from "./workspace-state.js";
// myrmidon(1.6.5-BOT-DISK-H4a-INVALIDATE): drop the per-bot cache entries on
// the board event (status or assignee change), not only on TTL.
import { registerDesiredStateDropper } from "./bot-workspaces-invalidation.js";

/** Terminal tasks stay in the list this long so botd can see and remove their copy. */
export const WS_TERMINAL_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
/** Orphan grace (copies of tasks absent from the list) in hours; contract `grace.orphanHours`. */
export const WS_ORPHAN_HOURS = 24;
/**
 * myrmidon(1.6.5-BOT-DISK-H LOAD): how long one bot's built desired state (and the
 * `enabled` read in front of it) is reused from process memory. 300 s matches the
 * `nextReportSec` the bot is told to honor, so a bot costs the store at most one
 * pass per window instead of ~30 board queries a minute. A rejected build is not
 * cached; the next request retries.
 */
export const WS_DESIRED_STATE_TTL_MS = 300 * 1000;

export interface WorkspaceIssueRow {
  id: string;
  identifier: string | null;
  status: string;
  assigneeAgentId: string | null;
  projectId: string | null;
  hiddenAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  updatedAt: Date;
}

export interface WorkspacePrProductRow {
  issueId: string;
  status: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
  updatedAt: Date;
}

export interface BotWorkspacesStore {
  /** Tasks assigned to the bot, plus tasks reassigned away from it since `since`, plus terminal ones updated since `since`. */
  listIssues(input: { companyId: string; agentId: string; since: Date }): Promise<WorkspaceIssueRow[]>;
  /** Pull-request work products of the tasks, newest first. */
  listPrProducts(input: { issueIds: string[] }): Promise<WorkspacePrProductRow[]>;
  /**
   * Keys of done/cancelled tasks the bot holds or held (assigned now, or reassigned
   * away from it at any time), with no lookback limit. Optional so older stores keep
   * working: without it `closedKeys` comes from the lookback rows only.
   */
  listClosedKeys?(input: { companyId: string; agentId: string }): Promise<string[]>;
  /** Repo URL of the primary project workspace per project id. */
  listProjectRepoUrls(input: { projectIds: string[] }): Promise<Map<string, string>>;
  /** Stored `general.botDisk` (raw), for the grace settings. */
  readBotDiskSettings(): Promise<unknown>;
}

export interface BotWorkspacePressureInput {
  agentId: string;
}
export type BotWorkspacePressure = WsDesiredState["pressure"];

export interface BotWorkspacesServiceDeps {
  store: BotWorkspacesStore;
  /** Latest dockergate snapshot for the bot; null/absent means no data (level none). */
  readPressure?: (input: BotWorkspacePressureInput) => Promise<BotWorkspacePressure | null>;
  now?: () => Date;
  /** Environment for the `enabled` default (tests inject it). */
  env?: Record<string, string | undefined>;
  /** Override the desired-state cache window (tests); default `WS_DESIRED_STATE_TTL_MS`. */
  desiredStateTtlMs?: number;
}

const GITHUB_REPO_RE = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?]|$)/i;

/** `owner/repo` from a Repo URL (https, ssh, with or without userinfo/.git); undefined when not GitHub. */
export function repoNameFromUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const match = GITHUB_REPO_RE.exec(url.trim());
  if (!match) return undefined;
  const name = `${match[1]}/${match[2]}`;
  return myrWsRepoNameSchema.safeParse(name).success ? name : undefined;
}

function prRepoOf(product: WorkspacePrProductRow): string | undefined {
  const { repo } = readPullRequestMetadata({ metadata: product.metadata } as never);
  if (repo && myrWsRepoNameSchema.safeParse(repo).success) return repo;
  return repoNameFromUrl(product.url);
}

const NO_PRESSURE: BotWorkspacePressure = { quotaPercent: null, partitionPercent: 0, level: "none" };

export function botWorkspacesService(deps: BotWorkspacesServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const ttlMs = deps.desiredStateTtlMs ?? WS_DESIRED_STATE_TTL_MS;

  const core = {
    /** `general.botDisk.enabled` (stored, else env, else default true): false switches the reaping off. */
    async isEnabled(): Promise<boolean> {
      const stored = await deps.store.readBotDiskSettings();
      return resolveBotDiskSettings({ stored, env: deps.env ?? process.env }).settings.enabled;
    },
    async desiredState(input: { companyId: string; agentId: string }): Promise<WsDesiredState> {
      const at = now();
      const since = new Date(at.getTime() - WS_TERMINAL_LOOKBACK_MS);
      const rows = await deps.store.listIssues({ companyId: input.companyId, agentId: input.agentId, since });
      const keyed = rows.filter((row) => row.identifier && myrWsIssueKeySchema.safeParse(row.identifier).success);
      const products = keyed.length > 0 ? await deps.store.listPrProducts({ issueIds: keyed.map((r) => r.id) }) : [];
      const projectIds = [...new Set(keyed.map((r) => r.projectId).filter((id): id is string => !!id))];
      const projectRepos = projectIds.length > 0 ? await deps.store.listProjectRepoUrls({ projectIds }) : new Map();

      const productsByIssue = new Map<string, WorkspacePrProductRow[]>();
      for (const product of products) {
        const list = productsByIssue.get(product.issueId) ?? [];
        list.push(product);
        productsByIssue.set(product.issueId, list);
      }

      const rawSettings = await deps.store.readBotDiskSettings();
      // myrmidon(1.6.5-BOT-DISK-H4b): the fallback repository for tasks without a
      // project repository and without a pull request.
      const defaultRepo = normalizeStoredBotDiskSettings(rawSettings).defaultRepo;

      const workspaces: WsDesiredWorkspace[] = [];
      for (const row of keyed) {
        const key = row.identifier as string;
        const issueProducts = productsByIssue.get(row.id) ?? [];
        const prFacts: WorkspacePrFact[] = issueProducts.map((product) => ({
          state: effectivePullRequestState({ storedStatus: product.status }),
        }));
        const verdict = workspaceStateOf(
          {
            status: row.status,
            assigneeAgentId: row.assigneeAgentId,
            botAgentId: input.agentId,
            hidden: row.hiddenAt !== null,
          },
          prFacts,
        );
        // Project repository first; otherwise the latest pull request's repository;
        // otherwise the instance default repository (when one is set).
        const repo =
          repoNameFromUrl(row.projectId ? projectRepos.get(row.projectId) : undefined) ??
          issueProducts.map(prRepoOf).find((value): value is string => !!value) ??
          defaultRepo;

        let sinceDate: Date;
        if (verdict.state === "active") {
          sinceDate = row.startedAt ?? row.updatedAt;
        } else if (verdict.reason === "terminal") {
          sinceDate = row.completedAt ?? row.cancelledAt ?? row.updatedAt;
        } else if (verdict.reason === "pr_merged") {
          const mergedAt = issueProducts
            .filter((p) => effectivePullRequestState({ storedStatus: p.status }) === "merged")
            .map((p) => p.updatedAt.getTime());
          sinceDate = mergedAt.length > 0 ? new Date(Math.max(...mergedAt)) : row.updatedAt;
        } else {
          sinceDate = row.updatedAt;
        }

        workspaces.push({
          key,
          ...(repo ? { repo } : {}),
          state: verdict.state,
          since: sinceDate.toISOString(),
          prState: prStateOf(prFacts),
          branch: `${WS_TASK_BRANCH_PREFIX}${key}`,
        });
      }

      // Every open task of this bot, repository or not: botd protects their directories.
      const protectKeys = keyed
        .filter(
          (row) =>
            row.assigneeAgentId === input.agentId && row.status !== "done" && row.status !== "cancelled",
        )
        .map((row) => row.identifier as string);

      // Board-confirmed closed (done/cancelled) tasks of this bot: the lookback rows plus the
      // unbounded store query, so a directory of a task closed long ago is still confirmed.
      const closedSet = new Set<string>(
        keyed.filter((row) => row.status === "done" || row.status === "cancelled").map((row) => row.identifier as string),
      );
      const extraClosed = (await deps.store.listClosedKeys?.({ companyId: input.companyId, agentId: input.agentId })) ?? [];
      for (const key of extraClosed) {
        if (myrWsIssueKeySchema.safeParse(key).success) closedSet.add(key);
      }
      for (const key of protectKeys) closedSet.delete(key);
      const closedKeys = [...closedSet].sort();

      const settings = wsBotDiskSettingsSchema.safeParse(rawSettings);
      const configured = settings.success ? settings.data : {};
      const pressure = (await deps.readPressure?.({ agentId: input.agentId }).catch(() => null)) ?? NO_PRESSURE;

      return {
        generatedAt: at.toISOString(),
        grace: {
          closingMinutes: configured.graceClosingMinutes ?? WS_BOT_DISK_SETTING_DEFAULTS.graceClosingMinutes,
          scratchTtlHours: configured.scratchTtlHours ?? WS_BOT_DISK_SETTING_DEFAULTS.scratchTtlHours,
          orphanHours: WS_ORPHAN_HOURS,
          ...(configured.legacyPressureIdleDays !== undefined ? { legacyPressureIdleDays: configured.legacyPressureIdleDays } : {}),
        },
        pressure,
        workspaces,
        protectKeys,
        closedKeys,
      };
    },
  };

  // myrmidon(1.6.5-BOT-DISK-H LOAD): per-bot desired-state cache in process
  // memory. The key is the bot (companyId + agentId), so different bots never
  // share an entry. The in-flight promise is cached too, so concurrent pollers
  // of one bot collapse into a single store pass. Only a successful build is
  // kept for the window: a rejection drops the entry and the next request
  // retries. The route still serializes the answer through wsDesiredStateSchema,
  // so a cached value is contract-checked on every reply.
  // myrmidon(1.6.5-BOT-DISK-H4a-INVALIDATE): TTL alone is not enough — a
  // reopened task must return to `protectKeys` at once (botd would otherwise
  // archive-delete the directory mid-work), and a reassignment must move the
  // key between bots. The issue route publishes the event through the
  // process-local registry and every service drops the affected entries.
  const desiredCache = new Map<string, { expiresAtMs: number; promise: Promise<WsDesiredState> }>();
  // myrmidon(1.6.5-BOT-DISK-H4a-INVALIDATE): the cache is dropped on the board
  // event, not only by TTL. The registry is a process-local fan-out: the issue
  // route publishes, every constructed service drops its own entries.
  registerDesiredStateDropper(({ companyId, agentId }) => {
    desiredCache.delete(`${companyId}:${agentId}`);
  });

  return {
    isEnabled: core.isEnabled,
    async desiredState(input: { companyId: string; agentId: string }): Promise<WsDesiredState> {
      const key = `${input.companyId}:${input.agentId}`;
      const e = now().getTime();
      const hit = desiredCache.get(key);
      if (hit && hit.expiresAtMs > e) return hit.promise;
      const entry: { expiresAtMs: number; promise: Promise<WsDesiredState> } = {
        expiresAtMs: e + ttlMs,
        promise: core.desiredState(input).catch((err) => {
          if (desiredCache.get(key) === entry) desiredCache.delete(key);
          throw err;
        }),
      };
      desiredCache.set(key, entry);
      return entry.promise;
    },
  };
}

export type BotWorkspacesService = ReturnType<typeof botWorkspacesService>;

/** The drizzle-backed store used in production. */
export function botWorkspacesStore(db: Db): BotWorkspacesStore {
  const settings = instanceSettingsService(db);
  return {
    async listIssues({ companyId, agentId, since }) {
      // Tasks the bot lost by reassignment: the activity log keeps the previous assignee.
      const reassigned = await db
        .selectDistinct({ entityId: activityLog.entityId })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "issue"),
            eq(activityLog.action, "issue.updated"),
            gt(activityLog.createdAt, since),
            sql`${activityLog.details}->'_previous'->>'assigneeAgentId' = ${agentId}`,
          ),
        );
      const reassignedIds = reassigned.map((r) => r.entityId);
      const selected = {
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        projectId: issues.projectId,
        hiddenAt: issues.hiddenAt,
        startedAt: issues.startedAt,
        completedAt: issues.completedAt,
        cancelledAt: issues.cancelledAt,
        updatedAt: issues.updatedAt,
      };
      const mine = await db
        .select(selected)
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.assigneeAgentId, agentId),
            or(sql`${issues.status} not in ('done', 'cancelled')`, gt(issues.updatedAt, since)),
          ),
        );
      const lost =
        reassignedIds.length > 0
          ? await db
              .select(selected)
              .from(issues)
              .where(
                and(
                  eq(issues.companyId, companyId),
                  inArray(sql`${issues.id}::text`, reassignedIds),
                  or(ne(issues.assigneeAgentId, agentId), sql`${issues.assigneeAgentId} is null`),
                ),
              )
          : [];
      return [...mine, ...lost];
    },

    async listClosedKeys({ companyId, agentId }) {
      const reassigned = await db
        .selectDistinct({ entityId: activityLog.entityId })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "issue"),
            eq(activityLog.action, "issue.updated"),
            sql`${activityLog.details}->'_previous'->>'assigneeAgentId' = ${agentId}`,
          ),
        );
      const reassignedIds = reassigned.map((r) => r.entityId);
      const held =
        reassignedIds.length > 0
          ? or(eq(issues.assigneeAgentId, agentId), inArray(sql`${issues.id}::text`, reassignedIds))
          : eq(issues.assigneeAgentId, agentId);
      const rows = await db
        .select({ identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), sql`${issues.status} in ('done', 'cancelled')`, held))
        .limit(5000);
      return rows.map((r) => r.identifier).filter((id): id is string => !!id);
    },

    async listPrProducts({ issueIds }) {
      return db
        .select({
          issueId: issueWorkProducts.issueId,
          status: issueWorkProducts.status,
          url: issueWorkProducts.url,
          metadata: issueWorkProducts.metadata,
          updatedAt: issueWorkProducts.updatedAt,
        })
        .from(issueWorkProducts)
        .where(and(inArray(issueWorkProducts.issueId, issueIds), eq(issueWorkProducts.type, "pull_request")))
        .orderBy(desc(issueWorkProducts.updatedAt));
    },

    async listProjectRepoUrls({ projectIds }) {
      const rows = await db
        .select({
          projectId: projectWorkspaces.projectId,
          repoUrl: projectWorkspaces.repoUrl,
          isPrimary: projectWorkspaces.isPrimary,
        })
        .from(projectWorkspaces)
        .where(inArray(projectWorkspaces.projectId, projectIds))
        .orderBy(desc(projectWorkspaces.isPrimary), projectWorkspaces.createdAt);
      const out = new Map<string, string>();
      for (const row of rows) {
        if (row.repoUrl && !out.has(row.projectId)) out.set(row.projectId, row.repoUrl);
      }
      return out;
    },

    async readBotDiskSettings() {
      const general = await settings.getGeneral();
      return (general as unknown as Record<string, unknown>).botDisk ?? {};
    },
  };
}

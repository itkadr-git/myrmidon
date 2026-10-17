// myrmidon(SERVER-ONBOARD A): job + onboarding-state store.
//
// Interface-first like fleet-console: routes and the service are exercisable
// without a database; `fleetOnboardStore` is the Drizzle implementation. The
// partial unique index (one open job per server) is the claim guard.

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { myrmidonFleetOnboardJobs, myrmidonFleetServers, type Db } from "@paperclipai/db";
import {
  ONBOARD_BOOTSTRAP_VERSION,
  appendStepLog,
  type OnboardJob,
  type OnboardJobKind,
  type OnboardJobStatus,
  type OnboardStepLogEntry,
} from "./domain.js";

/** Registry row shape the onboarding flow needs; fleet-console maps its own view. */
export type OnboardServerRow = {
  id: string;
  companyId: string;
  slug: string;
  name: string;
  hostname: string;
  port: number;
  protocol: string;
  username: string;
  passwordSecretKey: string | null;
  role: string;
  onboardState: string;
  hostKeyFingerprint: string | null;
  accessKeySecretKey: string | null;
  bootstrapVersion: string | null;
  lastCheckAt: Date | null;
  lastCheckOk: boolean | null;
};

export interface OnboardJobClaim {
  job: OnboardJob;
  /** Server connection facts the executor needs; secret NAMES only. */
  server: {
    id: string;
    slug: string;
    hostname: string;
    port: number;
    username: string;
    protocol: string;
    passwordSecretKey: string | null;
    accessKeySecretKey: string | null;
    hostKeyFingerprint: string | null;
  };
  /** Steps the executor must run, in order. */
  steps: string[];
  options: {
    keepPassword: boolean;
    installDocker: boolean;
    role: string;
  };
}

export interface FleetOnboardStore {
  createJob(input: { companyId: string; serverId: string; kind: OnboardJobKind; createdBy: string | null }): Promise<OnboardJob>;
  getJob(companyId: string, jobId: string): Promise<OnboardJob | null>;
  getJobById(jobId: string): Promise<OnboardJob | null>;
  listJobs(companyId: string, serverId?: string): Promise<OnboardJob[]>;
  /** Atomically move pending→claimed and hand the executor its work. */
  claimNext(companyId: string): Promise<OnboardJobClaim | null>;
  consumeClaimSecrets(companyId: string, jobId: string): Promise<boolean>;
  updateJob(
    companyId: string,
    jobId: string,
    patch: { status?: OnboardJobStatus; step?: string | null; stepLogEntry?: OnboardStepLogEntry; error?: string | null },
  ): Promise<OnboardJob | null>;
  expireStale(olderThanMs: number): Promise<number>;
  /** Registry rows the onboarding flow owns (fleet-console reads them too). */
  createServer(
    companyId: string,
    input: {
      slug: string;
      name: string;
      hostname: string;
      port: number;
      username: string;
      role: string;
      passwordSecretKey: string | null;
      accessKeySecretKey: string | null;
      keepPassword: boolean;
    },
  ): Promise<OnboardServerRow>;
  createServerAndJob(companyId: string, input: { slug: string; name: string; hostname: string; port: number; username: string; role: string; passwordSecretKey: string | null; accessKeySecretKey: string | null; keepPassword: boolean; createdBy: string | null }): Promise<{ server: OnboardServerRow; job: OnboardJob }>;
  getServerById(companyId: string, serverId: string): Promise<OnboardServerRow | null>;
  /** Registry row by slug, for the add-server uniqueness check. */
  getServerBySlug(companyId: string, slug: string): Promise<{ id: string } | null>;
  /** Onboarding-facing server updates, keyed by id, company-scoped. */
  updateServerOnboard(
    companyId: string,
    serverId: string,
    patch: {
      onboardState?: "new" | "onboarding" | "ready" | "needs_attention" | "decommissioned";
      hostKeyFingerprint?: string | null;
      accessKeySecretKey?: string | null;
      bootstrapVersion?: string | null;
      lastCheckOk?: boolean;
    },
  ): Promise<void>;
}

type JobRow = typeof myrmidonFleetOnboardJobs.$inferSelect;
type ServerRow = typeof myrmidonFleetServers.$inferSelect;

function toJob(row: JobRow): OnboardJob {
  return {
    id: row.id,
    companyId: row.companyId,
    serverId: row.serverId,
    kind: row.kind as OnboardJobKind,
    status: row.status as OnboardJobStatus,
    step: row.step,
    stepLog: Array.isArray(row.stepLog) ? (row.stepLog as OnboardStepLogEntry[]) : [],
    error: row.error,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

function toServer(row: ServerRow): OnboardServerRow {
  return {
    id: row.id,
    companyId: row.companyId,
    slug: row.slug,
    name: row.name,
    hostname: row.hostname,
    port: row.port,
    protocol: row.protocol,
    username: row.username,
    passwordSecretKey: row.passwordSecretKey,
    role: row.role,
    onboardState: row.onboardState,
    hostKeyFingerprint: row.hostKeyFingerprint,
    accessKeySecretKey: row.accessKeySecretKey,
    bootstrapVersion: row.bootstrapVersion,
    lastCheckAt: row.lastCheckAt,
    lastCheckOk: row.lastCheckOk,
  };
}

export function fleetOnboardStore(db: Db): FleetOnboardStore {
  return {
    async createJob(input) {
      const [row] = await db
        .insert(myrmidonFleetOnboardJobs)
        .values({
          companyId: input.companyId,
          serverId: input.serverId,
          kind: input.kind,
          status: "pending",
          createdBy: input.createdBy,
        })
        .returning();
      return toJob(row!);
    },

    async getJob(companyId, jobId) {
      const row = await db
        .select()
        .from(myrmidonFleetOnboardJobs)
        .where(and(eq(myrmidonFleetOnboardJobs.companyId, companyId), eq(myrmidonFleetOnboardJobs.id, jobId)))
        .then((rows) => rows[0] ?? null);
      return row ? toJob(row) : null;
    },

    async getJobById(jobId) {
      const row = await db
        .select()
        .from(myrmidonFleetOnboardJobs)
        .where(and(eq(myrmidonFleetOnboardJobs.companyId, companyId), eq(myrmidonFleetOnboardJobs.id, jobId)))
        .then((rows) => rows[0] ?? null);
      return row ? toJob(row) : null;
    },

    async listJobs(companyId, serverId) {
      const where = serverId
        ? and(eq(myrmidonFleetOnboardJobs.companyId, companyId), eq(myrmidonFleetOnboardJobs.serverId, serverId))
        : eq(myrmidonFleetOnboardJobs.companyId, companyId);
      const rows = await db
        .select()
        .from(myrmidonFleetOnboardJobs)
        .where(where)
        .orderBy(desc(myrmidonFleetOnboardJobs.createdAt))
        .limit(50);
      return rows.map(toJob);
    },

    async claimNext(companyId) {
      const rows = await db.execute(sql`
        WITH next_job AS (
          SELECT id FROM myrmidon_fleet_onboard_jobs
          WHERE status = 'pending' AND company_id = ${companyId}::uuid
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE myrmidon_fleet_onboard_jobs j
        SET status = 'claimed', updated_at = now(), started_at = COALESCE(j.started_at, now())
        FROM next_job
        WHERE j.id = next_job.id
        RETURNING j.id
      `);
      const claimedId = (rows as unknown as Array<{ id: string }>)[0]?.id;
      if (!claimedId) return null;
      const job = await db
        .select()
        .from(myrmidonFleetOnboardJobs)
        .where(eq(myrmidonFleetOnboardJobs.id, claimedId))
        .then((r) => r[0]);
      if (!job) return null;
      const server = await db
        .select()
        .from(myrmidonFleetServers)
        .where(and(eq(myrmidonFleetServers.companyId, companyId), eq(myrmidonFleetServers.id, job.serverId)))
        .then((r) => r[0]);
      if (!server) return null;
      return {
        job: toJob(job),
        server: {
          id: server.id,
          slug: server.slug,
          hostname: server.hostname,
          port: server.port,
          username: server.username,
          protocol: server.protocol,
          passwordSecretKey: server.passwordSecretKey,
          keepPassword: server.keepPassword,
          accessKeySecretKey: server.accessKeySecretKey,
          hostKeyFingerprint: server.hostKeyFingerprint,
        },
        steps: ["connect", "preflight", "access", "verify"],
        options: { keepPassword: server.keepPassword, installDocker: false, role: server.role },
      };
    },

    async consumeClaimSecrets(companyId, jobId) {
      const rows = await db.update(myrmidonFleetOnboardJobs)
        .set({ secretConsumedAt: new Date() })
        .where(and(eq(myrmidonFleetOnboardJobs.id, jobId), eq(myrmidonFleetOnboardJobs.companyId, companyId), eq(myrmidonFleetOnboardJobs.status, "claimed"), sql`${myrmidonFleetOnboardJobs.secretConsumedAt} IS NULL`))
        .returning({ id: myrmidonFleetOnboardJobs.id });
      return rows.length === 1;
    },

    async updateJob(companyId, jobId, patch) {
      const current = await db
        .select()
        .from(myrmidonFleetOnboardJobs)
        .where(and(eq(myrmidonFleetOnboardJobs.companyId, companyId), eq(myrmidonFleetOnboardJobs.id, jobId)))
        .then((r) => r[0] ?? null);
      if (!current) return null;
      const log: OnboardStepLogEntry[] = Array.isArray(current.stepLog) ? (current.stepLog as OnboardStepLogEntry[]) : [];
      const nextLog = patch.stepLogEntry ? appendStepLog(log, patch.stepLogEntry) : log;
      const finished = patch.status === "succeeded" || patch.status === "failed" || patch.status === "expired";
      const [row] = await db
        .update(myrmidonFleetOnboardJobs)
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.step !== undefined ? { step: patch.step } : {}),
          ...(patch.stepLogEntry ? { stepLog: nextLog } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(finished ? { finishedAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(myrmidonFleetOnboardJobs.companyId, companyId), eq(myrmidonFleetOnboardJobs.id, jobId)))
        .returning();
      return row ? toJob(row) : null;
    },

    async expireStale(olderThanMs) {
      const cutoff = new Date(Date.now() - olderThanMs);
      const rows = await db
        .update(myrmidonFleetOnboardJobs)
        .set({ status: "expired", error: "expired: no executor report", finishedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            inArray(myrmidonFleetOnboardJobs.status, ["pending", "claimed", "running"]),
            lt(myrmidonFleetOnboardJobs.updatedAt, cutoff),
          ),
        )
        .returning({ id: myrmidonFleetOnboardJobs.id });
      return rows.length;
    },

    async createServer(companyId, input) {
      const [row] = await db
        .insert(myrmidonFleetServers)
        .values({
          companyId,
          slug: input.slug,
          name: input.name,
          hostname: input.hostname,
          port: input.port,
          protocol: "ssh",
          username: input.username,
          passwordSecretKey: input.passwordSecretKey,
          keepPassword: input.keepPassword,
          accessKeySecretKey: input.accessKeySecretKey,
          role: input.role,
          onboardState: "new",
          hostKeyFingerprint: null,
          bootstrapVersion: ONBOARD_BOOTSTRAP_VERSION,
          lastCheckAt: null,
          lastCheckOk: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      return toServer(row!);
    },

    async createServerAndJob(companyId, input) {
      return db.transaction(async (tx) => {
        const [serverRow] = await tx.insert(myrmidonFleetServers).values({ companyId, slug: input.slug, name: input.name, hostname: input.hostname, port: input.port, protocol: "ssh", username: input.username, passwordSecretKey: input.passwordSecretKey, keepPassword: input.keepPassword, accessKeySecretKey: input.accessKeySecretKey, role: input.role, onboardState: "new", bootstrapVersion: ONBOARD_BOOTSTRAP_VERSION }).returning();
        const [jobRow] = await tx.insert(myrmidonFleetOnboardJobs).values({ companyId, serverId: serverRow!.id, kind: "onboard", status: "pending", createdBy: input.createdBy }).returning();
        return { server: toServer(serverRow!), job: toJob(jobRow!) };
      });
    },

    async getServerById(companyId, serverId) {
      const row = await db
        .select()
        .from(myrmidonFleetServers)
        .where(and(eq(myrmidonFleetServers.companyId, companyId), eq(myrmidonFleetServers.id, serverId)))
        .then((r) => r[0] ?? null);
      return row ? toServer(row) : null;
    },

    async getServerBySlug(companyId, slug) {
      const row = await db
        .select({ id: myrmidonFleetServers.id })
        .from(myrmidonFleetServers)
        .where(and(eq(myrmidonFleetServers.companyId, companyId), eq(myrmidonFleetServers.slug, slug)))
        .then((r) => r[0] ?? null);
      return row;
    },

    async updateServerOnboard(companyId, serverId, patch) {
      await db
        .update(myrmidonFleetServers)
        .set({
          ...(patch.onboardState ? { onboardState: patch.onboardState } : {}),
          ...(patch.hostKeyFingerprint !== undefined ? { hostKeyFingerprint: patch.hostKeyFingerprint } : {}),
          ...(patch.accessKeySecretKey !== undefined ? { accessKeySecretKey: patch.accessKeySecretKey } : {}),
          ...(patch.bootstrapVersion !== undefined ? { bootstrapVersion: patch.bootstrapVersion } : {}),
          ...(patch.lastCheckOk !== undefined ? { lastCheckOk: patch.lastCheckOk, lastCheckAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(myrmidonFleetServers.companyId, companyId), eq(myrmidonFleetServers.id, serverId)));
    },
  };
}

// myrmidon(SERVER-ONBOARD A): the onboarding job lifecycle.
//
// The board never runs SSH. It owns the registry, the job queue and the
// secrets: create the server row, stash the password / generated key pair in
// the panel secret store (names only in the registry), create the job, and let
// the fleet-onboard executor claim it through the API. Every executor report
// lands on the job's step log; a failure leaves the server in
// `needs_attention` with the step name, never half-configured silently.
//
// Invariants the service keeps:
// - write routes answer 503 unless MYRMIDON_FLEET_ONBOARD_ENABLED=1;
// - at most one open job per server (partial unique index; createJob maps the
//   violation to a 409 the UI can show);
// - secrets are written before the registry names them, and the bootstrap
//   password is deleted only after successful onboarding with verified stored-key login
//   (unless the owner chose to keep it);
// - executor claims/reports require the shared executor token;
// - one-time secret handoff: the claim response carries values exactly once
//   and they never touch the step log (maskStepDetail re-masks detail).

import { randomUUID } from "node:crypto";
import { generateSshKeyPair, sshPublicKey } from "./ssh-key.js";
import { parseOwnedFleetResource } from "@myrmidon/shared";
import type { Db } from "@myrmidon/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { secretService } from "../../services/secrets.js";
import {
  canRetryOnboardJob,
  isOnboardJobActive,
  type OnboardJob,
  type OnboardStepLogEntry,
} from "./domain.js";
import { readFleetOnboardSettings, type FleetOnboardSettings } from "./settings.js";
import type { FleetOnboardStore, OnboardJobClaim } from "./store.js";

export class OnboardServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OnboardServiceError";
    this.status = status;
  }
}

export const ONBOARD_DISABLED_MESSAGE =
  "Fleet onboarding is disabled on this instance. Set MYRMIDON_FLEET_ONBOARD_ENABLED=1 to allow adding servers.";

export interface OnboardSecretPort {
  /** Create (or replace) a company secret; returns the secret NAME. */
  putSecret(companyId: string, name: string, key: string, value: string, description: string): Promise<string>;
  /** Resolve a secret value by NAME, for the executor's one-time handoff. */
  readSecret(companyId: string, name: string): Promise<string | null>;
  /** Delete the bootstrap password after key login is verified. */
  deleteSecret(companyId: string, name: string): Promise<void>;
}

/** Default port over the panel secret service: local_encrypted, SYSTEM actor. */
export function panelSecretPort(db: Db): OnboardSecretPort {
  const secrets = secretService(db);
  return {
    async putSecret(companyId, name, key, value, description) {
      const existing = await secrets.getByName(companyId, name);
      if (existing) {
        await secrets.rotate(existing.id, { value });
        return existing.name;
      }
      const created = await secrets.create(
        companyId,
        { name, provider: "local_encrypted", value, key, description },
      );
      return created.name;
    },
    async readSecret(companyId, name) {
      const secret = await secrets.getByName(companyId, name);
      if (!secret) return null;
      return secrets.resolveSecretValue(companyId, secret.id, "latest");
    },
    async deleteSecret(companyId, name) {
      const secret = await secrets.getByName(companyId, name);
      if (secret) await secrets.remove(secret.id);
    },
  };
}

export interface OnboardServiceDeps {
  store: FleetOnboardStore;
  settings: FleetOnboardSettings;
  secrets: OnboardSecretPort;
  /** Registry row by id, for the claim payload and the report transitions. */
  getServer(companyId: string, serverId: string): Promise<{
    id: string;
    slug: string;
    hostname: string;
    port: number;
    username: string;
    protocol: string;
    passwordSecretKey: string | null;
    accessKeySecretKey: string | null;
    hostKeyFingerprint: string | null;
    role: string;
    keepPassword: boolean;
  } | null>;
  /** Registry row by slug, for the add-server uniqueness check. */
  getServerBySlug?(companyId: string, slug: string): Promise<{ id: string } | null>;
  generateKeyPair?(): { publicKey: string; privateKey: string };
  logActivity?: typeof logActivity;
}

export interface StartOnboardResult {
  job: OnboardJob;
  /** Registry id of the created server row. */
  serverId: string;
  /** Set when auth=generate-key: the public half to paste at the provider. */
  generatedPublicKey: string | null;
}

export function onboardService(db: Db, deps: OnboardServiceDeps) {
  const audit = deps.logActivity ?? ((dbArg: Db, entry: Parameters<typeof logActivity>[1]) => logActivity(dbArg, entry));

  function requireEnabled(): void {
    if (!deps.settings.enabled) throw new OnboardServiceError(503, ONBOARD_DISABLED_MESSAGE);
  }

  function requireExecutorToken(presented: string | null | undefined): void {
    const expected = deps.settings.executorToken;
    if (!expected) throw new OnboardServiceError(503, "Fleet onboarding executor token is not configured");
    if (presented !== expected) throw new OnboardServiceError(401, "Invalid fleet onboarding executor token");
  }

  async function writeAudit(companyId: string, action: string, entityId: string, details: Record<string, unknown>) {
    try {
      await audit(db, {
        companyId,
        actorType: "system",
        actorId: "myrmidon-server-onboard",
        action: `myrmidon.fleet_onboard.${action}`,
        entityType: "myrmidon_fleet_server",
        entityId,
        details,
      });
    } catch (err) {
      logger.error({ err, entityId, action }, "failed to write onboard activity");
    }
  }

  function secretName(slug: string, attemptId: string, kind: "bootstrap-password" | "access-key"): string {
    return `fleet/${slug}/${attemptId}/${kind}`;
  }

  // The sweep has no natural company scope; the activity row is instance-level.
  const claimlessAuditCompany = "";
  const claimlessAuditEntity = "fleet-onboard-sweep";

  return {
    async pinHostKey(presentedToken: string | null | undefined, companyId: string, jobId: string, fingerprint: string): Promise<boolean> {
      requireEnabled();
      requireExecutorToken(presentedToken);
      const job = await deps.store.getJob(companyId, jobId);
      if (!job) throw new OnboardServiceError(404, "Job not found");
      if (!["claimed", "running"].includes(job.status)) throw new OnboardServiceError(409, "Host pin requires an active job");
      return deps.store.pinHostKey(companyId, job.serverId, job.id, fingerprint);
    },

    /** The authenticated executor reports identities, never arbitrary cleanup commands. */
    async recordOwnedResource(presentedToken: string | null | undefined, companyId: string, jobId: string, value: unknown) {
      requireEnabled();
      requireExecutorToken(presentedToken);
      const job = await deps.store.getJob(companyId, jobId);
      if (!job) throw new OnboardServiceError(404, "Job not found");
      if (job.kind !== "onboard" || !["claimed", "running"].includes(job.status)) {
        throw new OnboardServiceError(409, "Ownership requires an active onboard job");
      }
      let resource;
      try { resource = parseOwnedFleetResource(value); }
      catch { throw new OnboardServiceError(400, "Invalid owned resource identity"); }
      const inventory = await deps.store.recordOwnedResource(companyId, job.serverId, jobId, resource);
      await writeAudit(companyId, "resource_owned", job.serverId, { jobId, kind: resource.kind });
      return inventory;
    },

    /** Add a server: registry row + secret stash + pending onboard job. */
    async addServer(input: {
      companyId: string;
      slug: string;
      name: string;
      hostname: string;
      port: number;
      username: string;
      role: string;
      keepPassword: boolean;
      auth: { type: "password"; password: string } | { type: "generate-key" };
      createdBy: string | null;
    }): Promise<StartOnboardResult> {
      requireEnabled();
      const existing = await deps.getServerBySlug?.(input.companyId, input.slug);
      if (existing) throw new OnboardServiceError(409, `Server slug already exists: ${input.slug}`);

      // Each attempt owns its secrets; losing the slug race cannot affect the winner.
      const attemptId = randomUUID();
      const keepPassword = input.auth.type === "password" && input.keepPassword && deps.settings.allowKeepPassword;
      let generatedPublicKey: string | null = null;
      let passwordSecretName: string | null = null;
      let accessKeySecretName: string | null = null;

      let created: Awaited<ReturnType<FleetOnboardStore["createServerAndJob"]>>;
      try {
        if (input.auth.type === "password") {
          passwordSecretName = await deps.secrets.putSecret(
            input.companyId,
            secretName(input.slug, attemptId, "bootstrap-password"),
            `fleet-${attemptId}-bootstrap-password`,
            input.auth.password,
            "SERVER-ONBOARD: one-time bootstrap password",
          );
        }
        const pair = (deps.generateKeyPair ?? defaultGenerateKeyPair)();
        accessKeySecretName = await deps.secrets.putSecret(
          input.companyId,
          secretName(input.slug, attemptId, "access-key"),
          `fleet-${attemptId}-access-key`,
          pair.privateKey,
          "SERVER-ONBOARD: board access key (private)",
        );
        if (input.auth.type === "generate-key") generatedPublicKey = pair.publicKey;

        // Registry row (secret names in, values never), then the pending job.
        created = await deps.store.createServerAndJob(input.companyId, {
          slug: input.slug,
          name: input.name,
          hostname: input.hostname,
          port: input.port,
          username: input.username,
          role: input.role,
          passwordSecretKey: passwordSecretName,
          accessKeySecretKey: accessKeySecretName,
          keepPassword,
          createdBy: input.createdBy,
        });
      } catch (error) {
        if (passwordSecretName) await deps.secrets.deleteSecret(input.companyId, passwordSecretName).catch(() => {});
        if (accessKeySecretName) await deps.secrets.deleteSecret(input.companyId, accessKeySecretName).catch(() => {});
        throw error;
      }
      const { server, job } = created;
      await writeAudit(input.companyId, "server_added", server.id, {
        slug: server.slug,
        hostname: server.hostname,
        role: server.role,
        auth: input.auth.type,
      });
      return { job, generatedPublicKey, serverId: server.id };
    },

    /** Start a subsequent onboard or recheck job for an existing server. */
    async startJob(input: { companyId: string; serverId: string; kind: "onboard" | "recheck"; createdBy: string | null }): Promise<OnboardJob> {
      requireEnabled();
      const server = await deps.getServer(input.companyId, input.serverId);
      if (!server) throw new OnboardServiceError(404, "Server not found");
      const existing = await deps.store.listJobs(input.companyId, input.serverId);
      const active = existing.find((j) => isOnboardJobActive(j.status));
      if (active) {
        throw new OnboardServiceError(
          409,
          `An onboarding job for server ${input.serverId} is already in progress (status ${active.status})`,
        );
      }
      await deps.store.updateServerOnboard(input.companyId, input.serverId, { onboardState: "onboarding" });
      const job = await deps.store.createJob({
        companyId: input.companyId,
        serverId: input.serverId,
        kind: input.kind,
        createdBy: input.createdBy,
      });
      await writeAudit(input.companyId, "job_started", input.serverId, { jobId: job.id, kind: input.kind });
      return job;
    },

    /** Retry an onboarding job for a server that failed or needs attention. */
    async retry(input: { companyId: string; serverId: string; createdBy?: string | null }): Promise<OnboardJob> {
      requireEnabled();
      const server = await deps.store.getServerById(input.companyId, input.serverId);
      if (!server) throw new OnboardServiceError(404, "Server not found");
      const existing = await deps.store.listJobs(input.companyId, input.serverId);
      const active = existing.find((j) => isOnboardJobActive(j.status));
      if (active) {
        throw new OnboardServiceError(
          409,
          `An onboarding job for server ${input.serverId} is already in progress (status ${active.status})`,
        );
      }
      const lastJob = existing[0];
      if (lastJob && !canRetryOnboardJob(lastJob.status) && server.onboardState !== "needs_attention") {
        throw new OnboardServiceError(
          409,
          `Server ${input.serverId} is not in a retriable state (state: ${server.onboardState}, last job status: ${lastJob.status})`,
        );
      }
      await deps.store.updateServerOnboard(input.companyId, input.serverId, { onboardState: "onboarding" });
      const job = await deps.store.createJob({
        companyId: input.companyId,
        serverId: input.serverId,
        kind: lastJob?.kind ?? "onboard",
        createdBy: input.createdBy ?? null,
      });
      await writeAudit(input.companyId, "job_retried", input.serverId, {
        jobId: job.id,
        kind: job.kind,
        previousJobId: lastJob?.id ?? null,
      });
      return job;
    },

    /** Resume an onboarding job: returns the existing active job if running, or retries if failed/needs_attention. */
    async resume(input: { companyId: string; serverId: string; createdBy?: string | null }): Promise<OnboardJob> {
      requireEnabled();
      const server = await deps.getServer(input.companyId, input.serverId);
      if (!server) throw new OnboardServiceError(404, "Server not found");
      const existing = await deps.store.listJobs(input.companyId, input.serverId);
      const active = existing.find((j) => isOnboardJobActive(j.status));
      if (active) {
        await writeAudit(input.companyId, "job_resumed", input.serverId, { jobId: active.id, kind: active.kind });
        return active;
      }
      return this.retry(input);
    },

    /** Executor entry: claim the next pending job and get its one-time secrets. */
    async claim(companyId: string, presentedToken: string | null | undefined): Promise<(OnboardJobClaim & { secretValues: Record<string, string> }) | null> {
      requireEnabled();
      requireExecutorToken(presentedToken);
      const claim = await deps.store.claimNext(companyId);
      if (!claim) return null;
      if (!(await deps.store.consumeClaimSecrets(companyId, claim.job.id))) {
        throw new OnboardServiceError(409, "Onboarding job secrets have already been consumed");
      }
      const secretValues: Record<string, string> = {};
      const wanted: Array<[string | null, string]> = [
        [claim.server.passwordSecretKey, "bootstrapPassword"],
        [claim.server.accessKeySecretKey, "accessKey"],
      ];
      try {
        for (const [name, slot] of wanted) {
          if (!name) continue;
          const value = await deps.secrets.readSecret(claim.job.companyId, name);
          if (value) secretValues[slot] = value;
        }
      } catch {
        // Do not expose secret-provider errors or leave a consumed claim running.
        await deps.store.updateJob(companyId, claim.job.id, { status: "failed", error: "Unable to retrieve onboarding credentials" });
        await deps.store.updateServerOnboard(companyId, claim.job.serverId, { onboardState: "needs_attention" });
        throw new OnboardServiceError(503, "Unable to retrieve onboarding credentials");
      }
      await writeAudit(claim.job.companyId, "job_claimed", claim.job.serverId, { jobId: claim.job.id, kind: claim.job.kind });
      return { ...claim, secretValues };
    },

    /** Executor report after each step; also the terminal transition. */
    async report(
      presentedToken: string | null | undefined,
      input: { companyId: string; jobId: string; step?: string; entry?: OnboardStepLogEntry; status?: OnboardJob["status"]; error?: string | null; hostKeyFingerprint?: string | null; verifiedAccessPublicKey?: string },
    ): Promise<OnboardJob | null> {
      requireEnabled();
      requireExecutorToken(presentedToken);
      const job = await deps.store.getJob(input.companyId, input.jobId);
      if (!job) throw new OnboardServiceError(404, "Job not found");
      if (job.status !== "claimed" && job.status !== "running") {
        throw new OnboardServiceError(409, "Onboarding job is no longer active");
      }

      let bootstrapToDelete: string | null = null;
      // The authenticated worker attests to fresh key-only login. Match that
      // attestation against the current pin and the key in protected storage.
      if (job.kind === "onboard" && input.status === "succeeded" && input.verifiedAccessPublicKey !== undefined) {
        const server = await deps.getServer(job.companyId, job.serverId);
        if (!server?.hostKeyFingerprint || server.hostKeyFingerprint !== input.hostKeyFingerprint ||
            !server.accessKeySecretKey || !job.stepLog.some((step) => step.step === "access" && step.result === "ok")) {
          throw new OnboardServiceError(409, "Cannot confirm verified onboarding access");
        }
        let publicKey: string | null = null;
        try {
          const key = await deps.secrets.readSecret(job.companyId, server.accessKeySecretKey);
          if (key) publicKey = sshPublicKey(key);
        } catch {
          throw new OnboardServiceError(503, "Unable to confirm stored onboarding key");
        }
        if (publicKey !== input.verifiedAccessPublicKey) {
          throw new OnboardServiceError(409, "Verified access key does not match protected storage");
        }
        if (!server.keepPassword) bootstrapToDelete = server.passwordSecretKey;
      }

      const updated = await deps.store.updateJob(input.companyId, input.jobId, {
        requireClaimed: true,
        status: input.status,
        step: input.step ?? (input.status ? null : undefined),
        stepLogEntry: input.entry,
        error: input.error ?? undefined,
      });
      if (!updated) throw new OnboardServiceError(409, "Onboarding job is no longer active");

      // Server state follows the job.
      const isFailed = input.status === "failed" || input.entry?.result === "failed";
      if (input.status === "succeeded") {
        const nextState = job.kind === "decommission" ? "decommissioned" : "ready";
        await deps.store.updateServerOnboard(job.companyId, job.serverId, {
          onboardState: nextState,
          lastCheckOk: job.kind !== "decommission",
        });
      } else if (isFailed) {
        await deps.store.updateServerOnboard(job.companyId, job.serverId, { onboardState: "needs_attention" });
      } else if (input.entry?.step === "access" && input.entry.result === "ok") {
        await deps.store.updateServerOnboard(job.companyId, job.serverId, { onboardState: "onboarding" });
        // Intermediate reports never retire the bootstrap credential.
      }
      if (bootstrapToDelete) {
        // Cleanup is after the terminal transition. A failed cleanup must not
        // turn an already committed success into a rollback at the worker.
        try {
          await deps.secrets.deleteSecret(job.companyId, bootstrapToDelete);
        } catch {
          await writeAudit(job.companyId, "bootstrap_password_cleanup_failed", job.serverId, { jobId: job.id });
        }
      }
      const actionName = input.status ? `job_${input.status}` : isFailed ? "job_failed" : "step_reported";
      await writeAudit(job.companyId, actionName, job.serverId, {
        jobId: job.id,
        step: input.entry?.step ?? input.step ?? null,
        result: input.entry?.result ?? null,
      });
      return updated;
    },

    /** Owner-facing job list/detail. */
    async listJobs(companyId: string, serverId?: string) {
      return deps.store.listJobs(companyId, serverId);
    },

    async getJob(companyId: string, jobId: string) {
      return deps.store.getJob(companyId, jobId);
    },

    /** Sweep: expire jobs whose executor went silent. */
    async tick(): Promise<{ expired: number }> {
      if (!deps.settings.enabled) return { expired: 0 };
      const expired = await deps.store.expireStale(deps.settings.stepTimeoutMs);
      if (expired > 0) {
        await writeAudit(claimlessAuditCompany, "jobs_expired", claimlessAuditEntity, { expired }).catch(() => undefined);
      }
      return { expired };
    },
  };
}

function defaultGenerateKeyPair(): { publicKey: string; privateKey: string } {
  return generateSshKeyPair();
}

export type OnboardService = ReturnType<typeof onboardService>;

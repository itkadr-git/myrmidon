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
//   password is deleted after the access step reports key login verified
//   (unless the owner chose to keep it);
// - executor claims/reports require the shared executor token;
// - one-time secret handoff: the claim response carries values exactly once
//   and they never touch the step log (maskStepDetail re-masks detail).

import { generateKeyPairSync } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { secretService } from "../../services/secrets.js";
import {
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

  function secretName(slug: string, kind: "bootstrap-password" | "access-key"): string {
    return `fleet/${slug}/${kind}`;
  }

  // The sweep has no natural company scope; the activity row is instance-level.
  const claimlessAuditCompany = "";
  const claimlessAuditEntity = "fleet-onboard-sweep";

  return {
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

      const keepPassword = input.auth.type === "password" && input.keepPassword && deps.settings.allowKeepPassword;
      let generatedPublicKey: string | null = null;
      let passwordSecretName: string | null = null;
      let accessKeySecretName: string | null = null;

      if (input.auth.type === "password") {
        passwordSecretName = await deps.secrets.putSecret(
          input.companyId,
          secretName(input.slug, "bootstrap-password"),
          `fleet-${input.slug}-bootstrap-password`,
          input.auth.password,
          "SERVER-ONBOARD: one-time bootstrap password",
        );
      } else {
        const pair = (deps.generateKeyPair ?? defaultGenerateKeyPair)();
        accessKeySecretName = await deps.secrets.putSecret(
          input.companyId,
          secretName(input.slug, "access-key"),
          `fleet-${input.slug}-access-key`,
          pair.privateKey,
          "SERVER-ONBOARD: board access key (private)",
        );
        generatedPublicKey = pair.publicKey;
      }

      // Registry row (secret names in, values never), then the pending job.
      let created: Awaited<ReturnType<FleetOnboardStore["createServerAndJob"]>>;
      try {
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
      for (const [name, slot] of wanted) {
        if (!name) continue;
        const value = await deps.secrets.readSecret(claim.job.companyId, name);
        if (value) secretValues[slot] = value;
      }
      await writeAudit(claim.job.companyId, "job_claimed", claim.job.serverId, { jobId: claim.job.id, kind: claim.job.kind });
      return { ...claim, secretValues };
    },

    /** Executor report after each step; also the terminal transition. */
    async report(
      presentedToken: string | null | undefined,
      input: { companyId: string; jobId: string; step?: string; entry?: OnboardStepLogEntry; status?: OnboardJob["status"]; error?: string | null; hostKeyFingerprint?: string | null },
    ): Promise<OnboardJob | null> {
      requireEnabled();
      requireExecutorToken(presentedToken);
      const job = await deps.store.getJob(input.companyId, input.jobId);
      if (!job) throw new OnboardServiceError(404, "Job not found");
      const updated = await deps.store.updateJob(input.companyId, input.jobId, {
        status: input.status,
        step: input.step ?? (input.status ? null : undefined),
        stepLogEntry: input.entry,
        error: input.error ?? undefined,
      });
      if (!updated) return null;

      // Server state follows the job.
      if (input.status === "succeeded") {
        await deps.store.updateServerOnboard(job.companyId, job.serverId, {
          onboardState: "ready",
          lastCheckOk: true,
          ...(input.hostKeyFingerprint ? { hostKeyFingerprint: input.hostKeyFingerprint } : {}),
        });
      } else if (input.status === "failed") {
        await deps.store.updateServerOnboard(job.companyId, job.serverId, { onboardState: "needs_attention" });
      } else if (input.entry?.step === "access" && input.entry.result === "ok") {
        await deps.store.updateServerOnboard(job.companyId, job.serverId, { onboardState: "onboarding" });
        const server = await deps.getServer(job.companyId, job.serverId);
        if (server?.passwordSecretKey && !server.accessKeySecretKey && !server.keepPassword) {
          // key login verified — the bootstrap password has done its job
          await deps.secrets.deleteSecret(job.companyId, server.passwordSecretKey);
        }
      }
      await writeAudit(job.companyId, input.status ? `job_${input.status}` : "step_reported", job.serverId, {
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
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export type OnboardService = ReturnType<typeof onboardService>;

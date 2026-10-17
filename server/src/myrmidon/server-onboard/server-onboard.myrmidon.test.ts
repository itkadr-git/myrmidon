import { describe, expect, it, vi } from "vitest";
import { onboardService, OnboardServiceError } from "./service.js";
import type { OnboardJob, OnboardJobKind, OnboardStepLogEntry } from "./domain.js";
import type { FleetOnboardStore, OnboardJobClaim } from "./store.js";
import type { FleetOnboardSettings } from "./settings.js";

const mockSettings: FleetOnboardSettings = {
  enabled: true,
  executorToken: "valid-executor-token",
  stepTimeoutMs: 3600000,
  tickMs: 60000,
  allowKeepPassword: true,
};

function createMocks() {
  const store: Record<string, any> = {
    servers: [] as any[],
    jobs: [] as any[],
  };

  const mockStore: FleetOnboardStore = {
    async createServer(companyId, input) {
      const server = {
        id: `server-${store.servers.length + 1}`,
        companyId,
        slug: input.slug,
        name: input.name,
        hostname: input.hostname,
        port: input.port,
        username: input.username,
        role: input.role,
        passwordSecretKey: input.passwordSecretKey ?? null,
        accessKeySecretKey: input.accessKeySecretKey ?? null,
        hostKeyFingerprint: null,
        onboardState: "new" as const,
      };
      store.servers.push(server);
      return server as any;
    },
    async createJob(input) {
      const job: OnboardJob = {
        id: `job-${store.jobs.length + 1}`,
        companyId: input.companyId,
        serverId: input.serverId,
        kind: input.kind,
        status: "pending",
        step: "init",
        stepLog: [],
        error: null,
        createdBy: input.createdBy,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.jobs.push(job);
      return job;
    },
    async claimNext() {
      const job = store.jobs.find((j: any) => j.status === "pending");
      if (!job) return null;
      job.status = "claimed";
      job.startedAt = new Date().toISOString();
      const server = store.servers.find((s: any) => s.id === job.serverId);
      return {
        job,
        server: {
          id: server.id,
          slug: server.slug,
          hostname: server.hostname,
          port: server.port,
          username: server.username,
          protocol: "ssh",
          passwordSecretKey: server.passwordSecretKey,
          accessKeySecretKey: server.accessKeySecretKey,
          hostKeyFingerprint: server.hostKeyFingerprint,
        },
        steps: ["access", "harden", "agent", "docker", "ready"],
        options: {
          keepPassword: false,
          installDocker: true,
          role: "build-runner",
        },
      };
    },
    async getJobById(jobId) {
      return store.jobs.find((j: any) => j.id === jobId) ?? null;
    },
    async getJob(companyId, jobId) {
      return store.jobs.find((j: any) => j.id === jobId && j.companyId === companyId) ?? null;
    },
    async getServerBySlug(companyId, slug) {
      return store.servers.find((s: any) => s.companyId === companyId && s.slug === slug) ?? null;
    },
    async getServerById(companyId, serverId) {
      return store.servers.find((s: any) => s.id === serverId && s.companyId === companyId) ?? null;
    },
    async updateJob(jobId, patch) {
      const job = store.jobs.find((j: any) => j.id === jobId);
      if (!job) return null;
      if (patch.status !== undefined) job.status = patch.status;
      if (patch.step !== undefined) job.step = patch.step;
      if (patch.stepLogEntry !== undefined && patch.stepLogEntry) job.stepLog.push(patch.stepLogEntry);
      if (patch.error !== undefined) job.error = patch.error;
      job.updatedAt = new Date().toISOString();
      return job;
    },
    async updateServerOnboard(companyId, serverId, patch) {
      const server = store.servers.find((s: any) => s.id === serverId && s.companyId === companyId);
      if (!server) return null;
      if (patch.onboardState !== undefined) server.onboardState = patch.onboardState;
      if (patch.hostKeyFingerprint !== undefined) server.hostKeyFingerprint = patch.hostKeyFingerprint;
      return server as any;
    },
    async listJobs(companyId, serverId) {
      return store.jobs.filter((j: any) => j.companyId === companyId && (!serverId || j.serverId === serverId));
    },
    async expireStale() {
      return 0;
    },
  };

  const secretsStore: Record<string, string> = {};
  const mockSecrets = {
    putSecret: async (companyId: string, name: string, key: string, value: string) => {
      secretsStore[name] = value;
      return name;
    },
    readSecret: async (companyId: string, name: string) => {
      return secretsStore[name] ?? null;
    },
    deleteSecret: async (companyId: string, name: string) => {
      delete secretsStore[name];
    },
  };

  const mockGetServer = async (companyId: string, serverId: string) => {
    const server = store.servers.find((s: any) => s.id === serverId && s.companyId === companyId);
    if (!server) return null;
    return {
      id: server.id,
      slug: server.slug,
      hostname: server.hostname,
      port: server.port,
      username: server.username,
      protocol: "ssh",
      passwordSecretKey: server.passwordSecretKey,
      accessKeySecretKey: server.accessKeySecretKey,
      hostKeyFingerprint: server.hostKeyFingerprint,
      role: server.role,
    };
  };

  return { store, mockStore, secretsStore, mockSecrets, mockGetServer };
}

describe("SERVER-ONBOARD logic", () => {
  it("enforces disabled message when disabled", async () => {
    const { mockStore, mockSecrets, mockGetServer } = createMocks();
    const service = onboardService(null as any, {
      store: mockStore,
      settings: { ...mockSettings, enabled: false },
      secrets: mockSecrets,
      getServer: mockGetServer,
    });

    await expect(
      service.addServer({
        companyId: "company-1",
        slug: "test-server",
        name: "Test Server",
        hostname: "127.0.0.1",
        port: 22,
        username: "root",
        role: "generic",
        keepPassword: true,
        auth: { type: "password", password: "secret-password" },
        createdBy: "actor-1",
      }),
    ).rejects.toThrow(OnboardServiceError);
  });

  it("adds server and claims / reports correctly", async () => {
    const { mockStore, mockSecrets, mockGetServer, secretsStore, store } = createMocks();
    const service = onboardService(null as any, {
      store: mockStore,
      settings: mockSettings,
      secrets: mockSecrets,
      getServer: mockGetServer,
    });

    // 1. Add server
    const result = await service.addServer({
      companyId: "company-1",
      slug: "srv-1",
      name: "Srv 1",
      hostname: "192.0.2.1",
      port: 2222,
      username: "deploy",
      role: "build-runner",
      keepPassword: false,
      auth: { type: "password", password: "pwd-1" },
      createdBy: "actor-1",
    });

    expect(result.serverId).toBe("server-1");
    expect(result.generatedPublicKey).toBeNull();
    expect(secretsStore["fleet/srv-1/bootstrap-password"]).toBe("pwd-1");

    expect(store.servers[0]).toMatchObject({
      slug: "srv-1",
      name: "Srv 1",
      hostname: "192.0.2.1",
      port: 2222,
      username: "deploy",
      role: "build-runner",
      passwordSecretKey: "fleet/srv-1/bootstrap-password",
      accessKeySecretKey: null,
      onboardState: "new",
    });

    expect(store.jobs[0]).toMatchObject({
      serverId: "server-1",
      kind: "onboard",
      status: "pending",
    });

    // 2. Claim
    const claim = await service.claim("valid-executor-token");
    expect(claim).not.toBeNull();
    expect(claim?.job.id).toBe("job-1");
    expect(claim?.secretValues.bootstrapPassword).toBe("pwd-1");

    // 3. Report access step ok
    const stepEntry: OnboardStepLogEntry = {
      step: "access",
      result: "ok",
      detail: "logged in with password and installed key",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };

    const jobAfterReport = await service.report("valid-executor-token", {
      jobId: "job-1",
      entry: stepEntry,
    });

    expect(jobAfterReport?.stepLog).toContainEqual(stepEntry);
    expect(store.servers[0].onboardState).toBe("onboarding");
    // Password deleted because keepPassword was false and access key verified
    expect(secretsStore["fleet/srv-1/bootstrap-password"]).toBeUndefined();

    // 4. Report final success
    const finalJob = await service.report("valid-executor-token", {
      jobId: "job-1",
      status: "succeeded",
      hostKeyFingerprint: "SHA256:fingerprint",
    });

    expect(finalJob?.status).toBe("succeeded");
    expect(store.servers[0].onboardState).toBe("ready");
    expect(store.servers[0].hostKeyFingerprint).toBe("SHA256:fingerprint");
  });

  it("can start subsequent job", async () => {
    const { mockStore, mockSecrets, mockGetServer, store } = createMocks();
    const service = onboardService(null as any, {
      store: mockStore,
      settings: mockSettings,
      secrets: mockSecrets,
      getServer: mockGetServer,
    });

    await service.addServer({
      companyId: "company-1",
      slug: "srv-2",
      name: "Srv 2",
      hostname: "192.0.2.2",
      port: 22,
      username: "root",
      role: "generic",
      keepPassword: true,
      auth: { type: "generate-key" },
      createdBy: "actor-1",
    });

    expect(store.servers[0].onboardState).toBe("new");

    // Start subsequent recheck job
    const job = await service.startJob({
      companyId: "company-1",
      serverId: "server-1",
      kind: "recheck",
      createdBy: "actor-2",
    });

    expect(job.kind).toBe("recheck");
    expect(store.servers[0].onboardState).toBe("onboarding");
  });
});

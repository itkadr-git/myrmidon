import { describe, expect, it, vi } from "vitest";
import { onboardService, OnboardServiceError } from "./service.js";
import type { OnboardJob, OnboardJobKind, OnboardStepLogEntry } from "./domain.js";
import type { FleetOnboardStore, OnboardJobClaim } from "./store.js";
import type { FleetOnboardSettings } from "./settings.js";
import { appendOwnedFleetResource } from "@myrmidon/shared";
import { sshPublicKey } from "./ssh-key.js";

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

  const createServer = async (companyId: string, input: any) => {

      const server = {
        id: `server-${store.servers.length + 1}`,
        companyId,
        slug: input.slug,
        name: input.name,
        hostname: input.hostname,
        port: input.port,
        username: input.username,
        role: input.role,
        keepPassword: input.keepPassword,
        passwordSecretKey: input.passwordSecretKey ?? null,
        accessKeySecretKey: input.accessKeySecretKey ?? null,
        hostKeyFingerprint: null,
        onboardState: "new" as const,
      };
      store.servers.push(server);
      return server as any;
  };
  const createJob = async (input: any) => {
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
  };
  const mockStore: FleetOnboardStore = {
    async pinHostKey(companyId, serverId, jobId, fingerprint) {
      const job = store.jobs.find((j: any) => j.id === jobId && j.companyId === companyId && j.serverId === serverId && ["claimed", "running"].includes(j.status));
      const server = store.servers.find((s: any) => s.id === serverId && s.companyId === companyId);
      if (!job || !server || (server.hostKeyFingerprint && server.hostKeyFingerprint !== fingerprint)) return false;
      server.hostKeyFingerprint = fingerprint;
      return true;
    },
    async recordOwnedResource(companyId, serverId, jobId, resource) {
      const server = store.servers.find((s: any) => s.id === serverId && s.companyId === companyId);
      if (!server) throw new Error("server not found");
      server.ownershipInventory = appendOwnedFleetResource(server.ownershipInventory ?? null, companyId, serverId, jobId, resource);
      return server.ownershipInventory;
    },
    async createServer() { throw new Error("createServer should not be called"); },
    async createServerAndJob(companyId, input) {
      const server = await createServer(companyId, input);
      const job = await createJob({ companyId, serverId: server.id, kind: "onboard", createdBy: input.createdBy });
      return { server, job };
    },
    async createJob(input) { return createJob(input); },
    async claimNext(companyId: string) {
      const job = store.jobs.find((j: any) => j.status === "pending" && j.companyId === companyId);
      if (!job) return null;
      job.status = "claimed";
      if (!job.startedAt) job.startedAt = new Date().toISOString();
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
          keepPassword: server.keepPassword ?? false,
          accessKeySecretKey: server.accessKeySecretKey,
          hostKeyFingerprint: server.hostKeyFingerprint,
        },
        steps: ["access", "harden", "agent", "docker", "ready"],
        options: {
          keepPassword: server.keepPassword ?? false,
          installDocker: true,
          role: "build-runner",
        },
      };
    },
    async consumeClaimSecrets(companyId, jobId) {
      const job = store.jobs.find((j: any) => j.id === jobId && j.companyId === companyId);
      if (!job || job.secretConsumed) return false;
      job.secretConsumed = true;
      return true;
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
    async updateJob(companyId, jobId, patch) {
      const job = store.jobs.find((j: any) => j.id === jobId && j.companyId === companyId);
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
      return store.jobs
        .filter((j: any) => j.companyId === companyId && (!serverId || j.serverId === serverId))
        .slice()
        .reverse();
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
      keepPassword: server.keepPassword ?? false,
    };
  };

  return { store, mockStore, secretsStore, mockSecrets, mockGetServer };
}

describe("SERVER-ONBOARD logic", () => {
  it("preserves existing credentials if a concurrent add for the same slug fails", async () => {
    const { mockStore, mockSecrets, mockGetServer, secretsStore, store } = createMocks();
    const service = onboardService(null as any, { store: mockStore, settings: mockSettings, secrets: mockSecrets, getServer: mockGetServer });
    const input = { companyId: "company-1", slug: "concurrent", name: "Server", hostname: "192.0.2.7", port: 22, username: "root", role: "generic", keepPassword: false, auth: { type: "password" as const, password: "original" }, createdBy: null };
    await service.addServer(input);
    const { passwordSecretKey, accessKeySecretKey } = store.servers[0];
    const originalKey = secretsStore[accessKeySecretKey];
    mockStore.createServerAndJob = async () => { throw new Error("duplicate slug"); };

    await expect(service.addServer({ ...input, auth: { type: "password", password: "replacement" } })).rejects.toThrow("duplicate slug");
    expect(secretsStore[passwordSecretKey]).toBe("original");
    expect(secretsStore[accessKeySecretKey]).toBe(originalKey);
    expect(Object.keys(secretsStore).sort()).toEqual([passwordSecretKey, accessKeySecretKey].sort());
  });

  it("isolates concurrent attempts until the registry picks a winner", async () => {
    const { mockStore, mockSecrets, mockGetServer, secretsStore, store } = createMocks();
    const create = mockStore.createServerAndJob;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let arrivals = 0;
    mockStore.createServerAndJob = async (companyId, input) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
      if (store.servers.length) throw new Error("duplicate slug");
      return create(companyId, input);
    };
    const service = onboardService(null as any, { store: mockStore, settings: mockSettings, secrets: mockSecrets, getServer: mockGetServer });
    const input = { companyId: "company-1", slug: "race", name: "Server", hostname: "192.0.2.7", port: 22, username: "root", role: "generic", keepPassword: false, auth: { type: "password" as const, password: "first" }, createdBy: null };
    const results = await Promise.allSettled([service.addServer(input), service.addServer({ ...input, auth: { type: "password", password: "second" } })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const { passwordSecretKey, accessKeySecretKey } = store.servers[0];
    expect(["first", "second"]).toContain(secretsStore[passwordSecretKey]);
    expect(sshPublicKey(secretsStore[accessKeySecretKey])).toMatch(/^ssh-ed25519 /);
    expect(Object.keys(secretsStore).sort()).toEqual([passwordSecretKey, accessKeySecretKey].sort());
  });

  it("marks a job as needing attention if its durable key cannot be retrieved during claim", async () => {
    const { mockStore, mockSecrets, mockGetServer, store, secretsStore } = createMocks();
    const service = onboardService(null as any, { store: mockStore, settings: mockSettings, secrets: mockSecrets, getServer: mockGetServer });
    await service.addServer({ companyId: "company-1", slug: "interrupted-claim", name: "Server", hostname: "192.0.2.7", port: 22, username: "root", role: "generic", keepPassword: false, auth: { type: "password", password: "bootstrap" }, createdBy: null });
    const readSecret = mockSecrets.readSecret;
    mockSecrets.readSecret = async (companyId, name) => {
      if (name.endsWith("/access-key")) throw new Error("secret store unavailable");
      return readSecret(companyId, name);
    };

    await expect(service.claim("company-1", "valid-executor-token")).rejects.toThrow();
    expect(store.jobs[0].status).toBe("failed");
    expect(store.servers[0].onboardState).toBe("needs_attention");
    expect(secretsStore[store.servers[0].passwordSecretKey]).toBe("bootstrap");
  });

  it("does not claim an already claimed job while its executor is active", async () => {
    const { mockStore, mockSecrets, mockGetServer } = createMocks();
    const service = onboardService(null as any, { store: mockStore, settings: mockSettings, secrets: mockSecrets, getServer: mockGetServer });
    await service.addServer({ companyId: "company-1", slug: "active-job", name: "Server", hostname: "192.0.2.7", port: 22, username: "root", role: "generic", keepPassword: false, auth: { type: "password", password: "bootstrap" }, createdBy: null });
    expect(await service.claim("company-1", "valid-executor-token")).not.toBeNull();
    expect(await service.claim("company-1", "valid-executor-token")).toBeNull();
  });

  it("does not replace a verified host pin with a completion report", async () => {
    const { mockStore, mockSecrets, mockGetServer, store } = createMocks();
    const service = onboardService(null as any, { store: mockStore, settings: mockSettings, secrets: mockSecrets, getServer: mockGetServer });
    await service.addServer({ companyId: "company-1", slug: "pin-report", name: "Server", hostname: "192.0.2.7", port: 22, username: "root", role: "generic", keepPassword: false, auth: { type: "password", password: "bootstrap" }, createdBy: null });
    await service.claim("company-1", "valid-executor-token");
    expect(await service.pinHostKey("valid-executor-token", "company-1", "job-1", "SHA256:first")).toBe(true);
    await service.report("valid-executor-token", { companyId: "company-1", jobId: "job-1", status: "succeeded", hostKeyFingerprint: "SHA256:changed" });
    expect(store.servers[0].hostKeyFingerprint).toBe("SHA256:first");
  });

  it("persists the first host identity and rejects a conflicting identity before authentication", async () => {
    const { mockStore, mockSecrets, mockGetServer, store } = createMocks();
    const service = onboardService(null as any, { store: mockStore, settings: mockSettings, secrets: mockSecrets, getServer: mockGetServer });
    await service.addServer({ companyId: "company-1", slug: "host-pin", name: "Server", hostname: "192.0.2.7", port: 22, username: "root", role: "generic", keepPassword: false, auth: { type: "password", password: "bootstrap" }, createdBy: null });
    await service.claim("company-1", "valid-executor-token");
    expect(await service.pinHostKey("valid-executor-token", "company-1", "job-1", "SHA256:first")).toBe(true);
    expect(store.servers[0].hostKeyFingerprint).toBe("SHA256:first");
    expect(await service.pinHostKey("valid-executor-token", "company-1", "job-1", "SHA256:first")).toBe(true);
    expect(await service.pinHostKey("valid-executor-token", "company-1", "job-1", "SHA256:changed")).toBe(false);
    expect(store.servers[0].hostKeyFingerprint).toBe("SHA256:first");
    await expect(service.pinHostKey("wrong-token", "company-1", "job-1", "SHA256:first")).rejects.toMatchObject({ status: 401 });
    await expect(service.pinHostKey("valid-executor-token", "company-2", "job-1", "SHA256:first")).rejects.toMatchObject({ status: 404 });
  });

  it("persists a usable access key for password onboarding before the job is claimed", async () => {
    const { mockStore, mockSecrets, mockGetServer, store } = createMocks();
    const service = onboardService(null as any, { store: mockStore, settings: mockSettings, secrets: mockSecrets, getServer: mockGetServer });
    await service.addServer({ companyId: "company-1", slug: "password-key", name: "Server", hostname: "192.0.2.7", port: 22, username: "root", role: "generic", keepPassword: false, auth: { type: "password", password: "bootstrap" }, createdBy: null });
    const name = store.servers[0].accessKeySecretKey;
    expect(name).toMatch(/^fleet\/password-key\/[^/]+\/access-key$/);
    const stored = await mockSecrets.readSecret("company-1", name);
    expect(stored).toBeTruthy();
    expect(sshPublicKey(stored!)).toMatch(/^ssh-ed25519 /);
    const claim = await service.claim("company-1", "valid-executor-token");
    expect(claim?.secretValues.accessKey).toBe(stored);
    expect(claim?.secretValues.bootstrapPassword).toBe("bootstrap");
  });

  it("retrieves the persisted key after recreating the onboarding service", async () => {
    const { mockStore, mockSecrets, mockGetServer } = createMocks();
    const deps = { store: mockStore, settings: mockSettings, secrets: mockSecrets, getServer: mockGetServer };
    const first = onboardService(null as any, deps);
    const result = await first.addServer({ companyId: "company-1", slug: "recreated", name: "Server", hostname: "192.0.2.7", port: 22, username: "root", role: "generic", keepPassword: false, auth: { type: "generate-key" }, createdBy: null });

    const recreated = onboardService(null as any, deps);
    const claim = await recreated.claim("company-1", "valid-executor-token");
    const storedKey = claim?.secretValues.accessKey;
    expect(storedKey).toBeTruthy();
    if (!storedKey) throw new Error("recreated service did not retrieve the access key");
    expect(sshPublicKey(storedKey)).toBe(result.generatedPublicKey);
  });

  it("retains the bootstrap password when an access report has no durable key", async () => {
    const { mockStore, mockSecrets, mockGetServer, secretsStore, store } = createMocks();
    const service = onboardService(null as any, { store: mockStore, settings: mockSettings, secrets: mockSecrets, getServer: mockGetServer });
    await service.addServer({ companyId: "company-1", slug: "no-durable-key", name: "Server", hostname: "192.0.2.7", port: 22, username: "root", role: "generic", keepPassword: false, auth: { type: "password", password: "bootstrap" }, createdBy: null });
    await service.claim("company-1", "valid-executor-token");
    await service.report("valid-executor-token", { companyId: "company-1", jobId: "job-1", entry: { step: "access", result: "ok", detail: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } });
    expect(secretsStore[store.servers[0].passwordSecretKey]).toBe("bootstrap");
  });

  it("authenticates ownership reports and derives server scope from the active job", async () => {
    const { mockStore, mockSecrets, mockGetServer, store } = createMocks();
    const companyId = "11111111-1111-4111-8111-111111111111";
    const serverId = "22222222-2222-4222-8222-222222222222";
    const jobId = "33333333-3333-4333-8333-333333333333";
    store.servers.push({ id: serverId, companyId });
    store.jobs.push({ id: jobId, companyId, serverId, kind: "onboard", status: "claimed" });
    const service = onboardService(null as any, { store: mockStore, settings: mockSettings, secrets: mockSecrets,
      getServer: mockGetServer, logActivity: vi.fn().mockResolvedValue(undefined) });
    const resource = { kind: "role_container", containerId: "a".repeat(64) };
    await expect(service.recordOwnedResource("wrong", companyId, jobId, resource)).rejects.toMatchObject({ status: 401 });
    await expect(service.recordOwnedResource("valid-executor-token", serverId, jobId, resource)).rejects.toMatchObject({ status: 404 });
    const inventory = await service.recordOwnedResource("valid-executor-token", companyId, jobId, resource);
    expect(inventory).toMatchObject({ companyId, serverId, resources: [{ jobId, resource }] });
    expect(store.servers[0].ownershipInventory).toEqual(inventory);
    store.jobs[0].status = "succeeded";
    await expect(service.recordOwnedResource("valid-executor-token", companyId, jobId, resource)).rejects.toMatchObject({ status: 409 });
  });

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
    expect(secretsStore[store.servers[0].passwordSecretKey]).toBe("pwd-1");

    expect(store.servers[0]).toMatchObject({
      slug: "srv-1",
      name: "Srv 1",
      hostname: "192.0.2.1",
      port: 2222,
      username: "deploy",
      role: "build-runner",
      passwordSecretKey: expect.stringMatching(/^fleet\/srv-1\/[^/]+\/bootstrap-password$/),
      accessKeySecretKey: expect.stringMatching(/^fleet\/srv-1\/[^/]+\/access-key$/),
      onboardState: "new",
    });

    expect(store.jobs[0]).toMatchObject({
      serverId: "server-1",
      kind: "onboard",
      status: "pending",
    });

    // 2. Claim
    const claim = await service.claim("company-1", "valid-executor-token");
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
      companyId: "company-1",
      jobId: "job-1",
      entry: stepEntry,
    });

    expect(jobAfterReport?.stepLog).toContainEqual(stepEntry);
    expect(store.servers[0].onboardState).toBe("onboarding");
    // The report alone does not establish that a durable key exists.
    expect(secretsStore[store.servers[0].passwordSecretKey]).toBe("pwd-1");

    // 4. Report final success
    const finalJob = await service.report("valid-executor-token", {
      companyId: "company-1",
      jobId: "job-1",
      status: "succeeded",
      hostKeyFingerprint: "SHA256:fingerprint",
    });

    expect(finalJob?.status).toBe("succeeded");
    expect(store.servers[0].onboardState).toBe("ready");
    expect(store.servers[0].hostKeyFingerprint).toBeNull();
  });

  it("claims only the requested company and consumes a claim secret once", async () => {
    const { mockStore, mockSecrets, mockGetServer } = createMocks();
    const service = onboardService(null as any, { store: mockStore, settings: mockSettings, secrets: mockSecrets, getServer: mockGetServer });
    await service.addServer({ companyId: "company-a", slug: "tenant-a", name: "A", hostname: "192.0.2.4", port: 22, username: "root", role: "generic", keepPassword: false, auth: { type: "password", password: "pwd-a" }, createdBy: null });
    await service.addServer({ companyId: "company-b", slug: "tenant-b", name: "B", hostname: "192.0.2.5", port: 22, username: "root", role: "generic", keepPassword: false, auth: { type: "password", password: "pwd-b" }, createdBy: null });
    const claim = await service.claim("company-b", "valid-executor-token");
    expect(claim?.job.companyId).toBe("company-b");
    expect(await mockStore.consumeClaimSecrets("company-b", "job-2")).toBe(false);
  });

  it("persists the password-retention choice and deletes only when not retained", async () => {
    const { mockStore, mockSecrets, mockGetServer, secretsStore, store } = createMocks();
    const service = onboardService(null as any, { store: mockStore, settings: mockSettings, secrets: mockSecrets, getServer: mockGetServer });
    await service.addServer({ companyId: "company-1", slug: "retained", name: "Retained", hostname: "192.0.2.3", port: 22, username: "root", role: "generic", keepPassword: true, auth: { type: "password", password: "pwd-retained" }, createdBy: "actor-1" });
    expect(store.servers[0].keepPassword).toBe(true);
    await service.report("valid-executor-token", { companyId: "company-1", jobId: "job-1", entry: { step: "access", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), result: "ok", detail: null } });
    expect(secretsStore[store.servers[0].passwordSecretKey]).toBe("pwd-retained");
  });

  it("can start subsequent job", async () => {
    const { mockStore, mockSecrets, mockGetServer, store } = createMocks();
    const service = onboardService(null as any, {
      store: mockStore,
      settings: mockSettings,
      secrets: mockSecrets,
      getServer: mockGetServer,
    });

    const { serverId, job: initialJob } = await service.addServer({
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

    // Complete initial job before starting subsequent job
    await service.claim("company-1", "valid-executor-token");
    await service.report("valid-executor-token", {
      companyId: "company-1",
      jobId: initialJob.id,
      status: "succeeded",
    });

    // Start subsequent recheck job
    const job = await service.startJob({
      companyId: "company-1",
      serverId,
      kind: "recheck",
      createdBy: "actor-2",
    });

    expect(job.kind).toBe("recheck");
    expect(store.servers[0].onboardState).toBe("onboarding");
  });

  it("does not hand out secrets twice", async () => {
    const { mockStore, mockSecrets, mockGetServer } = createMocks();
    const service = onboardService(null as any, { store: mockStore, settings: mockSettings, secrets: mockSecrets, getServer: mockGetServer });
    await service.addServer({ companyId: "company-1", slug: "claim-twice", name: "Claim Twice", hostname: "192.0.2.6", port: 22, username: "root", role: "generic", keepPassword: false, auth: { type: "password", password: "pwd-1" }, createdBy: null });
    const firstClaim = await service.claim("company-1", "valid-executor-token");
    expect(firstClaim).not.toBeNull();
    expect(await service.claim("company-1", "valid-executor-token")).toBeNull();
  });

  it("cleans up secrets if server/job creation fails", async () => {
    const { mockStore, mockSecrets, mockGetServer, secretsStore } = createMocks();
    mockStore.createServerAndJob = async () => { throw new Error("DB error"); };
    const service = onboardService(null as any, { store: mockStore, settings: mockSettings, secrets: mockSecrets, getServer: mockGetServer });
    await expect(
      service.addServer({
        companyId: "company-1",
        slug: "orphan-test",
        name: "Orphan Test",
        hostname: "192.0.2.10",
        port: 22,
        username: "root",
        role: "generic",
        keepPassword: false,
        auth: { type: "password", password: "orphan-pwd" },
        createdBy: null,
      }),
    ).rejects.toThrow("DB error");
    expect(Object.keys(secretsStore)).toEqual([]);
  });

  it("removes the bootstrap secret if access-key persistence fails", async () => {
    const { mockStore, mockSecrets, mockGetServer, secretsStore } = createMocks();
    const put = mockSecrets.putSecret;
    mockSecrets.putSecret = async (companyId, name, key, value) => {
      if (name.endsWith("/access-key")) throw new Error("secret store unavailable");
      return put(companyId, name, key, value);
    };
    const service = onboardService(null as any, { store: mockStore, settings: mockSettings, secrets: mockSecrets, getServer: mockGetServer });
    await expect(service.addServer({ companyId: "company-1", slug: "failed-key", name: "Server", hostname: "192.0.2.7", port: 22, username: "root", role: "generic", keepPassword: false, auth: { type: "password", password: "bootstrap" }, createdBy: null })).rejects.toThrow("secret store unavailable");
    expect(Object.keys(secretsStore)).toEqual([]);
  });

  it("blocks concurrent active jobs for the same server", async () => {
    const { mockStore, mockSecrets, mockGetServer } = createMocks();
    const service = onboardService(null as any, {
      store: mockStore,
      settings: mockSettings,
      secrets: mockSecrets,
      getServer: mockGetServer,
    });
    const { serverId, job } = await service.addServer({
      companyId: "company-1",
      slug: "srv-concurrent",
      name: "Concurrent Test",
      hostname: "192.0.2.11",
      port: 22,
      username: "root",
      role: "generic",
      keepPassword: false,
      auth: { type: "password", password: "pwd" },
      createdBy: null,
    });

    expect(job.status).toBe("pending");

    // Second startJob on same server should throw 409
    await expect(
      service.startJob({ companyId: "company-1", serverId, kind: "recheck", createdBy: null }),
    ).rejects.toThrow("already in progress");

    // Claim the job and report succeeded
    await service.claim("company-1", "valid-executor-token");
    await service.report("valid-executor-token", { companyId: "company-1", jobId: job.id, status: "succeeded" });

    // Now startJob should succeed
    const job2 = await service.startJob({ companyId: "company-1", serverId, kind: "recheck", createdBy: null });
    expect(job2.status).toBe("pending");
  });

  it("handles retry and resume flows with audit trail", async () => {
    const { mockStore, mockSecrets, mockGetServer, store } = createMocks();
    const service = onboardService(null as any, {
      store: mockStore,
      settings: mockSettings,
      secrets: mockSecrets,
      getServer: mockGetServer,
    });
    const { serverId, job } = await service.addServer({
      companyId: "company-1",
      slug: "srv-retry",
      name: "Retry Test",
      hostname: "192.0.2.12",
      port: 22,
      username: "root",
      role: "generic",
      keepPassword: false,
      auth: { type: "password", password: "pwd" },
      createdBy: null,
    });

    // While job is active, resume returns the same active job
    const resumedActive = await service.resume({ companyId: "company-1", serverId });
    expect(resumedActive.id).toBe(job.id);
    expect(resumedActive.status).toBe("pending");

    // Fail the job
    await service.claim("company-1", "valid-executor-token");
    await service.report("valid-executor-token", { companyId: "company-1", jobId: job.id, status: "failed", error: "network unreachable" });

    const storeServer = store.servers.find((s: any) => s.id === serverId);
    expect(storeServer?.onboardState).toBe("needs_attention");

    // Resume now triggers a retry
    const retriedJob = await service.resume({ companyId: "company-1", serverId });
    expect(retriedJob.id).not.toBe(job.id);
    expect(retriedJob.status).toBe("pending");
    expect(retriedJob.kind).toBe("onboard");
  });

  it("expires stale running jobs and transitions server to needs_attention", async () => {
    const { mockStore, mockSecrets, mockGetServer, store } = createMocks();
    mockStore.expireStale = async (_olderThanMs: number) => {
      let expired = 0;
      for (const j of store.jobs) {
        if (j.status === "pending" || j.status === "claimed" || j.status === "running") {
          j.status = "expired";
          expired++;
          const s = store.servers.find((srv: any) => srv.id === j.serverId);
          if (s) s.onboardState = "needs_attention";
        }
      }
      return expired;
    };
    const service = onboardService(null as any, {
      store: mockStore,
      settings: mockSettings,
      secrets: mockSecrets,
      getServer: mockGetServer,
    });
    const { serverId, job } = await service.addServer({
      companyId: "company-1",
      slug: "srv-stale",
      name: "Stale Test",
      hostname: "192.0.2.13",
      port: 22,
      username: "root",
      role: "generic",
      keepPassword: false,
      auth: { type: "password", password: "pwd" },
      createdBy: null,
    });

    await service.claim("company-1", "valid-executor-token");

    const { expired } = await service.tick();
    expect(expired).toBe(1);

    const expiredJob = await service.getJob("company-1", job.id);
    expect(expiredJob?.status).toBe("expired");

    const storeServer = store.servers.find((s: any) => s.id === serverId);
    expect(storeServer?.onboardState).toBe("needs_attention");
  });
});

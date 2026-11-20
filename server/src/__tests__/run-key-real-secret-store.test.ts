import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb } from "@myrmidon/db";
import { defaultAgentGatewayKeyDeps } from "../myrmidon/litellm-keys/agent-keys.js";
import { mintRunGatewayKey, revokeRunGatewayKey } from "../myrmidon/litellm-keys/run-keys.js";
import { secretService } from "../services/secrets.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("run key with the real secret service", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let directory: string;
  let originalKeyFile: string | undefined;

  beforeAll(async () => {
    originalKeyFile = process.env.MYRMIDON_SECRETS_MASTER_KEY_FILE;
    directory = await mkdtemp(join(tmpdir(), "run-key-store-"));
    process.env.MYRMIDON_SECRETS_MASTER_KEY_FILE = join(directory, "master.key");
    database = await startEmbeddedPostgresTestDatabase("run-key-store-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    if (originalKeyFile === undefined) delete process.env.MYRMIDON_SECRETS_MASTER_KEY_FILE;
    else process.env.MYRMIDON_SECRETS_MASTER_KEY_FILE = originalKeyFile;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("mints, resolves, and revokes a credential using the real secret store", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "test" });
    const secrets = secretService(db);
    await secrets.create(companyId, { name: "gateway-admin", provider: "local_encrypted", value: "test-admin" });
    const active = new Map<string, string>();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/key/generate")) active.set(body.key_alias, body.key);
      else if (url.endsWith("/key/delete")) {
        for (const alias of body.key_aliases) active.delete(alias);
      }
      return new Response(JSON.stringify(url.endsWith("/key/list") ? { keys: [...active.keys()] } : {}), { status: 200 });
    }));
    const deps = defaultAgentGatewayKeyDeps(db, { MYRMIDON_LITELLM_BASE_URL: "http://gateway.test", MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin" });
    const runId = randomUUID();
    const minted = await mintRunGatewayKey(deps, { companyId, runId });
    expect(await deps.readSecretValue(companyId, minted.secretName)).toBe(minted.value);
    expect(active.get(minted.secretName)).toBe(minted.value);
    await revokeRunGatewayKey(deps, { companyId, runId });
    expect(await deps.readSecretValue(companyId, minted.secretName)).toBeNull();
    expect(active.has(minted.secretName)).toBe(false);
  }, 45_000);
});

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { Server, utils } from "ssh2";
import { expect, it, vi } from "vitest";
import { companies, createDb } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { myrmidonOnboardRoutes } from "./index.js";
import { runOnboardFromEnvironment } from "./entrypoint.js";
import { onboardService, panelSecretPort } from "./service.js";
import { fleetOnboardStore } from "./store.js";
import { readFleetOnboardSettings } from "./settings.js";
import { sshPublicKey } from "./ssh-key.js";

const support = await getEmbeddedPostgresTestSupport();

it.skipIf(!support.supported)("retires bootstrap only after real stored-key login and reuses the key in a new runner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "onboard-keys-"));
  const database = await startEmbeddedPostgresTestDatabase("onboard-keys-");
  const db = createDb(database.connectionString);
  const companyId = randomUUID();
  const token = randomUUID();
  const password = randomUUID();
  const env = {
    MYRMIDON_FLEET_ONBOARD_ENABLED: "1",
    MYRMIDON_FLEET_ONBOARD_COMPANY_ID: companyId,
    MYRMIDON_FLEET_ONBOARD_EXECUTOR_TOKEN: token,
  };
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  const events: string[] = [];
  let installed = "";
  let passwordEnabled = true;
  const clients = new Set<import("ssh2").Connection>();
  const ssh = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && passwordEnabled && ctx.password === password) {
        events.push("password-login");
        ctx.accept();
        return;
      }
      if (ctx.method === "publickey" && installed) {
        const key = utils.parseKey(installed);
        if (!(key instanceof Error) && !Array.isArray(key) && key.getPublicSSH().equals(ctx.key.data)) {
          if (!ctx.signature) { ctx.accept(); return; }
          if (ctx.blob && key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) {
            events.push("signed-key-login");
            ctx.accept();
            return;
          }
        }
      }
      ctx.reject(["password", "publickey"]);
    });
    client.on("ready", () => client.on("session", (accept) => {
      accept().on("exec", (acceptExec, _reject, { command }) => {
        const stream = acceptExec();
        const publicKey = command.match(/ssh-ed25519 [A-Za-z0-9+/=]+ myrmidon-access/);
        if (command.includes("authorized_keys") && publicKey) installed = publicKey[0];
        if (command.includes("PasswordAuthentication no")) { events.push("disable-password"); passwordEnabled = false; }
        if (command === "cat /etc/os-release") stream.write("ID=debian\n");
        if (command === "df -P /") stream.write("Filesystem Capacity\n/dev/test 10% /\n");
        if (command === "free -m") stream.write("Mem: 1024\n");
        if (command.includes("myrmidon-key-verify")) stream.write("myrmidon-key-verify\n");
        if (command.includes("onboard-verified")) stream.write("onboard-verified\n");
        if (command.startsWith("sudo sshd -T")) stream.write("passwordauthentication no\nkbdinteractiveauthentication no\n");
        if (command === "sudo ufw status") stream.write("Status: active\n");
        if (command.startsWith(": snapshot-myrmidon-firewall;")) stream.write("Status: active\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n");
        if (/^: (start|check)-myrmidon-.*-timer;/.test(command)) stream.write("timer-confirmed\n");
        if (command.startsWith(": apply-myrmidon-firewall-allow;")) stream.write("Rule inserted\n");
        if (command.includes("ufw-connectivity-ok")) stream.write("ufw-connectivity-ok\n");
        stream.exit(command.startsWith("test -d /usr/local/cpanel") ? 1 : 0);
        stream.end();
      });
    }));
  });
  try {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv("MYRMIDON_SECRETS_MASTER_KEY", undefined);
    vi.stubEnv("MYRMIDON_SECRETS_MASTER_KEY_FILE", join(directory, "master.key"));
    await db.insert(companies).values({ id: companyId, name: "Onboard", issuePrefix: "ONB", requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "test" });
    await new Promise<void>((resolve) => ssh.listen(0, "127.0.0.1", resolve));
    const address = ssh.address();
    if (!address || typeof address === "string") throw new Error("Unexpected SSH address");
    const store = fleetOnboardStore(db);
    const makeService = () => onboardService(db, {
      store, settings: readFleetOnboardSettings(), secrets: panelSecretPort(db), getServer: store.getServerById,
    });
    const { serverId, job } = await makeService().addServer({
      companyId, slug: "lifecycle", name: "Lifecycle", hostname: "127.0.0.1", port: address.port,
      username: "test", role: "generic", keepPassword: false, auth: { type: "password", password }, createdBy: null,
    });
    const registered = (await store.getServerById(companyId, serverId))!;
    const passwordName = registered.passwordSecretKey!;
    const keyName = registered.accessKeySecretKey!;
    expect(await panelSecretPort(db).readSecret(companyId, passwordName)).toBe(password);
    const runFreshWorker = async () => {
      const app = express();
      app.use(express.json());
      app.use("/api", myrmidonOnboardRoutes(db));
      const board = app.listen(0, "127.0.0.1");
      try {
        await new Promise<void>((resolve, reject) => { board.once("listening", resolve); board.once("error", reject); });
        const address = board.address();
        if (!address || typeof address === "string") throw new Error("Unexpected board address");
        const fetcher: typeof fetch = async (input, init) => {
          const body = JSON.parse(String(init?.body));
          if (body.status === "succeeded" && body.verifiedAccessPublicKey) {
            expect(events.indexOf("signed-key-login")).toBeGreaterThan(events.indexOf("password-login"));
            expect(events.indexOf("disable-password")).toBeGreaterThan(events.indexOf("signed-key-login"));
            expect(await panelSecretPort(db).readSecret(companyId, passwordName)).toBe(password);
          }
          return fetch(input, init);
        };
        expect(await runOnboardFromEnvironment({ ...env, MYRMIDON_FLEET_ONBOARD_BASE_URL: `http://127.0.0.1:${address.port}` }, fetcher)).toBe(true);
      } finally {
        await new Promise<void>((resolve) => board.close(() => resolve()));
      }
    };
    await runFreshWorker();
    expect((await store.getJob(companyId, job.id))?.status).toBe("succeeded");
    expect(await panelSecretPort(db).readSecret(companyId, passwordName)).toBeNull();
    const key = await panelSecretPort(db).readSecret(companyId, keyName);
    expect(key && sshPublicKey(key)).toBe(installed);
    const pin = (await store.getServerById(companyId, serverId))?.hostKeyFingerprint;
    expect(pin).toMatch(/^SHA256:/);

    events.length = 0;
    const recheck = await makeService().startJob({ companyId, serverId, kind: "recheck", createdBy: null });
    await runFreshWorker();
    expect((await store.getJob(companyId, recheck.id))?.status).toBe("succeeded");
    expect(events).toContain("signed-key-login");
    expect(events).not.toContain("password-login");
    expect((await store.getServerById(companyId, serverId))?.hostKeyFingerprint).toBe(pin);
  } finally {
    for (const client of clients) client.end();
    if (ssh.address()) await new Promise<void>((resolve) => ssh.close(() => resolve()));
    vi.unstubAllEnvs();
    await db.$client.end({ timeout: 0 });
    await database.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

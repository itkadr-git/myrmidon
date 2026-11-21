import { generateKeyPairSync } from "node:crypto";
import { Server } from "ssh2";
import { expect, it } from "vitest";
import { runOnboardOnce } from "./runner.js";
import { generateSshKeyPair } from "./ssh-key.js";

it("rechecks the persisted host pin before authenticating a fresh key connection", async () => {
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  const pair = generateSshKeyPair();
  let authentications = 0;
  let pinChecks = 0;
  const reports: Array<Record<string, unknown>> = [];
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "none") ctx.reject(["password", "publickey"]);
      else { authentications++; ctx.accept(); }
    });
    client.on("ready", () => client.on("session", (accept) => {
      accept().on("exec", (acceptExec) => {
        const stream = acceptExec();
        stream.exit(0);
        stream.end();
      });
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/claim")) return Response.json({
      job: { id: "job", companyId: "company" },
      server: { hostname: "127.0.0.1", port: address.port, username: "test", hostKeyFingerprint: null, accessKeySecretKey: "stored" },
      steps: ["access"], options: { keepPassword: false },
      secretValues: { bootstrapPassword: "test-password", accessKey: pair.privateKey },
    });
    if (path.endsWith("/host-key")) return Response.json({ accepted: ++pinChecks === 1 });
    if (path.endsWith("/report")) { reports.push(JSON.parse(String(init?.body))); return Response.json({}); }
    throw new Error(`unexpected request: ${path}`);
  };
  try {
    await runOnboardOnce({ baseUrl: "http://board", companyId: "company", token: "token", fetcher });
    expect(pinChecks).toBe(2);
    expect(authentications).toBe(1);
    expect(reports.some((report) => report.status === "failed")).toBe(true);
    expect(reports.some((report) => report.status === "succeeded")).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

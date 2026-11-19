import { generateKeyPairSync } from "node:crypto";
import { Server } from "ssh2";
import { describe, expect, it } from "vitest";
import { runOnboardOnce } from "./runner.js";

it("runs the claimed job through real SSH and rejects a changed host before authentication", async () => {
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  let attempts = 0;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => { attempts++; ctx.reject(); });
    client.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  const reports: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/claim")) return Response.json({
      job: { id: "job", companyId: "company" },
      server: { hostname: "127.0.0.1", port: address.port, username: "test", hostKeyFingerprint: "SHA256:not-the-host-key" },
      steps: ["connect"], options: { keepPassword: true }, secretValues: { bootstrapPassword: "test-password" },
    });
    if (path.endsWith("/report")) { reports.push(JSON.parse(String(init?.body))); return Response.json({}); }
    throw new Error(`unexpected request: ${path}`);
  };
  try {
    expect(await runOnboardOnce({ baseUrl: "http://board", companyId: "company", token: "token", fetcher })).toBe(true);
    expect(attempts).toBe(0);
    expect(reports.some((report) => report.status === "failed")).toBe(true);
    expect(JSON.stringify(reports)).not.toContain("test-password");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

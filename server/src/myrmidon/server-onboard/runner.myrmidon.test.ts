import { generateKeyPairSync } from "node:crypto";
import { Server } from "ssh2";
import { describe, expect, it } from "vitest";
import { runOnboardOnce } from "./runner.js";
import { runOnboardFromEnvironment } from "./entrypoint.js";
import { generateSshKeyPair } from "./ssh-key.js";

it.each([false, true])("closes every SSH session after stored-key access (firewall enabled: %s)", async (harden) => {
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  const pair = generateSshKeyPair();
  const clients = new Set<import("ssh2").Connection>();
  const authMethods: string[] = [];
  let installed = "";
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) => { authMethods.push(ctx.method); if (ctx.method === "none") ctx.reject(["password", "publickey"]); else ctx.accept(); });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        if (info.command.includes("authorized_keys")) installed = info.command;
        if (info.command.includes("myrmidon-key-verify")) stream.write("myrmidon-key-verify\n");
        if (info.command.includes("onboard-verified")) stream.write("onboard-verified\n");
        if (info.command.includes("ufw-connectivity-ok")) stream.write("ufw-connectivity-ok\n");
        stream.exit(0);
        stream.end();
      });
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  const reports: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/claim")) return Response.json({
      job: { id: "job", companyId: "company" },
      server: { hostname: "127.0.0.1", port: address.port, username: "test", hostKeyFingerprint: null, accessKeySecretKey: "stored" },
      steps: harden ? ["access", "harden", "verify"] : ["access", "verify"], options: { keepPassword: true }, secretValues: { bootstrapPassword: "test-password", accessKey: pair.privateKey },
    });
    if (path.endsWith("/host-key")) return Response.json({ accepted: true });
    if (path.endsWith("/report")) { reports.push(JSON.parse(String(init?.body))); return Response.json({}); }
    throw new Error(`unexpected request: ${path}`);
  };
  try {
    await runOnboardOnce({ baseUrl: "http://board", companyId: "company", token: "token", fetcher });
    expect(reports.find((report) => report.status === "failed")).toBeUndefined();
    expect(reports.some((report) => report.status === "succeeded")).toBe(true);
    expect(authMethods).toContain("password");
    expect(authMethods).toContain("publickey");
    expect(installed).toContain(pair.publicKey.trim());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(clients.size).toBe(0);
  } finally {
    for (const client of clients) client.end();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it.each(["write", "reload"] as const)("reports failure when password hardening %s fails", async (failure) => {
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  const pair = generateSshKeyPair();
  const commands: string[] = [];
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => ctx.method === "none" ? ctx.reject(["password", "publickey"]) : ctx.accept());
    client.on("ready", () => client.on("session", (accept) => {
      accept().on("exec", (acceptExec, _reject, info) => {
        commands.push(info.command);
        const stream = acceptExec();
        if (info.command.includes("myrmidon-key-verify")) stream.write("myrmidon-key-verify\n");
        const fails = failure === "write" ? info.command.includes("sudo tee /etc/ssh/sshd_config.d/") : info.command.includes("systemctl reload");
        stream.exit(fails ? 1 : 0);
        stream.end();
      });
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  const reports: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/claim")) return Response.json({
      job: { id: "job", companyId: "company" },
      server: { hostname: "127.0.0.1", port: address.port, username: "test", hostKeyFingerprint: null, accessKeySecretKey: "stored" },
      steps: ["access"], options: { keepPassword: false }, secretValues: { bootstrapPassword: "test-password", accessKey: pair.privateKey },
    });
    if (path.endsWith("/host-key")) return Response.json({ accepted: true });
    if (path.endsWith("/report")) { reports.push(JSON.parse(String(init?.body))); return Response.json({}); }
    throw new Error(`unexpected request: ${path}`);
  };
  try {
    await runOnboardOnce({ baseUrl: "http://board", companyId: "company", token: "token", fetcher });
    expect(reports.some((report) => report.status === "failed")).toBe(true);
    expect(reports.some((report) => report.status === "succeeded")).toBe(false);
    expect(commands.some((command) => command.includes("systemctl reload"))).toBe(failure === "reload");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it.each(["install", "login"] as const)("does not disable password when key %s fails", async (failure) => {
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  const pair = generateSshKeyPair();
  const commands: string[] = [];
  let keyAttempts = 0;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "none") return ctx.reject(["password", "publickey"]);
      if (ctx.method === "publickey") {
        keyAttempts++;
        if (failure === "login") return ctx.reject();
      }
      ctx.accept();
    });
    client.on("ready", () => client.on("session", (accept) => {
      accept().on("exec", (acceptExec, _reject, info) => {
        commands.push(info.command);
        const stream = acceptExec();
        const fail = failure === "install" && info.command.includes("authorized_keys");
        stream.exit(fail ? 1 : 0);
        stream.end();
      });
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  const reports: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/claim")) return Response.json({
      job: { id: "job", companyId: "company" },
      server: { hostname: "127.0.0.1", port: address.port, username: "test", hostKeyFingerprint: null, accessKeySecretKey: "stored" },
      steps: ["access"], options: { keepPassword: false }, secretValues: { bootstrapPassword: "test-password", accessKey: pair.privateKey },
    });
    if (path.endsWith("/host-key")) return Response.json({ accepted: true });
    if (path.endsWith("/report")) { reports.push(JSON.parse(String(init?.body))); return Response.json({}); }
    throw new Error(`unexpected request: ${path}`);
  };
  try {
    await runOnboardOnce({ baseUrl: "http://board", companyId: "company", token: "token", fetcher });
    expect(reports.some((report) => report.status === "failed")).toBe(true);
    expect(reports.some((report) => report.status === "succeeded")).toBe(false);
    expect(commands.some((command) => command.includes("PasswordAuthentication no"))).toBe(false);
    expect(keyAttempts > 0).toBe(failure === "login");
    expect(JSON.stringify(reports)).not.toContain(pair.privateKey);
    expect(JSON.stringify(reports)).not.toContain("test-password");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it.each(["changed", "rejected"] as const)("runs real SSH and rejects a %s host identity before authentication", async (reason) => {
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
      server: { hostname: "127.0.0.1", port: address.port, username: "test", hostKeyFingerprint: reason === "changed" ? "SHA256:not-the-host-key" : null },
      steps: ["connect"], options: { keepPassword: true }, secretValues: { bootstrapPassword: "test-password" },
    });
    if (path.endsWith("/host-key")) return Response.json({ accepted: false });
    if (path.endsWith("/report")) { reports.push(JSON.parse(String(init?.body))); return Response.json({}); }
    throw new Error(`unexpected request: ${path}`);
  };
  try {
    expect(await runOnboardFromEnvironment({
      MYRMIDON_FLEET_ONBOARD_BASE_URL: "http://board",
      MYRMIDON_FLEET_ONBOARD_COMPANY_ID: "company",
      MYRMIDON_FLEET_ONBOARD_EXECUTOR_TOKEN: "token",
    }, fetcher)).toBe(true);
    expect(attempts).toBe(0);
    expect(reports.some((report) => report.status === "failed")).toBe(true);
    expect(JSON.stringify(reports)).not.toContain("test-password");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

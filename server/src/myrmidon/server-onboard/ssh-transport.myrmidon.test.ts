import { generateKeyPairSync } from "node:crypto";
import { Server } from "ssh2";
import { describe, expect, it } from "vitest";
import { OnboardSshTransport } from "./ssh-transport.js";

describe("onboarding SSH host verification", () => {
  it("rejects a host key before the server receives authentication", async () => {
    const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
    let authenticationAttempts = 0;
    const server = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on("authentication", (ctx) => { authenticationAttempts++; ctx.reject(); });
      client.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const transport = new OnboardSshTransport();
    try {
      await expect(transport.connect({ host: "127.0.0.1", port: address.port, username: "test", password: "not-a-secret", hostVerifier: async () => false })).rejects.toThrow();
      expect(authenticationAttempts).toBe(0);
    } finally {
      await transport.disconnect();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("persists an accepted first pin and rejects a changed key on reconnect", async () => {
    let attempts = 0;
    const start = async () => {
      const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
      const server = new Server({ hostKeys: [key] }, (client) => {
        client.on("authentication", (ctx) => { attempts++; ctx.accept(); });
        client.on("error", () => {});
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server address");
      return { server, port: address.port };
    };
    let pin: string | null = null;
    const verify = async (fingerprint: string) => {
      if (pin === null) pin = fingerprint;
      return pin === fingerprint;
    };
    const first = await start();
    const transport = new OnboardSshTransport();
    try {
      await transport.connect({ host: "127.0.0.1", port: first.port, username: "test", password: "not-a-secret", hostVerifier: verify });
      expect(pin).toMatch(/^SHA256:/);
      expect(attempts).toBeGreaterThan(0);
    } finally {
      await transport.disconnect();
      await new Promise<void>((resolve, reject) => first.server.close((error) => error ? reject(error) : resolve()));
    }
    const previousAttempts = attempts;
    const second = await start();
    const reconnect = new OnboardSshTransport();
    try {
      await expect(reconnect.connect({ host: "127.0.0.1", port: second.port, username: "test", password: "not-a-secret", hostVerifier: verify })).rejects.toThrow();
      expect(attempts).toBe(previousAttempts);
    } finally {
      await reconnect.disconnect();
      await new Promise<void>((resolve, reject) => second.server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

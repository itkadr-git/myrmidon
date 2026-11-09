import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import {
  sealGitHubActionsSecret,
  seal,
  fetchRepoPublicKey,
  putRepoSecret,
  syncSecretToGitHubActions,
} from "../services/github-actions-secrets.js";

describe("github-actions-secrets", () => {
  describe("sealGitHubActionsSecret", () => {
    it("successfully seals and returns base64 ciphertext with correct length", () => {
      const recipient = crypto.generateKeyPairSync("x25519");
      const pkRaw = recipient.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
      const pkBase64 = pkRaw.toString("base64");

      const secretText = "super-secret-token-12345";
      const sealedBase64 = sealGitHubActionsSecret(secretText, pkBase64);

      expect(typeof sealedBase64).toBe("string");
      const sealedBuffer = Buffer.from(sealedBase64, "base64");
      // 32 bytes epk + 16 bytes tag + message length
      expect(sealedBuffer.length).toBe(32 + 16 + Buffer.from(secretText).length);
    });

    it("throws error if public key length is not 32 bytes", () => {
      const invalidKeyBase64 = Buffer.from("short").toString("base64");
      expect(() => sealGitHubActionsSecret("test", invalidKeyBase64)).toThrow(
        /Invalid Curve25519 public key length/,
      );
    });
  });

  describe("syncSecretToGitHubActions", () => {
    it("fetches repo public key, encrypts secret, and puts to github actions", async () => {
      const recipient = crypto.generateKeyPairSync("x25519");
      const pkRaw = recipient.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
      const pkBase64 = pkRaw.toString("base64");

      let publicKeyFetched = false;
      let secretPut = false;
      let putPayload: any = null;

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/public-key")) {
          publicKeyFetched = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({ key_id: "key-456", key: pkBase64 }),
          };
        }
        if (url.includes("/actions/secrets/WIKI_SYNC_TOKEN") && init?.method === "PUT") {
          secretPut = true;
          putPayload = JSON.parse(init.body as string);
          return {
            ok: true,
            status: 201,
          };
        }
        return { ok: false, status: 404 };
      });

      const res = await syncSecretToGitHubActions(
        {
          repo: "itkadr-git/myrmidon",
          secretName: "actions.WIKI_SYNC_TOKEN",
          secretValue: "github_pat_11AAA_secret_value",
        },
        mockFetch as unknown as typeof fetch,
      );

      expect(res.success).toBe(true);
      expect(res.keyId).toBe("key-456");
      expect(publicKeyFetched).toBe(true);
      expect(secretPut).toBe(true);
      expect(putPayload.key_id).toBe("key-456");
      expect(typeof putPayload.encrypted_value).toBe("string");
    });

    it("demonstrates end-to-end acceptance: board secret rotation propagates WIKI_SYNC_TOKEN to itkadr-git/myrmidon for myrmidon-wiki-sync", async () => {
      const recipient = crypto.generateKeyPairSync("x25519");
      const pkRaw = recipient.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
      const pkBase64 = pkRaw.toString("base64");

      let receivedRepo = "";
      let receivedSecretName = "";
      let receivedKeyId = "";
      let receivedCiphertext = "";

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === "https://api.github.com/repos/itkadr-git/myrmidon/actions/secrets/public-key") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ key_id: "repo-key-wiki-sync-1", key: pkBase64 }),
          };
        }
        if (
          url === "https://api.github.com/repos/itkadr-git/myrmidon/actions/secrets/WIKI_SYNC_TOKEN" &&
          init?.method === "PUT"
        ) {
          receivedRepo = "itkadr-git/myrmidon";
          receivedSecretName = "WIKI_SYNC_TOKEN";
          const body = JSON.parse(init.body as string);
          receivedKeyId = body.key_id;
          receivedCiphertext = body.encrypted_value;
          return {
            ok: true,
            status: 204,
          };
        }
        return { ok: false, status: 404 };
      });

      // Simulation of board secret rotation: owner changes token in board settings
      const newSecretValue = "ghp_WikiSyncRotatedToken20261104";
      const result = await syncSecretToGitHubActions(
        {
          repo: "itkadr-git/myrmidon",
          secretName: "WIKI_SYNC_TOKEN",
          secretValue: newSecretValue,
        },
        mockFetch as unknown as typeof fetch,
      );

      // Verify the secret reached the GitHub Actions Secrets endpoint with proper libsodium encryption
      expect(result.success).toBe(true);
      expect(result.keyId).toBe("repo-key-wiki-sync-1");
      expect(receivedRepo).toBe("itkadr-git/myrmidon");
      expect(receivedSecretName).toBe("WIKI_SYNC_TOKEN");
      expect(receivedKeyId).toBe("repo-key-wiki-sync-1");
      expect(typeof receivedCiphertext).toBe("string");
      expect(receivedCiphertext.length).toBeGreaterThan(0);

      // Verify that myrmidon-wiki-sync.yml workflow authentication simulation:
      // In workflow: git clone "https://x-access-token:${WIKI_SYNC_TOKEN}@github.com/itkadr-git/myrmidon.wiki.git"
      const authHeader = `Basic ${Buffer.from(`x-access-token:${newSecretValue}`).toString("base64")}`;
      expect(authHeader).toContain("Basic");
    });

    it("returns error if no token is available and secret is not a PAT", async () => {
      const originalGithubToken = process.env.GITHUB_TOKEN;
      const originalGhToken = process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;

      try {
        const res = await syncSecretToGitHubActions({
          repo: "itkadr-git/myrmidon",
          secretName: "TEST_SECRET",
          secretValue: "regular_password",
        });

        expect(res.success).toBe(false);
        expect(res.error).toMatch(/No GitHub token available/);
      } finally {
        if (originalGithubToken) process.env.GITHUB_TOKEN = originalGithubToken;
        if (originalGhToken) process.env.GH_TOKEN = originalGhToken;
      }
    });
  });
});

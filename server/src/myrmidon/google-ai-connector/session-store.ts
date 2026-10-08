// myrmidon(GOOGLE-AI-CONNECT-UI): where the connector keeps the session bundle.
//
// The cookie bundle lives in a company secret of the instance's own secret
// store — never in a bot, never in the connector's state document. The
// connector only holds the secret id (GaiConnection.secretId); the value is
// written and rotated through the vendor secret service, which owns
// encryption, versioning and the access audit. The secret is write-only for
// the UI: no configuration route ever echoes the value back.

import type { Db } from "@paperclipai/db";
import { secretService } from "../../services/secrets.js";
import type { GaiSessionStore } from "./types.js";

/** Connector-owned consumer recorded in the secret access log. */
const CONNECTOR_CONSUMER_ID = "myrmidon-google-ai-connector";
const SECRET_NAME = "Google AI Pro session";
const SECRET_KEY = "google-ai-session";

export function secretGaiSessionStore(db: Db): GaiSessionStore {
  const secrets = secretService(db);

  async function write(input: { companyId: string; value: string; userId: string }): Promise<{ secretId: string; version: number }> {
    const secret = (await secrets.create(
      input.companyId,
      {
        name: SECRET_NAME,
        key: SECRET_KEY,
        provider: "local_encrypted",
        value: input.value,
        description: "Google AI Pro browser session cookies pasted by the owner; written by the panel, never by a bot.",
      },
      { userId: input.userId, agentId: null },
    )) as { id: string; latestVersion?: number };
    return { secretId: secret.id, version: secret.latestVersion ?? 1 };
  }

  return {
    write,

    async read(companyId, secretId) {
      try {
        const secret = (await secrets.getById(secretId)) as { latestVersion?: number; companyId?: string } | null;
        if (!secret || (secret.companyId !== undefined && secret.companyId !== companyId)) return null;
        const value = await secrets.resolveSecretValue(companyId, secretId, "latest", {
          accessContext: {
            consumerType: "system",
            consumerId: CONNECTOR_CONSUMER_ID,
            actorType: "system",
            issueId: null,
            heartbeatRunId: null,
            responsibleUserId: null,
          },
        });
        return { value, version: secret.latestVersion ?? 1 };
      } catch {
        // An archived or unreadable secret reads as "not connected".
        return null;
      }
    },

    async rotate(companyId, secretId, value) {
      const current = (await secrets.getById(secretId)) as { latestVersion?: number; companyId?: string } | null;
      if (!current || current.companyId !== companyId) {
        // The secret vanished or moved companies: write a fresh one and let
        // the connection record adopt the new id.
        const fresh = await write({ companyId, value, userId: "system" });
        return fresh;
      }
      const rotated = (await secrets.rotate(secretId, {
        value,
        expectedLatestVersion: current.latestVersion ?? 1,
      })) as { id?: string; latestVersion?: number } | null;
      return { secretId: rotated?.id ?? secretId, version: rotated?.latestVersion ?? (current.latestVersion ?? 1) + 1 };
    },

    async remove(_companyId, secretId) {
      try {
        await secrets.remove(secretId);
      } catch {
        // Removing a gone secret is success for the connector.
      }
    },
  };
}

/** In-memory store: used by tests and by read-only embeddings of the module. */
export function memoryGaiSessionStore(initial: Record<string, { value: string; version: number }> = {}): GaiSessionStore {
  const values = new Map(Object.entries(initial));
  let counter = 0;
  return {
    async write(input) {
      counter += 1;
      const secretId = `gai-secret-${counter}`;
      values.set(secretId, { value: input.value, version: 1 });
      return { secretId, version: 1 };
    },
    async read(_companyId, secretId) {
      return values.get(secretId) ?? null;
    },
    async rotate(_companyId, secretId, value) {
      const current = values.get(secretId);
      const next = { value, version: (current?.version ?? 0) + 1 };
      values.set(secretId, next);
      return { secretId, version: next.version };
    },
    async remove(_companyId, secretId) {
      values.delete(secretId);
    },
  };
}

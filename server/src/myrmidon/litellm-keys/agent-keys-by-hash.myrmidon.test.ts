// server/src/myrmidon/litellm-keys/agent-keys-by-hash.myrmidon.test.ts
//
// myrmidon(1.6.7 LITELLM-BOARD-SYNC): the gateway key port addresses a key by
// the sha256 of its value, the way LiteLLM v1.104.1 accepts it:
//
// - `POST /key/update` takes `key` (the value, or its hash) or `key_alias`.
//   A `key` that does not start with "sk-" is read as an ALREADY-HASHED token,
//   so the board sends the hash. `key_alias` is never sent together with it:
//   in the body it is a new alias to SET.
// - `GET /key/info?key=<hash>` answers `{ key, info }`; an unknown key is 404
//   and a deleted one is still served from the archive with status "deleted".

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayKeyAdminPort, gatewayKeyValueHash } from "./agent-keys.js";

const HASH = gatewayKeyValueHash("agent-key-value");

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown>;
  auth: string | undefined;
}

describe("gateway key port addressed by key hash", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function start(answer: (seen: Seen) => { status: number; body: unknown }) {
    const seen: Seen[] = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const entry: Seen = {
          method: req.method ?? "",
          path: req.url ?? "",
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
          auth: req.headers.authorization,
        };
        seen.push(entry);
        const reply = answer(entry);
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const address = server!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { seen, admin: createGatewayKeyAdminPort(`http://127.0.0.1:${port}`, "admin-value") };
  }

  it("setKeyAllowedModels sends the hash as `key` and no key_alias", async () => {
    const { seen, admin } = await start(() => ({ status: 200, body: { key: HASH } }));

    const applied = await admin.setKeyAllowedModels!({
      alias: "llm-gateway-key-alpha-agent-a",
      keyHash: HASH,
      models: ["openai/gpt-4o"],
    });

    expect(applied).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.path).toBe("/key/update");
    expect(seen[0]!.body).toEqual({ key: HASH, models: ["openai/gpt-4o"] });
    expect(seen[0]!.auth).toBe("Bearer admin-value");
  });

  it("setKeyAllowedModels answers false when the gateway does not know the hash (404)", async () => {
    const { admin } = await start(() => ({ status: 404, body: { error: { message: "Key not found." } } }));

    expect(await admin.setKeyAllowedModels!({ alias: "a", keyHash: HASH, models: ["m"] })).toBe(false);
  });

  it("setKeyAllowedModels without a hash still addresses the alias, as before", async () => {
    const { seen, admin } = await start(() => ({ status: 200, body: {} }));

    await admin.setKeyAllowedModels!({ alias: "llm-gateway-key-alpha-agent-a", models: ["m"] });

    expect(seen[0]!.body).toEqual({ key_alias: "llm-gateway-key-alpha-agent-a", models: ["m"] });
  });

  it("getKeyInfo by hash reads GET /key/info?key=<hash> and returns models, cap and spend", async () => {
    const { seen, admin } = await start(() => ({
      status: 200,
      body: {
        key: HASH,
        info: { key_alias: "litellm-key-adm-dev-eng-18", status: "active", models: ["m-1", "m-2"], max_budget: 10, spend: 2.5 },
      },
    }));

    const info = await admin.getKeyInfo!({ alias: "x", keyHash: HASH });

    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.path).toBe(`/key/info?key=${HASH}`);
    expect(seen[0]!.auth).toBe("Bearer admin-value");
    expect(info).toEqual({ models: ["m-1", "m-2"], maxBudgetUsd: 10, spendUsd: 2.5 });
  });

  it("getKeyInfo by hash: an all-models key reads as an empty list, an uncapped key has no cap", async () => {
    const { admin } = await start(() => ({
      status: 200,
      body: { key: HASH, info: { status: "active", models: [], max_budget: null, spend: 0 } },
    }));

    expect(await admin.getKeyInfo!({ alias: "x", keyHash: HASH })).toEqual({ models: [], maxBudgetUsd: null, spendUsd: 0 });
  });

  it("getKeyInfo by hash answers null for an unknown key (404) and for a deleted one", async () => {
    let reply: { status: number; body: unknown } = { status: 404, body: { error: { message: "Key not found in database" } } };
    const { admin } = await start(() => reply);

    expect(await admin.getKeyInfo!({ alias: "x", keyHash: HASH })).toBeNull();

    reply = { status: 200, body: { key: HASH, info: { status: "deleted", models: ["m"] } } };
    expect(await admin.getKeyInfo!({ alias: "x", keyHash: HASH })).toBeNull();
  });

  it("getKeyInfo by hash maps a gateway failure to a 422 instead of reading it as 'no key'", async () => {
    const { admin } = await start(() => ({ status: 500, body: { error: "boom" } }));

    await expect(admin.getKeyInfo!({ alias: "x", keyHash: HASH })).rejects.toMatchObject({ status: 422 });
  });
});

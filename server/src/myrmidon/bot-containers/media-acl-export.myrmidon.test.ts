// myrmidon(MEDIA-PROVISION): unit test of the media ACL registry exporter.
//
// Covers the acceptance set of the exporter: cards -> a deterministic bots.json
// (stable sort, byte-equal rewrite is a no-op), a bot without a token is absent,
// the raw token never appears in the file or in any result field, the write is
// atomic (a rename in the same directory, mode 0600 re-stamped), and a broken
// card-env resolve drops only that agent.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MEDIA_BOTS_FILE,
  DEFAULT_MEDIA_TOOLS_ALLOWLIST,
  MEDIA_TOOLS_TOKEN_ENV,
  MYRMIDON_MEDIA_BOTS_FILE_ENV,
  buildBotsRegistryJson,
  collectMediaAclEntries,
  mediaTokenFromEnv,
  runMediaAclExport,
  sha256Hex,
  type MediaAclAgent,
  type MediaAclCardEnvResolver,
} from "./media-acl-export.js";

function agent(agentId: string, over: Partial<MediaAclAgent> = {}): MediaAclAgent {
  return {
    agentId,
    companyId: "company-1",
    name: `bot-${agentId.slice(0, 8)}`,
    adapterType: "hermes_gateway",
    adapterConfig: { container: { enabled: true } },
    runtimeConfig: {},
    ...over,
  };
}

/** Resolver backed by a plain map agentId -> token (null = no/blank token). */
function resolverFor(tokens: Record<string, string | null>): MediaAclCardEnvResolver {
  return async (a) => {
    const token = tokens[a.id];
    const env: Record<string, { value: string; secret: boolean }> = {};
    if (token !== null && token !== undefined) {
      env[MEDIA_TOOLS_TOKEN_ENV] = { value: token, secret: true };
    }
    return { env };
  };
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const dirs: string[] = [];
async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-acl-export-"));
  dirs.push(dir);
  return path.join(dir, "bots.json");
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("sha256Hex / mediaTokenFromEnv", () => {
  it("hashes lowercase hex exactly like hashlib.sha256(bearer).hexdigest()", () => {
    expect(sha256Hex("tok-a")).toBe(sha("tok-a"));
    expect(sha256Hex("tok-a")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("counts only a non-empty trimmed value", () => {
    expect(mediaTokenFromEnv({ [MEDIA_TOOLS_TOKEN_ENV]: { value: " raw ", secret: true } }).trim()).toBe("raw");
    expect(mediaTokenFromEnv({ [MEDIA_TOOLS_TOKEN_ENV]: { value: "   ", secret: true } })).toBeNull();
    expect(mediaTokenFromEnv({ [MEDIA_TOOLS_TOKEN_ENV]: { value: "", secret: true } })).toBeNull();
    expect(mediaTokenFromEnv({})).toBeNull();
  });
});

describe("collectMediaAclEntries", () => {
  const A = "0f0f0f0f-1111-2222-3333-444444444444";
  const B = "1e1e1e1e-5555-6666-7777-888888888888";

  it("one entry per token-carrying bot, keyed by bot key with the container peer name", async () => {
    const { entries, failedResolves } = await collectMediaAclEntries(
      [agent(A), agent(B)],
      resolverFor({ [A]: "tok-a", [B]: "tok-b" }),
    );
    expect(failedResolves).toBe(0);
    expect(entries).toEqual([
      { botKey: A, tokenSha256: sha("tok-a"), peerHost: `myrmidon-bot-${A}`, tools: DEFAULT_MEDIA_TOOLS_ALLOWLIST },
      { botKey: B, tokenSha256: sha("tok-b"), peerHost: `myrmidon-bot-${B}`, tools: DEFAULT_MEDIA_TOOLS_ALLOWLIST },
    ]);
  });

  it("a bot without a token contributes nothing", async () => {
    const { entries } = await collectMediaAclEntries([agent(A), agent(B)], resolverFor({ [A]: "tok-a", [B]: null }));
    expect(entries.map((e) => e.botKey)).toEqual([A]);
  });

  it("a resolve that throws drops only that agent and is counted", async () => {
    const resolver: MediaAclCardEnvResolver = async (a) => {
      if (a.id === B) throw new Error("secret unreadable");
      return { env: { [MEDIA_TOOLS_TOKEN_ENV]: { value: "tok-a", secret: true } } };
    };
    const { entries, failedResolves } = await collectMediaAclEntries([agent(A), agent(B)], resolver);
    expect(entries.map((e) => e.botKey)).toEqual([A]);
    expect(failedResolves).toBe(1);
  });

  it("an id that cannot be a bot key is skipped before any resolve", async () => {
    const seen: string[] = [];
    const resolver: MediaAclCardEnvResolver = async (a) => {
      seen.push(a.id);
      return { env: {} };
    };
    const { entries } = await collectMediaAclEntries([agent("NOT-A-UUID!")], resolver);
    expect(entries).toHaveLength(0);
    expect(seen).toEqual([]);
  });
});

describe("buildBotsRegistryJson (determinism / snapshot)", () => {
  it("is byte-identical for equal entries in any order", () => {
    const A = { botKey: "aaa", tokenSha256: sha("ta"), peerHost: "myrmidon-bot-aaa", tools: ["file_put"] };
    const B = { botKey: "bbb", tokenSha256: sha("tb"), peerHost: "myrmidon-bot-bbb", tools: ["file_put"] };
    expect(buildBotsRegistryJson([A, B])).toBe(buildBotsRegistryJson([B, A]));
  });

  it("matches the load_bots contract shape", () => {
    const text = buildBotsRegistryJson([
      { botKey: "aaa", tokenSha256: sha("ta"), peerHost: "myrmidon-bot-aaa", tools: ["file_put", "file_get"] },
    ]);
    expect(JSON.parse(text)).toEqual({
      bots: {
        aaa: { token_sha256: sha("ta"), peer_host: "myrmidon-bot-aaa", tools: ["file_put", "file_get"] },
      },
    });
    expect(text.endsWith("\n")).toBe(true);
  });

  it("snapshot: fixed cards give fixed bytes", () => {
    const entries = [
      { botKey: "bbb", tokenSha256: sha("tb"), peerHost: "myrmidon-bot-bbb", tools: DEFAULT_MEDIA_TOOLS_ALLOWLIST },
      { botKey: "aaa", tokenSha256: sha("ta"), peerHost: "myrmidon-bot-aaa", tools: DEFAULT_MEDIA_TOOLS_ALLOWLIST },
    ];
    const parsed = JSON.parse(buildBotsRegistryJson(entries));
    expect(Object.keys(parsed.bots)).toEqual(["aaa", "bbb"]);
    expect(parsed.bots.aaa.token_sha256).toBe("76592b9de6d38238a52a3651867871e5c670e6320a8ef46a84b5590f8933f33e");
    expect(parsed.bots.aaa.tools[0]).toBe("file_put");
    expect(parsed.bots.aaa.tools).toHaveLength(11);
  });
});

describe("runMediaAclExport", () => {
  const A = "0f0f0f0f-1111-2222-3333-444444444444";
  const B = "1e1e1e1e-5555-6666-7777-888888888888";
  // Raw test tokens: neither may ever appear in the written file.
  const TOKEN_A = "sekr--secret-test-token-A";
  const TOKEN_B = "sekr--secret-test-token-B";

  const envOn = { MYRMIDON_BOT_CONTAINERS: "1" };

  it("writes the registry atomically with mode 0600 and reports the change", async () => {
    const file = await tmpFile();
    const result = await runMediaAclExport({
      listAgents: async () => [agent(A), agent(B)],
      resolveCardEnv: resolverFor({ [A]: TOKEN_A, [B]: TOKEN_B }),
      env: envOn,
      path: file,
    });
    expect(result).toMatchObject({ path: file, bots: 2, failedResolves: 0, changed: true });
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    const text = await fs.readFile(file, "utf8");
    // Deterministic: keys sorted.
    expect(Object.keys(JSON.parse(text).bots)).toEqual([A, B].sort());
    // The raw token never appears anywhere in the file; only the hash does.
    expect(text).not.toContain(TOKEN_A);
    expect(text).not.toContain(TOKEN_B);
    expect(text).toContain(sha(TOKEN_A));
    // No temp file left behind.
    const leftovers = (await fs.readdir(path.dirname(file))).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("the result JSON carries no raw token (loggable fields only)", async () => {
    const file = await tmpFile();
    const result = await runMediaAclExport({
      listAgents: async () => [agent(A)],
      resolveCardEnv: resolverFor({ [A]: TOKEN_A }),
      env: envOn,
      path: file,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN_A);
  });

  it("an identical second pass changes nothing and does not touch the file", async () => {
    const file = await tmpFile();
    const deps = {
      listAgents: async () => [agent(A), agent(B)],
      resolveCardEnv: resolverFor({ [A]: TOKEN_A, [B]: TOKEN_B }),
      env: envOn,
      path: file,
    };
    const first = await runMediaAclExport(deps);
    expect(first?.changed).toBe(true);
    const mtime = (await fs.stat(file)).mtimeMs;
    const second = await runMediaAclExport(deps);
    expect(second).toMatchObject({ bots: 2, changed: false });
    expect((await fs.stat(file)).mtimeMs).toBe(mtime);
  });

  it("re-stamps a registry whose mode drifted without changing text", async () => {
    const file = await tmpFile();
    const deps = {
      listAgents: async () => [agent(A)],
      resolveCardEnv: resolverFor({ [A]: TOKEN_A }),
      env: envOn,
      path: file,
    };
    await runMediaAclExport(deps);
    await fs.chmod(file, 0o644);
    const again = await runMediaAclExport(deps);
    expect(again?.changed).toBe(true);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("path comes from MYRMIDON_MEDIA_BOTS_FILE_ENV when deps.path is absent", async () => {
    const file = await tmpFile();
    const result = await runMediaAclExport({
      listAgents: async () => [],
      resolveCardEnv: resolverFor({}),
      env: { ...envOn, [MYRMIDON_MEDIA_BOTS_FILE_ENV]: file },
    });
    expect(result?.path).toBe(file);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ bots: {} });
  });

  it("the default is the facade's own default file", async () => {
    const result = await runMediaAclExport({
      listAgents: async () => [],
      // Unreachable default path with an empty fleet: the write of an empty
      // registry to "/" would throw, so assert the resolution without it —
      // changed:false only when the file is absent-and-empty is not possible;
      // instead assert the resolved path itself.
      resolveCardEnv: resolverFor({}),
      env: envOn,
    }).catch((err: unknown) => err);
    // On a CI container /config is not writable; either the resolved path is the
    // contract default or the attempt failed exactly on that path.
    if (result instanceof Error) {
      expect(String(result)).toContain(DEFAULT_MEDIA_BOTS_FILE);
    } else {
      expect((result as { path: string }).path).toBe(DEFAULT_MEDIA_BOTS_FILE);
    }
  });

  it("returns null while the bot-container flag is off and writes nothing", async () => {
    const file = await tmpFile();
    let listed = false;
    const result = await runMediaAclExport({
      listAgents: async () => {
        listed = true;
        return [];
      },
      resolveCardEnv: resolverFor({}),
      env: {},
      path: file,
    });
    expect(result).toBeNull();
    expect(listed).toBe(false);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("a removed token deletes the entry on the next pass", async () => {
    const file = await tmpFile();
    const run = (tokens: Record<string, string | null>) =>
      runMediaAclExport({
        listAgents: async () => [agent(A), agent(B)],
        resolveCardEnv: resolverFor(tokens),
        env: envOn,
        path: file,
      });
    await run({ [A]: TOKEN_A, [B]: TOKEN_B });
    const after = await run({ [A]: TOKEN_A, [B]: null });
    expect(after?.bots).toBe(1);
    const text = await fs.readFile(file, "utf8");
    expect(text).not.toContain(sha(TOKEN_B));
    expect(text).not.toContain(TOKEN_B);
  });
});

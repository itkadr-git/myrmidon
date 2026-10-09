import { describe, expect, it } from "vitest";

import {
  BOT_AUX_COMPRESSION_MODEL_ENV,
  BOT_AUX_FALLBACK_MODELS_ENV,
  BOT_AUX_TITLE_MODEL_ENV,
  BOT_BOARD_URL_ENV,
  BOT_COMPRESSION_THRESHOLD_TOKENS_ENV,
  BOT_HINDSIGHT_ALLOWED_BANKS_ENV,
  BOT_HINDSIGHT_API_URL_ENV,
  BOT_HINDSIGHT_BANK_ENV,
  BOT_LLM_API_KEY_ENV_ENV,
  BOT_LLM_API_KEY_SECRET_ENV,
  BOT_LLM_BASE_URL_ENV,
  BOT_MCP_SERVERS_ENV,
  BOT_MODEL_CONTEXT_LENGTH_ENV,
  BOT_RUNTIME_MCP_URL_BASE_ENV,
  BotProfileInputError,
} from "./profile-input.js";
import {
  createActivityWarningSink,
  createBotProfileCompile,
  HERMES_GATEWAY_ADAPTER_TYPE,
  NO_BOARD_GATEWAY_WARNING,
  type BotProfileAgentRecord,
  type BotProfilePorts,
} from "./profile-compile.js";
import { BOT_EGRESS_MODE_ENV, BOT_EGRESS_PROXY_ENV } from "./egress.js";
import { readMediaMcpSignals, resetMediaMcpSignals } from "./media-mcp.js";
import { WS_BOTD_BOARD_KEY_ENV_VALUE, WS_BOT_DISK_SETTING_DEFAULTS, WS_PROFILE_ENV } from "@paperclipai/shared";
import { classifyProfileChange, type CompiledProfile } from "./types.js";

// Placeholder data only: fake ids, example.com URLs, obviously-fake secrets.

const INSTANCE_ENV: NodeJS.ProcessEnv = {
  [BOT_HINDSIGHT_API_URL_ENV]: "https://example.com/hindsight",
  [BOT_HINDSIGHT_BANK_ENV]: "fleet-default",
  [BOT_LLM_BASE_URL_ENV]: "https://example.com/llm/v1",
  [BOT_LLM_API_KEY_ENV_ENV]: "FLEET_LLM_API_KEY",
  [BOT_BOARD_URL_ENV]: "http://board.example.com:3100",
};

function agentRecord(overrides: Partial<BotProfileAgentRecord> = {}): BotProfileAgentRecord {
  return {
    id: "agent-a",
    companyId: "company-1",
    name: "Agent A",
    adapterType: HERMES_GATEWAY_ADAPTER_TYPE,
    // A card that goes through the LLM gateway (the other tests read and place the gateway key for it);
    // cards with a native provider are covered in "a card whose provider goes through the LLM gateway".
    adapterConfig: { model: "some-model", provider: "custom" },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } },
    ...overrides,
  };
}

interface FakeBoard {
  ports: BotProfilePorts;
  calls: string[];
  secrets: Map<string, string>;
  agent: { current: BotProfileAgentRecord | null };
}

/** In-memory board: get-or-create secrets by deterministic name, like profile-ports.ts. */
function fakeBoard(overrides: Partial<BotProfilePorts> = {}): FakeBoard {
  const calls: string[] = [];
  const secrets = new Map<string, string>([["FLEET_LLM_API_KEY", "fake-llm-key-0001"]]);
  const agent = { current: agentRecord() as BotProfileAgentRecord | null };
  const ports: BotProfilePorts = {
    async loadAgent() {
      calls.push("loadAgent");
      return agent.current;
    },
    async resolveCardEnv() {
      calls.push("resolveCardEnv");
      return { env: {}, warnings: [] };
    },
    async readCompanySecret(_companyId, name) {
      calls.push(`readCompanySecret:${name}`);
      return secrets.get(name) ?? null;
    },
    async ensureApiServerKey(record) {
      calls.push("ensureApiServerKey");
      const name = `api-server-key-${record.id}`;
      if (!secrets.has(name)) secrets.set(name, `fake-api-server-key-${secrets.size}`);
      return { value: secrets.get(name) as string, secretId: `secret-${name}` };
    },
    async ensureAgentApiKey(record) {
      calls.push("ensureAgentApiKey");
      const name = `agent-api-key-${record.id}`;
      if (!secrets.has(name)) secrets.set(name, `fake-paperclip-api-key-${secrets.size}`);
      return { value: secrets.get(name) as string };
    },
    async loadSkills() {
      calls.push("loadSkills");
      return { skills: {}, warnings: [] };
    },
    async loadInstructions() {
      calls.push("loadInstructions");
      return { files: [], warnings: [] };
    },
    // A quiet board: the gateway port is present (and has nothing to hand out), so the
    // "no board gateway" warning is not raised; the tests that want it override this.
    async listMcpServers() {
      calls.push("listMcpServers");
      return [];
    },
    ...overrides,
  };
  return { ports, calls, secrets, agent };
}

function fileContent(profile: CompiledProfile, path: string): string {
  const found = profile.files.find((file) => file.path === path);
  if (!found) throw new Error(`no compiled file at ${path}`);
  return found.content;
}

describe("myrmidon(W2a) createBotProfileCompile", () => {
  it("compiles a card into the profile files, credentials in .env only", async () => {
    const board = fakeBoard();
    const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
    const profile = await compile("agent-a", "agent-a");

    expect(profile.botKey).toBe("agent-a");
    expect(profile.files.map((file) => file.path).sort()).toEqual([
      "hermes/.env",
      "hermes/config.yaml",
      "hermes/hindsight/config.json",
    ]);
    const env = fileContent(profile, "hermes/.env");
    expect(env).toContain('FLEET_LLM_API_KEY="fake-llm-key-0001"');
    expect(env).toContain('PAPERCLIP_API_URL="http://board.example.com:3100"');
    expect(env).toMatch(/API_SERVER_KEY="fake-api-server-key-\d+"/);
    expect(env).toMatch(/PAPERCLIP_API_KEY="fake-paperclip-api-key-\d+"/);
    expect(fileContent(profile, "hermes/config.yaml")).not.toContain("fake-llm-key-0001");
    expect(fileContent(profile, "hermes/hindsight/config.json")).toContain("fleet-default");
  });

  describe("myrmidon(BOT-DISK-F) isolation scope", () => {
    it("a member of a shared scope instance gets the instance's pnpm store, with or without the shared package cache", async () => {
      const board = fakeBoard({
        scopeLayout: async () => ({ kind: "shared", dirName: "caste-x-engineer" }),
        pnpmSettings: async () => ({ storeDir: "/cache/pnpm-store", importMethod: "clone" }),
      });
      const env = fileContent(await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a"), "hermes/.env");
      expect(env).toContain('npm_config_store_dir="/bot-scope/.pnpm-store"');
      expect(env).toContain('npm_config_package_import_method="clone"');
      expect(env).not.toContain("/cache/pnpm-store");
      // myrmidon(1.6.5 BOT-DISK-G): and the instance's shared git object store.
      expect(env).toContain('MYRMIDON_GIT_LOCAL_MIRROR="/bot-scope/.git-objects"');
    });

    it("an isolated bot, or a port that is absent, keeps the profile it had (no store variable without the cache)", async () => {
      for (const ports of [{ scopeLayout: async () => ({ kind: "isolated" as const }) }, {}]) {
        const board = fakeBoard(ports);
        const env = fileContent(await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a"), "hermes/.env");
        expect(env).not.toContain("npm_config_store_dir");
        // myrmidon(1.6.5 BOT-DISK-G): an isolated bot keeps the wrapper's own
        // per-bot default (no variable): its store lives in its own hermes home.
        expect(env).not.toContain("MYRMIDON_GIT_LOCAL_MIRROR");
      }
    });

    it("myrmidon(1.6.5-BOT-DISK-UV-A): a configured cache compiles the uv pair into hermes/.env", async () => {
      const board = fakeBoard({
        sharedPackageCachePath: async () => "/srv/cache",
        uvSettings: async () => ({ cacheDir: "/cache/uv", linkMode: "clone" }),
      });
      const compiled = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      const env = fileContent(compiled, "hermes/.env");
      expect(env).toContain('UV_CACHE_DIR="/cache/uv"');
      expect(env).toContain('UV_LINK_MODE="clone"');
      // The board's value wins over the card's, with a warning, like the cache variables.
      const cardBoard = fakeBoard({
        sharedPackageCachePath: async () => "/srv/cache",
        resolveCardEnv: async () => ({ env: { UV_CACHE_DIR: { value: "/elsewhere", secret: false } }, warnings: [] }),
      });
      const reported: string[][] = [];
      const cardCompiled = await createBotProfileCompile(cardBoard.ports, {
        env: INSTANCE_ENV,
        onWarnings: (_botKey, list) => {
          reported.push([...list]);
        },
      })("agent-a", "agent-a");
      const cardEnv = fileContent(cardCompiled, "hermes/.env");
      expect(cardEnv).toContain('UV_CACHE_DIR="/cache/uv"');
      expect(cardEnv).not.toContain("/elsewhere");
      expect(reported.flat().some((warning) => warning.includes('"UV_CACHE_DIR"') && warning.includes("card's value was dropped"))).toBe(true);
    });

    it("changing the applied layout changes the restart hash, so the container restarts onto it", async () => {
      const isolated = await createBotProfileCompile(fakeBoard({ scopeLayout: async () => ({ kind: "isolated" }) }).ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      const shared = await createBotProfileCompile(
        fakeBoard({ scopeLayout: async () => ({ kind: "shared", dirName: "caste-x-engineer" }) }).ports,
        { env: INSTANCE_ENV },
      )("agent-a", "agent-a");
      expect(shared.restartHash).not.toBe(isolated.restartHash);
    });
  });

  it("is idempotent: a second tick with nothing changed gives the same hashes", async () => {
    const board = fakeBoard();
    const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
    const first = await compile("agent-a", "agent-a");
    const second = await compile("agent-a", "agent-a");
    expect(second.restartHash).toBe(first.restartHash);
    expect(second.filesHash).toBe(first.filesHash);
    expect(board.secrets.size).toBe(3); // the LLM key plus the two per-bot secrets, created once
  });

  describe("myrmidon(1.6.5-BOT-DISK-H5c) workspace/botd mechanics (C7)", () => {
    it("compiles the mechanics env with the contract defaults when the settings row is empty", async () => {
      const board = fakeBoard({
        botDiskMechanics: async () => ({
          graceClosingMinutes: WS_BOT_DISK_SETTING_DEFAULTS.graceClosingMinutes,
          scratchTtlHours: WS_BOT_DISK_SETTING_DEFAULTS.scratchTtlHours,
          partitionThresholdPercent: WS_BOT_DISK_SETTING_DEFAULTS.partitionThresholdPercent,
          partitionRefuseOpenPercent: WS_BOT_DISK_SETTING_DEFAULTS.partitionRefuseOpenPercent,
          partitionCriticalPercent: WS_BOT_DISK_SETTING_DEFAULTS.partitionCriticalPercent,
        }),
      });
      const env = fileContent(await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a"), "hermes/.env");
      expect(env).toContain(`${WS_PROFILE_ENV.partitionThresholdPercent}="85"`);
      expect(env).toContain(`${WS_PROFILE_ENV.partitionRefuseOpenPercent}="90"`);
      expect(env).toContain(`${WS_PROFILE_ENV.partitionCriticalPercent}="95"`);
      expect(env).toContain(`${WS_PROFILE_ENV.graceClosingMinutes}="30"`);
      expect(env).toContain(`${WS_PROFILE_ENV.scratchTtlHours}="24"`);
      // No operator-set interval: no variable, botd's in-image default applies (H3).
      expect(env).not.toContain(WS_PROFILE_ENV.botdIntervalSec);
      // The board address is the one the gateway already points the bot at, and the
      // key travels only as the NAME of the .env variable holding it — never the value.
      expect(env).toContain(`${WS_PROFILE_ENV.boardUrl}="http://board.example.com:3100"`);
      expect(env).toContain(`${WS_PROFILE_ENV.boardKeyEnv}="${WS_BOTD_BOARD_KEY_ENV_VALUE}"`);
      expect(env).not.toContain(`${WS_PROFILE_ENV.boardKeyEnv}="fake-paperclip-api-key`);
      // botd reports under its own key: the agent id, written by the board.
      expect(env).toContain('MYRMIDON_BOT_KEY="agent-a"');
    });

    it("compiles the operator-set values (incl. the botd interval) over the defaults", async () => {
      const board = fakeBoard({
        botDiskMechanics: async () => ({
          graceClosingMinutes: 45,
          scratchTtlHours: 12,
          partitionThresholdPercent: 80,
          partitionRefuseOpenPercent: 88,
          partitionCriticalPercent: 93,
          botdIntervalSec: 300,
        }),
      });
      const env = fileContent(await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a"), "hermes/.env");
      expect(env).toContain(`${WS_PROFILE_ENV.partitionThresholdPercent}="80"`);
      expect(env).toContain(`${WS_PROFILE_ENV.partitionRefuseOpenPercent}="88"`);
      expect(env).toContain(`${WS_PROFILE_ENV.partitionCriticalPercent}="93"`);
      expect(env).toContain(`${WS_PROFILE_ENV.graceClosingMinutes}="45"`);
      expect(env).toContain(`${WS_PROFILE_ENV.scratchTtlHours}="12"`);
      expect(env).toContain(`${WS_PROFILE_ENV.botdIntervalSec}="300"`);
    });

    it("the instance values win over the card's own, with a warning", async () => {
      const board = fakeBoard({
        async resolveCardEnv() {
          return { env: { [WS_PROFILE_ENV.partitionThresholdPercent]: { value: "99", secret: false } }, warnings: [] };
        },
        botDiskMechanics: async () => ({
          graceClosingMinutes: 30,
          scratchTtlHours: 24,
          partitionThresholdPercent: 85,
          partitionRefuseOpenPercent: 90,
          partitionCriticalPercent: 95,
        }),
      });
      const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      const env = fileContent(profile, "hermes/.env");
      expect(env).toContain(`${WS_PROFILE_ENV.partitionThresholdPercent}="85"`);
      expect(env).not.toContain('"99"');
    });

    it("changes the restart hash when the mechanics change: the next tick restarts the bot onto them", async () => {
      const defaults = fakeBoard({
        botDiskMechanics: async () => ({
          graceClosingMinutes: 30,
          scratchTtlHours: 24,
          partitionThresholdPercent: 85,
          partitionRefuseOpenPercent: 90,
          partitionCriticalPercent: 95,
        }),
      });
      const changed = fakeBoard({
        botDiskMechanics: async () => ({
          graceClosingMinutes: 60,
          scratchTtlHours: 24,
          partitionThresholdPercent: 85,
          partitionRefuseOpenPercent: 90,
          partitionCriticalPercent: 95,
        }),
      });
      const first = await createBotProfileCompile(defaults.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      const second = await createBotProfileCompile(changed.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      expect(second.restartHash).not.toBe(first.restartHash);
    });

    it("keeps the profile byte-identical between two compiles of the same settings (deterministic output)", async () => {
      const ports: Partial<BotProfilePorts> = {
        botDiskMechanics: async () => ({
          graceClosingMinutes: 45,
          scratchTtlHours: 12,
          partitionThresholdPercent: 80,
          partitionRefuseOpenPercent: 88,
          partitionCriticalPercent: 93,
          botdIntervalSec: 300,
        }),
      };
      const a = await createBotProfileCompile(fakeBoard(ports).ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      const b = await createBotProfileCompile(fakeBoard(ports).ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      expect(fileContent(b, "hermes/.env")).toBe(fileContent(a, "hermes/.env"));
      expect(fileContent(b, "hermes/config.yaml")).toBe(fileContent(a, "hermes/config.yaml"));
    });

    it("without the port the profile carries no BOT-DISK-H variables (a board before H5c)", async () => {
      const env = fileContent(await createBotProfileCompile(fakeBoard().ports, { env: INSTANCE_ENV })("agent-a", "agent-a"), "hermes/.env");
      for (const name of Object.values(WS_PROFILE_ENV)) {
        expect(env).not.toContain(name);
      }
    });
  });

  it("puts the company's skills, MCP servers and instance defaults through to the profile", async () => {
    const board = fakeBoard({
      async loadSkills() {
        return { skills: { "code-review": [{ path: "SKILL.md", content: "# Code review\n" }] }, warnings: [] };
      },
      async listMcpServers() {
        return [{ name: "board", url: "https://example.com/api/mcp/gateway/abc", token: "fake-mcp-token-0001" }];
      },
    });
    const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
    expect(profile.files.some((file) => file.path.includes("code-review") && file.path.endsWith("SKILL.md"))).toBe(true);
    expect(fileContent(profile, "hermes/config.yaml")).toContain("Bearer ${MYRMIDON_MCP_TOKEN_BOARD}");
    expect(fileContent(profile, "hermes/.env")).toContain('MYRMIDON_MCP_TOKEN_BOARD="fake-mcp-token-0001"');
  });

  it("asks the company secret for the LLM key only when the card's own env lacks it", async () => {
    const withCardKey = fakeBoard({
      async resolveCardEnv() {
        return { env: { FLEET_LLM_API_KEY: { value: "fake-card-key", secret: true } }, warnings: [] };
      },
    });
    const profile = await createBotProfileCompile(withCardKey.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
    expect(withCardKey.calls.some((call) => call.startsWith("readCompanySecret"))).toBe(false);
    expect(fileContent(profile, "hermes/.env")).toContain('FLEET_LLM_API_KEY="fake-card-key"');

    const fromSecret = fakeBoard();
    await createBotProfileCompile(fromSecret.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
    expect(fromSecret.calls).toContain("readCompanySecret:FLEET_LLM_API_KEY");
  });

  it("reads the company secret named by MYRMIDON_BOT_LLM_API_KEY_SECRET", async () => {
    const board = fakeBoard();
    board.secrets.set("fleet-llm-gateway-key", "fake-gateway-secret-0002");
    const profile = await createBotProfileCompile(board.ports, {
      env: { ...INSTANCE_ENV, [BOT_LLM_API_KEY_SECRET_ENV]: "fleet-llm-gateway-key" },
    })("agent-a", "agent-a");
    expect(board.calls).toContain("readCompanySecret:fleet-llm-gateway-key");
    expect(fileContent(profile, "hermes/.env")).toContain('FLEET_LLM_API_KEY="fake-gateway-secret-0002"');
  });

  it("a rotated secret changes the restart hash: the next tick restarts the bot", async () => {
    const board = fakeBoard();
    const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
    const before = await compile("agent-a", "agent-a");
    board.secrets.set("FLEET_LLM_API_KEY", "fake-llm-key-0002");
    const after = await compile("agent-a", "agent-a");
    expect(after.restartHash).not.toBe(before.restartHash);
  });

  it("reads the instance settings on every call, so a corrected variable needs no rebuild", async () => {
    const board = fakeBoard();
    const env: NodeJS.ProcessEnv = { ...INSTANCE_ENV };
    const compile = createBotProfileCompile(board.ports, { env });
    const first = await compile("agent-a", "agent-a");
    env[BOT_HINDSIGHT_BANK_ENV] = "fleet-other";
    const second = await compile("agent-a", "agent-a");
    expect(fileContent(second, "hermes/hindsight/config.json")).toContain("fleet-other");
    expect(second.restartHash).not.toBe(first.restartHash);
  });

  describe("myrmidon(EGRESS-A) proxied egress", () => {
    const EGRESS_ENV: NodeJS.ProcessEnv = {
      ...INSTANCE_ENV,
      [BOT_EGRESS_MODE_ENV]: "log",
      [BOT_EGRESS_PROXY_ENV]: "http://egress.example.com:3128",
    };

    it("writes the instance's proxy into the bot's .env with the bot's key as the proxy user", async () => {
      const board = fakeBoard();
      const profile = await createBotProfileCompile(board.ports, { env: EGRESS_ENV })("agent-a", "agent-a");
      const env = fileContent(profile, "hermes/.env");
      const url = 'http://agent-a:egress@egress.example.com:3128/';
      expect(env).toContain(`HTTP_PROXY="${url}"`);
      expect(env).toContain(`HTTPS_PROXY="${url}"`);
      expect(env).toContain(`ALL_PROXY="${url}"`);
      expect(env).toContain('NODE_USE_ENV_PROXY="1"');
      // The board stays direct: every bot calls it constantly, and it is on the bots' own network.
      expect(env).toMatch(/NO_PROXY="[^"]*board\.example\.com/);
    });

    it("changes nothing about the profile while the mode is off (the fleet default)", async () => {
      const board = fakeBoard();
      const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      expect(fileContent(profile, "hermes/.env")).not.toContain("HTTP_PROXY");
      expect(fileContent(profile, "hermes/.env")).not.toContain("NODE_USE_ENV_PROXY");
    });

    it("gives the instance's proxy precedence over the card's own, and says so", async () => {
      const warnings: string[][] = [];
      const board = fakeBoard({
        async resolveCardEnv() {
          return {
            env: { HTTP_PROXY: { value: "http://card.example.com:8080", secret: false } },
            warnings: [],
          };
        },
      });
      const profile = await createBotProfileCompile(board.ports, {
        env: EGRESS_ENV,
        onWarnings: (_botKey, list) => {
          warnings.push([...list]);
        },
      })("agent-a", "agent-a");
      const env = fileContent(profile, "hermes/.env");
      expect(env).toContain('HTTP_PROXY="http://agent-a:egress@egress.example.com:3128/"');
      expect(env).not.toContain("card.example.com");
      expect(warnings.flat().join("\n")).toContain('"HTTP_PROXY" is set by MYRMIDON_BOT_EGRESS_MODE');
    });

    it("refuses a log-mode profile with no address before reading the card at all", async () => {
      const board = fakeBoard();
      await expect(
        createBotProfileCompile(board.ports, { env: { ...INSTANCE_ENV, [BOT_EGRESS_MODE_ENV]: "log" } })("agent-a", "agent-a"),
      ).rejects.toThrow(/MYRMIDON_BOT_EGRESS_PROXY must be set/);
      expect(board.calls).toEqual([]);
    });
  });

  describe("myrmidon(MEMORY-ISOLATION) hindsight bank allowlist and observation scopes", () => {
    const CARD_HINDSIGHT = { model: "some-model", provider: "custom", hindsight: { bankId: "bank-a", observationScopes: [["channel:board"], ["channel:telegram"]] } };

    it("writes the card's observationScopes into hermes/hindsight/config.json", async () => {
      const board = fakeBoard();
      board.agent.current = agentRecord({ adapterConfig: CARD_HINDSIGHT });
      const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      const json = JSON.parse(fileContent(profile, "hermes/hindsight/config.json")) as Record<string, unknown>;
      expect(json.observation_scopes).toEqual([["channel:board"], ["channel:telegram"]]);
      expect(json.bank_id).toBe("bank-a");
    });

    it("fails the compile, creating no secret, when the card's bank is outside the allowlist", async () => {
      const board = fakeBoard();
      board.agent.current = agentRecord({ adapterConfig: CARD_HINDSIGHT });
      const compile = createBotProfileCompile(board.ports, {
        env: { ...INSTANCE_ENV, [BOT_HINDSIGHT_ALLOWED_BANKS_ENV]: "bank-c,bank-b" },
      });
      await expect(compile("agent-a", "agent-a")).rejects.toThrow(BotProfileInputError);
      await expect(compile("agent-a", "agent-a")).rejects.toThrow(BOT_HINDSIGHT_ALLOWED_BANKS_ENV);
      await expect(compile("agent-a", "agent-a")).rejects.toThrow("bank-a");
      expect(board.calls).not.toContain("ensureApiServerKey");
      expect(board.calls).not.toContain("ensureAgentApiKey");
    });

    it("compiles the same card once the bank is on the allowlist, and a card without scopes stays without", async () => {
      const board = fakeBoard();
      board.agent.current = agentRecord({ adapterConfig: CARD_HINDSIGHT });
      const profile = await createBotProfileCompile(board.ports, {
        env: { ...INSTANCE_ENV, [BOT_HINDSIGHT_ALLOWED_BANKS_ENV]: "bank-c,bank-a" },
      })("agent-a", "agent-a");
      expect(JSON.parse(fileContent(profile, "hermes/hindsight/config.json")).bank_id).toBe("bank-a");

      const plain = fakeBoard();
      const plainProfile = await createBotProfileCompile(plain.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      expect(JSON.parse(fileContent(plainProfile, "hermes/hindsight/config.json")).observation_scopes).toBeUndefined();
    });

    it("no allowlist set: the previous behavior, any bank compiles", async () => {
      const board = fakeBoard();
      board.agent.current = agentRecord({ adapterConfig: CARD_HINDSIGHT });
      const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      expect(JSON.parse(fileContent(profile, "hermes/hindsight/config.json")).bank_id).toBe("bank-a");
    });
  });

  describe("instance-wide MCP servers (MYRMIDON_BOT_MCP_SERVERS)", () => {
    const RAGFLOW = [{ name: "ragflow", url: "https://example.com/ragflow/mcp", tokenSecret: "fleet-ragflow-token" }];
    const withMcp = (servers: unknown): NodeJS.ProcessEnv => ({
      ...INSTANCE_ENV,
      [BOT_MCP_SERVERS_ENV]: JSON.stringify(servers),
    });

    it("gives every bot the declared server: header in config.yaml, token in .env, read from the company secret", async () => {
      const board = fakeBoard();
      board.secrets.set("fleet-ragflow-token", "fake-ragflow-token-0001");
      const profile = await createBotProfileCompile(board.ports, { env: withMcp(RAGFLOW) })("agent-a", "agent-a");
      const config = fileContent(profile, "hermes/config.yaml");
      expect(config).toContain("ragflow:");
      expect(config).toContain("https://example.com/ragflow/mcp");
      expect(config).toContain("Bearer ${MYRMIDON_MCP_TOKEN_RAGFLOW}");
      expect(config).not.toContain("fake-ragflow-token-0001");
      expect(fileContent(profile, "hermes/.env")).toContain('MYRMIDON_MCP_TOKEN_RAGFLOW="fake-ragflow-token-0001"');
      expect(board.calls).toContain("readCompanySecret:fleet-ragflow-token");
    });

    it("keeps the declared URL as given: the board-gateway origin rewrite is not for it", async () => {
      const board = fakeBoard();
      board.secrets.set("fleet-ragflow-token", "fake-ragflow-token-0001");
      const profile = await createBotProfileCompile(board.ports, {
        env: { ...withMcp(RAGFLOW), [BOT_RUNTIME_MCP_URL_BASE_ENV]: "http://board.example.com:3100" },
      })("agent-a", "agent-a");
      expect(fileContent(profile, "hermes/config.yaml")).toContain("https://example.com/ragflow/mcp");
      expect(fileContent(profile, "hermes/config.yaml")).not.toContain("board.example.com:3100/ragflow");
    });

    it("honors a custom header and a raw (scheme-less) token", async () => {
      const board = fakeBoard();
      board.secrets.set("fleet-ragflow-token", "fake-ragflow-token-0001");
      const profile = await createBotProfileCompile(board.ports, {
        env: withMcp([{ ...RAGFLOW[0], header: "X-Api-Key", scheme: "" }]),
      })("agent-a", "agent-a");
      const config = fileContent(profile, "hermes/config.yaml");
      expect(config).toContain('X-Api-Key: "${MYRMIDON_MCP_TOKEN_RAGFLOW}"');
      expect(config).not.toContain("Bearer");
      expect(config).not.toContain("Authorization");
    });

    it("passes a server that takes no token, with no header and no .env variable", async () => {
      const board = fakeBoard();
      const profile = await createBotProfileCompile(board.ports, {
        env: withMcp([{ name: "docs", url: "https://example.com/docs/mcp", noAuth: true }]),
      })("agent-a", "agent-a");
      expect(fileContent(profile, "hermes/config.yaml")).toContain("https://example.com/docs/mcp");
      expect(fileContent(profile, "hermes/config.yaml")).not.toContain("headers");
      expect(fileContent(profile, "hermes/.env")).not.toContain("MYRMIDON_MCP_TOKEN_DOCS");
      expect(board.calls.filter((call) => call.startsWith("readCompanySecret"))).toEqual(["readCompanySecret:FLEET_LLM_API_KEY"]);
    });

    it("fails loudly, creating nothing, when the token's company secret is missing", async () => {
      const board = fakeBoard();
      const secretsBefore = board.secrets.size;
      const compile = createBotProfileCompile(board.ports, { env: withMcp(RAGFLOW) });
      await expect(compile("agent-a", "agent-a")).rejects.toThrow(BotProfileInputError);
      await expect(compile("agent-a", "agent-a")).rejects.toThrow("fleet-ragflow-token");
      expect(board.calls).not.toContain("ensureApiServerKey");
      expect(board.calls).not.toContain("ensureAgentApiKey");
      expect(board.secrets.size).toBe(secretsBefore);
    });

    it("fails loudly when the secret exists but is empty", async () => {
      const board = fakeBoard();
      board.secrets.set("fleet-ragflow-token", "   ");
      await expect(createBotProfileCompile(board.ports, { env: withMcp(RAGFLOW) })("agent-a", "agent-a")).rejects.toThrow(
        "missing or empty",
      );
    });

    it("fails before any lookup on a broken declaration, naming the setting and never a value", async () => {
      for (const raw of ["not json", "{}", JSON.stringify([{ name: "ragflow", url: "https://example.com/mcp" }])]) {
        const board = fakeBoard();
        const compile = createBotProfileCompile(board.ports, { env: { ...INSTANCE_ENV, [BOT_MCP_SERVERS_ENV]: raw } });
        await expect(compile("agent-a", "agent-a")).rejects.toThrow(BOT_MCP_SERVERS_ENV);
        expect(board.calls).toEqual([]);
      }
    });

    it("puts the declared servers ahead of the gateway port's: a same-named one loses, with a warning", async () => {
      const board = fakeBoard({
        async listMcpServers() {
          return [
            { name: "ragflow", url: "https://example.com/other/mcp", token: "fake-other-token" },
            { name: "board", url: "https://example.com/api/mcp/gateway/abc", token: "fake-mcp-token-0001" },
          ];
        },
      });
      board.secrets.set("fleet-ragflow-token", "fake-ragflow-token-0001");
      const reported: string[][] = [];
      const profile = await createBotProfileCompile(board.ports, {
        env: withMcp(RAGFLOW),
        onWarnings: (_botKey, warnings) => {
          reported.push([...warnings]);
        },
      })("agent-a", "agent-a");
      const config = fileContent(profile, "hermes/config.yaml");
      expect(config).toContain("https://example.com/ragflow/mcp");
      expect(config).not.toContain("https://example.com/other/mcp");
      expect(config).toContain("board:");
      expect(reported.flat().some((warning) => warning.includes("ragflow") && warning.includes("duplicate"))).toBe(true);
    });

    it("does not rewrite the board gateway URL with the runtime MCP URL base", async () => {
      const board = fakeBoard({
        async listMcpServers() {
          return [{ name: "paperclip-assigned", url: "http://paperclip-server-1:3100/mcp/gateways/gw_x", token: "fake-mcp-token-0001" }];
        },
      });
      const profile = await createBotProfileCompile(board.ports, {
        env: { ...INSTANCE_ENV, [BOT_RUNTIME_MCP_URL_BASE_ENV]: "http://127.0.0.1:3100" },
      })("agent-a", "agent-a");
      const config = fileContent(profile, "hermes/config.yaml");
      expect(config).toContain("http://paperclip-server-1:3100/mcp/gateways/gw_x");
      expect(config).not.toContain("127.0.0.1");
    });

    it("is stable across ticks", async () => {
      const board = fakeBoard();
      board.secrets.set("fleet-ragflow-token", "fake-ragflow-token-0001");
      const compile = createBotProfileCompile(board.ports, { env: withMcp(RAGFLOW) });
      const first = await compile("agent-a", "agent-a");
      const second = await compile("agent-a", "agent-a");
      expect(second.restartHash).toBe(first.restartHash);
    });
  });

  describe("media MCP block (OPE-6377, 1.6.5-F11-A)", () => {
    it("adds the media server when the card carries MEDIA_TOOLS_TOKEN, never printing the token", async () => {
      const board = fakeBoard({
        async resolveCardEnv() {
          calls.push("resolveCardEnv");
          return { env: { MEDIA_TOOLS_TOKEN: { value: "fake-media-token-agent-a", secret: false } }, warnings: [] };
        },
      });
      const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      const config = fileContent(profile, "hermes/config.yaml");
      expect(config).toContain("media:");
      expect(config).toContain("http://media-mcp:8080/mcp");
      expect(config).toContain("Bearer ${MYRMIDON_MCP_TOKEN_MEDIA}");
      expect(config).not.toContain("fake-media-token-");
      const env = fileContent(profile, "hermes/.env");
      expect(env).toContain('MEDIA_TOOLS_TOKEN="fake-media-token-agent-a"');
      expect(env).toContain("MEDIA_TOOLS_URL=");
      expect(env).toContain('MYRMIDON_MCP_TOKEN_MEDIA="fake-media-token-agent-a"');
    });

    it("honors MYRMIDON_MEDIA_MCP_URL when set", async () => {
      const board = fakeBoard({
        async resolveCardEnv() {
          calls.push("resolveCardEnv");
          return { env: { MEDIA_TOOLS_TOKEN: { value: "fake-media-token-1", secret: false } }, warnings: [] };
        },
      });
      const profile = await createBotProfileCompile(board.ports, {
        env: { ...INSTANCE_ENV, MYRMIDON_MEDIA_MCP_URL: "http://media-mcp.example:8080/mcp" },
      })("agent-a", "agent-a");
      expect(fileContent(profile, "hermes/config.yaml")).toContain("http://media-mcp.example:8080/mcp");
    });

    it("without a card token there is no media block and no media env, with a «media not connected» warning", async () => {
      const board = fakeBoard();
      const reported: string[][] = [];
      const profile = await createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (_botKey, warnings) => {
          reported.push([...warnings]);
        },
      })("agent-a", "agent-a");
      const config = fileContent(profile, "hermes/config.yaml");
      expect(config).not.toContain("media:");
      expect(config).not.toContain("media-mcp");
      const env = fileContent(profile, "hermes/.env");
      expect(env).not.toContain("MEDIA_TOOLS_TOKEN");
      expect(env).not.toContain("MYRMIDON_MCP_TOKEN_MEDIA");
      expect(reported.flat().some((warning) => warning.includes("media") && warning.includes("not connected"))).toBe(true);
    });

    it("records one «media not connected» signal per pass when the card token is missing", async () => {
      const board = fakeBoard();
      const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
      const pass = compile.beginPass();
      await compile("agent-a", "agent-a");
      compile.endPass(pass);
      const signals = readMediaMcpSignals("company-1");
      expect(signals).toHaveLength(1);
      expect(signals[0].agentId).toBe("agent-a");
      expect(signals[0].botKey).toBe("agent-a");
      expect(signals[0].whyNow).toContain("media");
      resetMediaMcpSignals();
    });

    it("a bot whose card carries the token inside the pass leaves no signal", async () => {
      const board = fakeBoard({
        async resolveCardEnv() {
          calls.push("resolveCardEnv");
          return { env: { MEDIA_TOOLS_TOKEN: { value: "fake-media-token-1", secret: false } }, warnings: [] };
        },
      });
      const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
      const pass = compile.beginPass();
      await compile("agent-a", "agent-a");
      compile.endPass(pass);
      expect(readMediaMcpSignals("company-1")).toEqual([]);
      resetMediaMcpSignals();
    });

    it("a blank card token (whitespace) is no token: no media block, no signal", async () => {
      const board = fakeBoard({
        async resolveCardEnv() {
          calls.push("resolveCardEnv");
          return { env: { MEDIA_TOOLS_TOKEN: { value: "   ", secret: false } }, warnings: [] };
        },
      });
      const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
      const pass = compile.beginPass();
      const profile = await compile("agent-a", "agent-a");
      compile.endPass(pass);
      expect(fileContent(profile, "hermes/config.yaml")).not.toContain("media:");
      expect(readMediaMcpSignals("company-1")).toEqual([]);
      resetMediaMcpSignals();
    });
  });

  describe("the board tool gateway", () => {
    it("says so in the warnings while the gateway port is not provided", async () => {
      const board = fakeBoard({ listMcpServers: undefined });
      const reported: string[][] = [];
      await createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (_botKey, warnings) => {
          reported.push([...warnings]);
        },
      })("agent-a", "agent-a");
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain(NO_BOARD_GATEWAY_WARNING);
    });

    it("stays quiet once the port is provided", async () => {
      const board = fakeBoard();
      const reported: string[][] = [];
      await createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (_botKey, warnings) => {
          reported.push([...warnings]);
        },
      })("agent-a", "agent-a");
      expect(reported).toEqual([]);
    });

    it("reaches the activity log as one info entry per change, carrying the agent and bot", async () => {
      const board = fakeBoard({ listMcpServers: undefined });
      const entries: Array<Record<string, unknown>> = [];
      const compile = createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: createActivityWarningSink({
          record(entry) {
            entries.push(entry);
          },
        }),
      });
      await compile("agent-a", "bot-a");
      await compile("agent-a", "bot-a");
      expect(entries).toEqual([
        {
          level: "info",
          agentId: "agent-a",
          botKey: "bot-a",
          message: "bot profile warnings",
          details: { warnings: [NO_BOARD_GATEWAY_WARNING] },
        },
      ]);
    });

    it("carries the instructions bundle's and the board key's warnings too", async () => {
      const board = fakeBoard({
        async loadInstructions() {
          return { files: [], warnings: ["instructions bundle: big.md is larger than 262144 bytes, skipped"] };
        },
        async ensureAgentApiKey() {
          return { value: "fake-paperclip-api-key-0001", warnings: ["board API key key-1: replaced by a new key, revoke failed (x)"] };
        },
      });
      const reported: string[][] = [];
      await createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (_botKey, warnings) => {
          reported.push([...warnings]);
        },
      })("agent-a", "agent-a");
      expect(reported.flat()).toEqual(
        expect.arrayContaining([
          "instructions bundle: big.md is larger than 262144 bytes, skipped",
          "board API key key-1: replaced by a new key, revoke failed (x)",
        ]),
      );
    });
  });

  describe("instructions: not compiled into the workspace", () => {
    const CARD_MARKER = "CARD-MARKER-91be";
    // What tripped the gateway's injection scan on real bundles: a curl example that names a key variable.
    const CURL_EXAMPLE = 'Post it with: curl -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" https://example.com/api/comments';

    function occurrences(profile: CompiledProfile, marker: string): string[] {
      return profile.files.filter((file) => file.content.includes(marker)).map((file) => file.path);
    }

    it("writes no AGENTS.md and carries no instruction text into the profile: the run request delivers it", async () => {
      const board = fakeBoard();
      board.agent.current = agentRecord({
        adapterConfig: { model: "anthropic/claude-sonnet-5", provider: "anthropic", instructions: `Stay polite. ${CARD_MARKER}` },
      });
      const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      expect(occurrences(profile, CARD_MARKER)).toEqual([]);
      expect(profile.files.filter((file) => file.path.toLowerCase().endsWith("agents.md"))).toEqual([]);
    });

    it("cannot be blinded by an instruction text the gateway's injection scan would block", async () => {
      const board = fakeBoard();
      board.agent.current = agentRecord({
        adapterConfig: {
          model: "anthropic/claude-sonnet-5",
          provider: "anthropic",
          instructions: `Report through the board. ${CURL_EXAMPLE}`,
          payloadTemplate: { instructions: CURL_EXAMPLE },
        },
      });
      const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      // No file the gateway loads as project context: nothing for the scanner to replace with a stub.
      expect(occurrences(profile, "curl")).toEqual([]);
      expect(profile.files.filter((file) => file.path.startsWith("workspace/"))).toEqual([]);
    });

    it("does not read the card's instructions at all: the same profile whatever they say", async () => {
      const compileWith = async (instructions: string) => {
        const board = fakeBoard();
        board.agent.current = agentRecord({ adapterConfig: { model: "anthropic/claude-sonnet-5", provider: "anthropic", instructions } });
        return createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      };
      const one = await compileWith("First version.");
      const two = await compileWith("Second version, quite different.");
      expect(two.restartHash).toBe(one.restartHash);
      expect(two.filesHash).toBe(one.filesHash);
    });
  });

  describe("instructions bundle files", () => {
    const bundle = {
      files: [
        { path: "HEARTBEAT.md", content: "# Heartbeat\n" },
        { path: "SOUL.md", content: "# Soul\n" },
        { path: "docs/style.md", content: "# Style\n" },
      ],
      warnings: [] as string[],
    };

    it("places the bundle's files into the workspace under their relative paths, and no AGENTS.md", async () => {
      const board = fakeBoard({
        async loadInstructions() {
          return bundle;
        },
      });
      const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      const workspacePaths = profile.files.map((file) => file.path).filter((path) => path.startsWith("workspace/"));
      expect(workspacePaths.sort()).toEqual([
        "workspace/HEARTBEAT.md",
        "workspace/SOUL.md",
        "workspace/docs/style.md",
      ]);
      expect(fileContent(profile, "workspace/HEARTBEAT.md")).toBe("# Heartbeat\n");
      expect(fileContent(profile, "workspace/docs/style.md")).toBe("# Style\n");
    });

    it("drops a file the gateway would load as project context, with a warning, and keeps the rest", async () => {
      const board = fakeBoard({
        async loadInstructions() {
          return {
            files: [
              { path: "CLAUDE.md", content: "# Impostor\n" },
              { path: "docs/AGENTS.md", content: "# Impostor\n" },
              { path: "SOUL.md", content: "# Soul\n" },
            ],
            warnings: [],
          };
        },
      });
      const reported: string[][] = [];
      const profile = await createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (_botKey, warnings) => {
          reported.push([...warnings]);
        },
      })("agent-a", "agent-a");
      expect(profile.files.map((file) => file.path).filter((path) => path.startsWith("workspace/"))).toEqual(["workspace/SOUL.md"]);
      expect(reported.flat().filter((warning) => warning.includes("project context"))).toHaveLength(2);
    });

    it("treats an edit of a sibling as a files-class change: applied without a restart", async () => {
      let files = bundle.files;
      const board = fakeBoard({
        async loadInstructions() {
          return { ...bundle, files };
        },
      });
      const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
      const before = await compile("agent-a", "agent-a");
      files = files.map((file) => (file.path === "SOUL.md" ? { ...file, content: "# Soul, edited\n" } : file));
      const after = await compile("agent-a", "agent-a");
      expect(after.restartHash).toBe(before.restartHash);
      expect(after.filesHash).not.toBe(before.filesHash);
      expect(classifyProfileChange({ restartHash: before.restartHash, filesHash: before.filesHash }, after)).toBe("files");
    });

    it("counts a removed sibling as a change too, and an unchanged bundle as none", async () => {
      let files = bundle.files;
      const board = fakeBoard({
        async loadInstructions() {
          return { ...bundle, files };
        },
      });
      const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
      const before = await compile("agent-a", "agent-a");
      const same = await compile("agent-a", "agent-a");
      // The applied state comes from an apply of that same profile, so it reports the
      // concurrency limit the profile carries (myrmidon(CONCURRENCY-SYNC)).
      const applied = { restartHash: before.restartHash, filesHash: before.filesHash, maxConcurrentRuns: before.maxConcurrentRuns };
      expect(classifyProfileChange(applied, same)).toBe("none");
      files = files.filter((file) => file.path !== "docs/style.md");
      const fewer = await compile("agent-a", "agent-a");
      expect(classifyProfileChange(applied, fewer)).toBe("files");
    });
  });

  describe("failures", () => {
    it("fails before it looks anything up or creates any secret when the instance is unconfigured", async () => {
      const board = fakeBoard();
      const withoutHindsight: NodeJS.ProcessEnv = { ...INSTANCE_ENV, [BOT_HINDSIGHT_API_URL_ENV]: undefined };
      await expect(createBotProfileCompile(board.ports, { env: withoutHindsight })("agent-a", "agent-a")).rejects.toThrow(
        BOT_HINDSIGHT_API_URL_ENV,
      );
      expect(board.calls).toEqual([]);
      expect(board.secrets.size).toBe(1);
    });

    it("fails when the agent no longer exists", async () => {
      const board = fakeBoard();
      board.agent.current = null;
      const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
      await expect(compile("agent-a", "agent-a")).rejects.toThrow(BotProfileInputError);
      await expect(compile("agent-a", "agent-a")).rejects.toThrow("no longer exists");
      expect(board.calls).not.toContain("ensureApiServerKey");
    });

    it("fails, creating no secret, when the agent is not a hermes_gateway agent", async () => {
      const board = fakeBoard();
      board.agent.current = agentRecord({ adapterType: "hermes_local" });
      await expect(createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a")).rejects.toThrow(
        HERMES_GATEWAY_ADAPTER_TYPE,
      );
      expect(board.calls).toEqual(["loadAgent"]);
    });

    describe("a card whose provider goes through the LLM gateway", () => {
      const withoutLlm = (drop: string[]): NodeJS.ProcessEnv => {
        const env: NodeJS.ProcessEnv = { ...INSTANCE_ENV };
        for (const name of drop) delete env[name];
        return env;
      };

      it.each([
        ["custom", { provider: "custom", model: "some-model" }],
        ["a named custom provider", { provider: "custom:gateway", model: "some-model" }],
        ["auto", { provider: "auto", model: "some-model" }],
        ["no provider", { model: "some-model" }],
      ])("fails, creating nothing, naming the missing setting, for %s", async (_label, adapterConfig) => {
        for (const missing of [BOT_LLM_BASE_URL_ENV, BOT_LLM_API_KEY_ENV_ENV]) {
          const board = fakeBoard();
          board.agent.current = agentRecord({ adapterConfig });
          const compile = createBotProfileCompile(board.ports, { env: withoutLlm([missing]) });
          await expect(compile("agent-a", "agent-a")).rejects.toThrow(BotProfileInputError);
          await expect(compile("agent-a", "agent-a")).rejects.toThrow(missing);
          expect(board.calls).toEqual(["loadAgent", "loadAgent"]);
          expect(board.secrets.size).toBe(1);
        }
      });

      it("compiles a card with a native provider without either setting, and reads no gateway key", async () => {
        const board = fakeBoard();
        board.agent.current = agentRecord({ adapterConfig: { model: "some-model", provider: "gemini" } });
        const profile = await createBotProfileCompile(board.ports, {
          env: withoutLlm([BOT_LLM_BASE_URL_ENV, BOT_LLM_API_KEY_ENV_ENV]),
        })("agent-a", "agent-a");
        expect(profile.botKey).toBe("agent-a");
        expect(board.calls.filter((call) => call.startsWith("readCompanySecret"))).toEqual([]);
      });

      it("leaves a native-provider card alone even when the instance configures the gateway: no secret read, no address, no key", async () => {
        const board = fakeBoard();
        board.agent.current = agentRecord({
          adapterConfig: { model: "some-model", provider: "gemini", models: { fallbacks: ["other-model"] } },
        });
        const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
        // The gateway key's company secret is not read at all (a read would be the leak's first step).
        expect(board.calls.filter((call) => call.startsWith("readCompanySecret"))).toEqual([]);
        const config = fileContent(profile, "hermes/config.yaml");
        expect(config).toContain('provider: "gemini"');
        expect(config).not.toContain("base_url");
        expect(config).not.toContain("key_env");
        expect(config).not.toContain("api_key");
        expect(config).not.toContain("FLEET_LLM_API_KEY");
        const env = fileContent(profile, "hermes/.env");
        expect(env).not.toContain("FLEET_LLM_API_KEY");
        expect(env).not.toContain("fake-llm-key-0001");
        expect(profile.files.some((file) => file.content.includes("fake-llm-key-0001") || file.content.includes("example.com/llm"))).toBe(false);
      });

      it("still gives a gateway card the address and the key on the same instance", async () => {
        const board = fakeBoard();
        const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
        expect(fileContent(profile, "hermes/config.yaml")).toContain('base_url: "https://example.com/llm/v1"');
        expect(fileContent(profile, "hermes/.env")).toContain('FLEET_LLM_API_KEY="fake-llm-key-0001"');
      });
    });

    it("fails closed when the LLM key exists nowhere, naming the secret", async () => {
      const board = fakeBoard();
      board.secrets.delete("FLEET_LLM_API_KEY");
      await expect(createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a")).rejects.toThrow(
        "FLEET_LLM_API_KEY",
      );
    });

    it("propagates a failing port instead of compiling a partial profile", async () => {
      const board = fakeBoard({
        async loadInstructions() {
          throw new Error("instructions bundle unreadable");
        },
      });
      await expect(createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a")).rejects.toThrow(
        "instructions bundle unreadable",
      );
    });
  });

  describe("warnings", () => {
    const warningEnv = { HINT: { value: "has ${REFERENCE} in it", secret: false } };

    it("reports the port and compiler warnings once, not on every tick", async () => {
      const board = fakeBoard({
        async resolveCardEnv() {
          return { env: warningEnv, warnings: ["env.OTHER: dropped, secret is missing"] };
        },
      });
      const reported: Array<{ botKey: string; warnings: readonly string[] }> = [];
      const compile = createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (botKey, warnings) => {
          reported.push({ botKey, warnings });
        },
      });
      await compile("agent-a", "agent-a");
      await compile("agent-a", "agent-a");
      await compile("agent-a", "agent-a");
      expect(reported).toHaveLength(1);
      expect(reported[0]?.botKey).toBe("agent-a");
      expect(reported[0]?.warnings[0]).toBe("env.OTHER: dropped, secret is missing");
      expect(reported[0]?.warnings.length).toBeGreaterThan(1);
    });

    it("reports again when the set of warnings changes", async () => {
      let warnings = ["env.OTHER: dropped"];
      const board = fakeBoard({
        async resolveCardEnv() {
          return { env: {}, warnings };
        },
      });
      const reported: string[][] = [];
      const compile = createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (_botKey, list) => {
          reported.push([...list]);
        },
      });
      await compile("agent-a", "agent-a");
      warnings = ["env.OTHER: dropped", "env.THIRD: dropped"];
      await compile("agent-a", "agent-a");
      await compile("agent-a", "agent-a");
      expect(reported).toEqual([["env.OTHER: dropped"], ["env.OTHER: dropped", "env.THIRD: dropped"]]);
    });

    it("tracks warnings per bot", async () => {
      const board = fakeBoard({
        async resolveCardEnv() {
          return { env: {}, warnings: ["env.OTHER: dropped"] };
        },
      });
      const reported: string[] = [];
      const compile = createBotProfileCompile(board.ports, {
        env: INSTANCE_ENV,
        onWarnings: (botKey) => {
          reported.push(botKey);
        },
      });
      await compile("agent-a", "agent-a");
      await compile("agent-a", "agent-a");
      await compile("agent-b", "agent-b");
      expect(reported).toEqual(["agent-a", "agent-b"]);
    });

    it("says nothing when there is nothing to say, and never fails a compile over a broken sink", async () => {
      const quiet = fakeBoard();
      const reported: string[] = [];
      await createBotProfileCompile(quiet.ports, {
        env: INSTANCE_ENV,
        onWarnings: (botKey) => {
          reported.push(botKey);
        },
      })("agent-a", "agent-a");
      expect(reported).toEqual([]);

      const noisy = fakeBoard({
        async resolveCardEnv() {
          return { env: {}, warnings: ["env.OTHER: dropped"] };
        },
      });
      const profile = await createBotProfileCompile(noisy.ports, {
        env: INSTANCE_ENV,
        onWarnings: () => {
          throw new Error("sink is down");
        },
      })("agent-a", "agent-a");
      expect(profile.botKey).toBe("agent-a");
    });
  });

  // myrmidon(BOT-RUNTIME-TUNING-B): the MYRMIDON_BOT_* instance settings that
  // tune a bot's compression token cap, model context window and auxiliary
  // models, read on every compile call and written into config.yaml.
  describe("myrmidon(BOT-RUNTIME-TUNING-B) instance tuning settings", () => {
    it("writes compression.threshold_tokens from MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS", async () => {
      const board = fakeBoard();
      const profile = await createBotProfileCompile(board.ports, {
        env: { ...INSTANCE_ENV, [BOT_COMPRESSION_THRESHOLD_TOKENS_ENV]: "100000" },
      })("agent-a", "agent-a");
      expect(fileContent(profile, "hermes/config.yaml")).toContain("threshold_tokens: 100000");
    });

    it("writes the company default 100k for threshold_tokens when the setting is unset", async () => {
      // myrmidon(BOT-RUNTIME-TUNING-A): the setting is an override of the
      // company default now — an instance that configures nothing still caps
      // its bots at 100k instead of letting a large-window model grow a
      // session to half the window before compacting.
      const board = fakeBoard();
      const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      expect(fileContent(profile, "hermes/config.yaml")).toContain("threshold_tokens: 100000");
    });

    it("an explicit 0 in the setting leaves threshold_tokens out (Hermes's own default)", async () => {
      const board = fakeBoard();
      const profile = await createBotProfileCompile(board.ports, {
        env: { ...INSTANCE_ENV, [BOT_COMPRESSION_THRESHOLD_TOKENS_ENV]: "0" },
      })("agent-a", "agent-a");
      expect(fileContent(profile, "hermes/config.yaml")).not.toContain("threshold_tokens");
    });

    it("writes the card's own threshold over the company default", async () => {
      const board = fakeBoard({
        async loadAgent() {
          return agentRecord({
            adapterConfig: { model: "some-model", provider: "custom", models: { compressionThresholdTokens: 120_000 } },
          });
        },
      });
      const profile = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
      const yaml = fileContent(profile, "hermes/config.yaml");
      expect(yaml).toContain("threshold_tokens: 120000");
      expect(yaml).not.toContain("threshold_tokens: 100000");
    });

    it("writes model.context_length from MYRMIDON_BOT_MODEL_CONTEXT_LENGTH for the card's model", async () => {
      const board = fakeBoard({
        async loadAgent() {
          return agentRecord({ adapterConfig: { model: "model-a", provider: "custom" } });
        },
      });
      const profile = await createBotProfileCompile(board.ports, {
        env: { ...INSTANCE_ENV, [BOT_MODEL_CONTEXT_LENGTH_ENV]: "model-a=131072" },
      })("agent-a", "agent-a");
      expect(fileContent(profile, "hermes/config.yaml")).toContain("context_length: 131072");
    });

    it("writes the auxiliary models from MYRMIDON_BOT_AUX_* when the card sets none", async () => {
      const board = fakeBoard();
      const profile = await createBotProfileCompile(board.ports, {
        env: {
          ...INSTANCE_ENV,
          [BOT_AUX_TITLE_MODEL_ENV]: "model-title",
          [BOT_AUX_COMPRESSION_MODEL_ENV]: "model-summary",
        },
      })("agent-a", "agent-a");
      const yaml = fileContent(profile, "hermes/config.yaml");
      expect(yaml).toContain('auxiliary:\n  compression:\n    model: "model-summary"\n  title_generation:\n    model: "model-title"');
    });

    it("caps the auxiliary chain with MYRMIDON_BOT_AUX_FALLBACK_MODELS", async () => {
      const board = fakeBoard();
      const profile = await createBotProfileCompile(board.ports, {
        env: {
          ...INSTANCE_ENV,
          [BOT_AUX_TITLE_MODEL_ENV]: "model-title",
          [BOT_AUX_FALLBACK_MODELS_ENV]: "model-cheap,model-cheaper",
        },
      })("agent-a", "agent-a");
      const yaml = fileContent(profile, "hermes/config.yaml");
      // The card names `provider: custom` and INSTANCE_ENV carries the gateway
      // endpoint, so each ceiling entry spells both out (Hermes resolves a
      // fallback entry on its own and inherits neither from `model`).
      expect(yaml).toContain('model: "model-title"');
      expect(yaml).toContain(
        'fallback_chain:\n    - base_url: "https://example.com/llm/v1"\n      key_env: "FLEET_LLM_API_KEY"\n' +
          '      model: "model-cheap"\n      provider: "custom"\n' +
          '    - base_url: "https://example.com/llm/v1"\n      key_env: "FLEET_LLM_API_KEY"\n' +
          '      model: "model-cheaper"\n      provider: "custom"',
      );
    });

    it("the card's models block wins over the instance settings", async () => {
      const board = fakeBoard({
        async loadAgent() {
          return agentRecord({
            adapterConfig: {
              model: "model-a",
              provider: "custom",
              models: { titleGeneration: "model-card-title", contextLength: 262_144 },
            },
          });
        },
      });
      const profile = await createBotProfileCompile(board.ports, {
        env: {
          ...INSTANCE_ENV,
          [BOT_MODEL_CONTEXT_LENGTH_ENV]: "model-a=131072",
          [BOT_AUX_TITLE_MODEL_ENV]: "model-instance-title",
        },
      })("agent-a", "agent-a");
      const yaml = fileContent(profile, "hermes/config.yaml");
      expect(yaml).toContain("context_length: 262144");
      expect(yaml).toContain('model: "model-card-title"');
      expect(yaml).not.toContain('model: "model-instance-title"');
    });

    it("a settings parse error is reported as a profile warning, not a compile failure", async () => {
      const reported: string[][] = [];
      const board = fakeBoard();
      await createBotProfileCompile(board.ports, {
        env: {
          ...INSTANCE_ENV,
          [BOT_COMPRESSION_THRESHOLD_TOKENS_ENV]: "100k",
          [BOT_MODEL_CONTEXT_LENGTH_ENV]: "model-a=131072,broken",
        },
        onWarnings: (_botKey, list) => {
          reported.push([...list]);
        },
      })("agent-a", "agent-a");
      const flat = reported.flat();
      expect(flat.some((warning) => warning.includes(BOT_COMPRESSION_THRESHOLD_TOKENS_ENV))).toBe(true);
      expect(flat.some((warning) => warning.includes(BOT_MODEL_CONTEXT_LENGTH_ENV))).toBe(true);
    });

    it("a changed setting takes effect on the next compile tick and restarts the bot", async () => {
      const board = fakeBoard();
      const env: NodeJS.ProcessEnv = { ...INSTANCE_ENV };
      const compile = createBotProfileCompile(board.ports, { env });
      const before = await compile("agent-a", "agent-a");
      env[BOT_COMPRESSION_THRESHOLD_TOKENS_ENV] = "150000";
      const after = await compile("agent-a", "agent-a");
      expect(fileContent(after, "hermes/config.yaml")).toContain("threshold_tokens: 150000");
      expect(after.restartHash).not.toBe(before.restartHash);
    });
  });
});

// myrmidon(BOT-LSP-DEFAULTS): the agent's role and the instance policy (a port
// re-read per tick) decide the bot's language-server block.
describe("myrmidon(BOT-LSP-DEFAULTS) createBotProfileCompile — language servers", () => {
  it("compiles the limited mode for a coding role and off for another", async () => {
    const board = fakeBoard();
    board.agent.current = agentRecord({ role: "engineer" });
    const engineer = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
    expect(fileContent(engineer, "hermes/config.yaml")).toContain('useSyntaxServer: "never"');

    board.agent.current = agentRecord({ role: "general" });
    const general = await createBotProfileCompile(board.ports, { env: INSTANCE_ENV })("agent-a", "agent-a");
    expect(fileContent(general, "hermes/config.yaml")).toContain("lsp:\n  enabled: false");
  });

  it("re-reads the policy per compile: a change restarts the bot with the new block", async () => {
    let policy: { codingRoles?: string[] } = {};
    const board = fakeBoard({
      async botLsp() {
        return policy;
      },
    });
    board.agent.current = agentRecord({ role: "dev-lead" });
    const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
    const before = await compile("agent-a", "agent-a");
    expect(fileContent(before, "hermes/config.yaml")).toContain("lsp:\n  enabled: false");

    policy = { codingRoles: ["dev-lead"] };
    const after = await compile("agent-a", "agent-a");
    expect(fileContent(after, "hermes/config.yaml")).toContain("idle_timeout: 120");
    expect(after.restartHash).not.toBe(before.restartHash);
  });
});

// myrmidon(PERF-DIET-G): a sweep compiles every bot of one tick through ONE
// pass. The company- and instance-scoped reads behind a profile were paid per
// bot (and pnpmSettings twice per bot); inside a pass they are paid once for the
// whole sweep, and the next pass reads live values again.
describe("myrmidon(PERF-DIET-G) createBotProfileCompile — one read per pass", () => {
  const BOTS = ["agent-a", "agent-b", "agent-c"];

  /** A board whose instance-scoped ports count their calls; every bot is its own
   *  row, so a read that is still per bot stays visible. */
  function countedBoard() {
    const calls: string[] = [];
    const rows = new Map(BOTS.map((id) => [id, agentRecord({ id, name: `Agent ${id}` })]));
    const ports: BotProfilePorts = {
      async loadAgent(agentId) {
        calls.push(`loadAgent:${agentId}`);
        return rows.get(agentId) ?? null;
      },
      async resolveCardEnv() {
        return { env: {}, warnings: [] };
      },
      async readCompanySecret(_companyId, name) {
        calls.push(`readCompanySecret:${name}`);
        return name === "FLEET_LLM_API_KEY" ? "fake-llm-key-0001" : null;
      },
      async ensureApiServerKey(record) {
        return { value: `fake-api-server-key-${record.id}`, secretId: `secret-${record.id}` };
      },
      async ensureAgentApiKey(record) {
        return { value: `fake-paperclip-api-key-${record.id}` };
      },
      async loadSkills() {
        calls.push("loadSkills");
        return { skills: {}, warnings: [] };
      },
      async loadInstructions() {
        return { files: [], warnings: [] };
      },
      async listMcpServers() {
        return [];
      },
      async instanceDefaults() {
        calls.push("instanceDefaults");
        return {};
      },
      async parallelHelpers() {
        calls.push("parallelHelpers");
        return undefined;
      },
      async botLsp() {
        calls.push("botLsp");
        return undefined;
      },
      async sharedPackageCachePath() {
        calls.push("sharedPackageCachePath");
        return "/cache/pnpm";
      },
      async pnpmSettings() {
        calls.push("pnpmSettings");
        return { storeDir: "/cache/pnpm/store", importMethod: "hardlink" };
      },
      // myrmidon(1.6.5-BOT-DISK-UV-A): the uv pair is read per tick from the same row.
      async uvSettings() {
        calls.push("uvSettings");
        return { cacheDir: "/cache/uv", linkMode: "clone" };
      },
      async cloneIdleTtlSec() {
        calls.push("cloneIdleTtlSec");
        return 600;
      },
      async scopeLayout() {
        // Every bot of the fixture is a member of a shared scope instance: the
        // layout is per bot (it is that bot's own applied scope), and it is what
        // makes compile read the package-cache settings a second time.
        calls.push("scopeLayout");
        return { kind: "shared" as const, dirName: "company-1-group-team-a" };
      },
    };
    return { ports, calls, count: (name: string) => calls.filter((call) => call === name).length };
  }

  it("pays the instance-scoped reads once per bot when no pass is shared", async () => {
    const board = countedBoard();
    const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });
    for (const id of BOTS) await compile(id, id);

    expect(board.count("instanceDefaults")).toBe(3);
    expect(board.count("parallelHelpers")).toBe(3);
    expect(board.count("botLsp")).toBe(3);
    expect(board.count("sharedPackageCachePath")).toBe(3);
    expect(board.count("cloneIdleTtlSec")).toBe(3);
    // Once per bot, not twice: the cache lives for one call even without a pass,
    // which settles the second read of the package-cache settings inside a compile
    // (the scope instance's store path). On the code path this replaces, the same
    // three bots paid six of these.
    expect(board.count("pnpmSettings")).toBe(3);
    // myrmidon(1.6.5-BOT-DISK-UV-A): the uv pair is cached the same way.
    expect(board.count("uvSettings")).toBe(3);
    // The applied scope is the bot's own and is never shared.
    expect(board.count("scopeLayout")).toBe(3);
    expect(board.calls.filter((call) => call.startsWith("loadAgent:"))).toHaveLength(3);
  });

  it("pays them once for a sweep of three bots, and reads again on the next pass", async () => {
    const board = countedBoard();
    const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });

    const pass = compile.beginPass();
    const profiles = [];
    for (const id of BOTS) profiles.push(await compile(id, id, pass));

    for (const name of [
      "instanceDefaults",
      "parallelHelpers",
      "botLsp",
      "sharedPackageCachePath",
      "cloneIdleTtlSec",
      "pnpmSettings",
      // myrmidon(1.6.5-BOT-DISK-UV-A): the uv pair shares the pass cache, like pnpm.
      "uvSettings",
    ]) {
      expect(board.count(name), name).toBe(1);
    }
    // The skills port itself is still asked once per bot: what it shares is inside
    // it, and profile-skills.myrmidon.test.ts counts exactly that.
    expect(board.count("loadSkills")).toBe(3);
    // Same for the bot's own applied scope layout.
    expect(board.count("scopeLayout")).toBe(3);
    // What is genuinely per-bot stays per bot: one row per agent, one card env,
    // one pair of keys.
    expect(board.calls.filter((call) => call.startsWith("loadAgent:"))).toEqual([
      "loadAgent:agent-a",
      "loadAgent:agent-b",
      "loadAgent:agent-c",
    ]);
    expect(profiles.map((profile) => profile.botKey)).toEqual(BOTS);

    // The pass is the invalidation: the same compile object reads live values
    // again as soon as it is given a fresh one, so a settings change lands on the
    // next sweep.
    compile.endPass(pass);
    expect(pass.ended).toBe(true);
    const next = compile.beginPass();
    for (const id of BOTS) await compile(id, id, next);

    expect(board.count("instanceDefaults")).toBe(2);
    expect(board.count("pnpmSettings")).toBe(2);
  });

  it("caches inside its own call only when it is given no pass", async () => {
    const board = countedBoard();
    const compile = createBotProfileCompile(board.ports, { env: INSTANCE_ENV });

    // One bot, one call: the double pnpm read inside that call is settled even
    // without a sweep (the three bots above pay three instanceDefaults reads,
    // not six pnpmSettings ones).
    await compile("agent-a", "agent-a");

    expect(board.count("instanceDefaults")).toBe(1);
    expect(board.count("pnpmSettings")).toBe(1);
  });
});

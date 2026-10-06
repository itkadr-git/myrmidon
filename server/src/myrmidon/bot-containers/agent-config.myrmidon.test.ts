import { describe, expect, it } from "vitest";
import {
  BOT_CONTAINERS_ENV,
  CONTAINER_GROUP_UNSUPPORTED_REASON,
  botContainerSpec,
  botKeyForAgent,
  BOT_CONTAINER_DEFAULTS,
  botContainerCardSaveProblem,
  classifyBotImageTracking,
  isBotContainersEnabled,
  readBotContainerAgentConfig,
} from "./agent-config.js";

describe("isBotContainersEnabled", () => {
  it("is off unless explicitly enabled", () => {
    expect(isBotContainersEnabled({})).toBe(false);
    expect(isBotContainersEnabled({ [BOT_CONTAINERS_ENV]: "false" })).toBe(false);
    expect(isBotContainersEnabled({ [BOT_CONTAINERS_ENV]: "0" })).toBe(false);
  });

  it.each(["1", "true", "TRUE", "yes", "on"])("accepts %j", (value) => {
    expect(isBotContainersEnabled({ [BOT_CONTAINERS_ENV]: value })).toBe(true);
  });
});

const VALID_CONTAINER_CONFIG = {
  enabled: true,
  image: "myrmidon-hermes:1.1.0",
  memoryMb: 1536,
  cpus: 1,
  pidsLimit: 256,
};

describe("readBotContainerAgentConfig", () => {
  it("is not applicable to any adapter type other than hermes_gateway", () => {
    const result = readBotContainerAgentConfig("process", { container: VALID_CONTAINER_CONFIG });
    expect(result.ok).toBe(false);
  });

  it("is not applicable when container.enabled is not true", () => {
    expect(readBotContainerAgentConfig("hermes_gateway", {}).ok).toBe(false);
    expect(
      readBotContainerAgentConfig("hermes_gateway", { container: { ...VALID_CONTAINER_CONFIG, enabled: false } }).ok,
    ).toBe(false);
  });

  it("parses a valid config for a hermes_gateway agent", () => {
    const result = readBotContainerAgentConfig("hermes_gateway", { container: VALID_CONTAINER_CONFIG });
    expect(result).toEqual({
      ok: true,
      config: { image: "myrmidon-hermes:1.1.0", memoryMb: 1536, cpus: 1, pidsLimit: 256, extraMounts: [], hasSharedMountAccess: false },
    });
  });

  it.each(["team-b", "Not-Lowercase", "", 42])(
    "refuses a shared container.group (%j) as not applicable instead of reconciling it per agent",
    (group) => {
      // A shared container reconciled from each member's own card would be
      // recreated/rewritten by every member and restarted under the others' runs.
      const result = readBotContainerAgentConfig("hermes_gateway", { container: { ...VALID_CONTAINER_CONFIG, group } });
      expect(result).toEqual({ ok: false, reason: CONTAINER_GROUP_UNSUPPORTED_REASON });
    },
  );

  it("treats an explicit null group like no group", () => {
    expect(readBotContainerAgentConfig("hermes_gateway", { container: { ...VALID_CONTAINER_CONFIG, group: null } }).ok).toBe(true);
  });

  it.each([
    { ...VALID_CONTAINER_CONFIG, image: "" },
    { ...VALID_CONTAINER_CONFIG, image: 123 },
    { ...VALID_CONTAINER_CONFIG, memoryMb: 0 },
    { ...VALID_CONTAINER_CONFIG, memoryMb: "1536" },
    { ...VALID_CONTAINER_CONFIG, cpus: -1 },
    { ...VALID_CONTAINER_CONFIG, pidsLimit: 1.5 },
  ])("rejects an invalid container block: %j", (container) => {
    const result = readBotContainerAgentConfig("hermes_gateway", { container });
    expect(result.ok).toBe(false);
  });
});

describe("botKeyForAgent / botContainerSpec", () => {
  it("keys every bot by its own agent id", () => {
    expect(botKeyForAgent("agent-a")).toBe("agent-a");
    expect(botKeyForAgent("3adb3ce4-40a4-4b1e-9c2a-000000000001")).toBe("3adb3ce4-40a4-4b1e-9c2a-000000000001");
  });

  it("returns null for an id that cannot be a bot key", () => {
    expect(botKeyForAgent("Agent_A")).toBeNull();
    expect(botKeyForAgent("../x")).toBeNull();
  });

  it("builds a spec that carries the driver's network through unchanged", () => {
    const spec = botContainerSpec(
      "agent-a",
      { image: "myrmidon-hermes:1.1.0", memoryMb: 1536, cpus: 1, pidsLimit: 256, extraMounts: [], hasSharedMountAccess: false },
      "myrmidon-bots",
    );
    expect(spec).toEqual({
      botKey: "agent-a",
      image: "myrmidon-hermes:1.1.0",
      memoryMb: 1536,
      cpus: 1,
      pidsLimit: 256,
      network: "myrmidon-bots",
      extraMounts: [],
      hasSharedMountAccess: false,
    });
  });

  it("carries the card's extra mounts into the spec", () => {
    const spec = botContainerSpec(
      "agent-a",
      {
        image: "myrmidon-hermes:1.1.0",
        memoryMb: 1536,
        cpus: 1,
        pidsLimit: 256,
        extraMounts: [{ source: "/srv/shared/sources", containerPath: "/srv/shared/sources", readOnly: true }],
        hasSharedMountAccess: false,
      },
      "myrmidon-bots",
    );
    expect(spec.extraMounts).toEqual([
      { source: "/srv/shared/sources", containerPath: "/srv/shared/sources", readOnly: true },
    ]);
  });
});

describe("readBotContainerAgentConfig: container.extraMounts", () => {
  function configWith(extraMounts: unknown) {
    return { container: { ...VALID_CONTAINER_CONFIG, extraMounts } };
  }

  it("reads the allowed entry shape and defaults readOnly to true", () => {
    const result = readBotContainerAgentConfig("hermes_gateway", configWith([{ source: "/srv/shared/sources", path: "/srv/shared/sources" }]));
    expect(result).toEqual({
      ok: true,
      config: {
        image: "myrmidon-hermes:1.1.0",
        memoryMb: 1536,
        cpus: 1,
        pidsLimit: 256,
        extraMounts: [{ source: "/srv/shared/sources", containerPath: "/srv/shared/sources", readOnly: true }],
        hasSharedMountAccess: false,
      },
    });
  });

  it("accepts an explicit readOnly of true and treats a missing list as no extra mounts", () => {
    const explicit = readBotContainerAgentConfig(
      "hermes_gateway",
      configWith([{ source: "/srv/shared/tools", path: "/opt/tools", readOnly: true }]),
    );
    expect(explicit.ok && explicit.config.extraMounts).toEqual([
      { source: "/srv/shared/tools", containerPath: "/opt/tools", readOnly: true },
    ]);
    expect(readBotContainerAgentConfig("hermes_gateway", { container: VALID_CONTAINER_CONFIG }).ok).toBe(true);
  });

  it("refuses a writable extra mount: a shared directory is only mounted read-only", () => {
    const result = readBotContainerAgentConfig(
      "hermes_gateway",
      configWith([{ source: "/srv/shared/sources", path: "/srv/shared/sources", readOnly: false }]),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("readOnly=false");
  });

  it.each([
    ["not-an-array", { source: "/srv/shared/sources", path: "/x" }],
    ["entry not an object", [42]],
    ["missing source", [{ path: "/srv/shared/sources" }]],
    ["blank source", [{ source: "  ", path: "/srv/shared/sources" }]],
    ["relative path", [{ source: "/srv/shared/sources", path: "srv/shared" }]],
    ["readOnly not a boolean", [{ source: "/srv/shared/sources", path: "/x", readOnly: "yes" }]],
  ])("refuses a malformed list: %s", (_name, extraMounts) => {
    const result = readBotContainerAgentConfig("hermes_gateway", configWith(extraMounts));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("container.extraMounts");
  });
});

describe("botContainerCardSaveProblem (1.6.4-BOT-CONTAINER-CARD)", () => {
  it("has the defaults the form and the migration use", () => {
    expect(BOT_CONTAINER_DEFAULTS).toEqual({ memoryMb: 2048, cpus: 1, pidsLimit: 512 });
  });

  it("accepts a card without a container block and any other adapter", () => {
    expect(botContainerCardSaveProblem("hermes_gateway", {})).toBeNull();
    expect(botContainerCardSaveProblem("hermes_gateway", { container: null })).toBeNull();
    expect(botContainerCardSaveProblem("process", { container: { image: "x" } })).toBeNull();
  });

  it("accepts a complete enabled block and any explicitly disabled one", () => {
    expect(botContainerCardSaveProblem("hermes_gateway", { container: VALID_CONTAINER_CONFIG })).toBeNull();
    expect(botContainerCardSaveProblem("hermes_gateway", { container: { enabled: false, image: "x" } })).toBeNull();
  });

  it("refuses a block without `enabled`, naming the field", () => {
    const problem = botContainerCardSaveProblem("hermes_gateway", { container: { image: "x" } });
    expect(problem).toContain("container.enabled must be true or false");
    expect(botContainerCardSaveProblem("hermes_gateway", { container: { enabled: "yes", image: "x" } })).toContain("enabled");
    expect(botContainerCardSaveProblem("hermes_gateway", { container: "yes" })).toContain("must be an object");
  });

  it("refuses an enabled block without limits, naming each and the defaults", () => {
    const problem = botContainerCardSaveProblem("hermes_gateway", { container: { enabled: true, image: "x", cpus: 1 } });
    expect(problem).toContain("memoryMb");
    expect(problem).toContain("pidsLimit");
    expect(problem).not.toContain("cpus (");
    expect(problem).toContain("defaults are memoryMb 2048, cpus 1, pidsLimit 512");
    expect(
      botContainerCardSaveProblem("hermes_gateway", { container: { ...VALID_CONTAINER_CONFIG, memoryMb: 0 } }),
    ).toContain("memoryMb");
    expect(
      botContainerCardSaveProblem("hermes_gateway", { container: { ...VALID_CONTAINER_CONFIG, pidsLimit: 1.5 } }),
    ).toContain("pidsLimit");
  });
});

describe("classifyBotImageTracking (1.6.4-BOT-CONTAINER-CARD)", () => {
  const digest = (repo: string) => `ghcr.io/example/${repo}@sha256:${"c".repeat(64)}`;

  it("tracks the release for a digest of each of the three bot repositories", () => {
    for (const repo of ["myrmidon-hermes", "myrmidon-hermes-dev", "myrmidon-hermes-node"]) {
      const image = digest(repo);
      expect(classifyBotImageTracking("hermes_gateway", { container: { ...VALID_CONTAINER_CONFIG, image } })).toEqual({
        category: "tracks_release",
        image,
      });
    }
  });

  it("is pinned for a tag, another repository or a short digest, and says which image", () => {
    for (const image of ["myrmidon-hermes:1.1.0", digest("something-else"), "ghcr.io/example/myrmidon-hermes@sha256:abc"]) {
      expect(classifyBotImageTracking("hermes_gateway", { container: { ...VALID_CONTAINER_CONFIG, image } })).toMatchObject({
        category: "pinned",
        image,
      });
    }
  });

  it("is not applicable, with the reason, when the card is not a managed container", () => {
    expect(classifyBotImageTracking("process", { container: VALID_CONTAINER_CONFIG })).toMatchObject({ category: "not_applicable", reason: expect.stringContaining("not hermes_gateway") });
    expect(classifyBotImageTracking("hermes_gateway", {})).toMatchObject({ category: "not_applicable", reason: "adapterConfig.container is not set" });
    expect(classifyBotImageTracking("hermes_gateway", { container: { image: digest("myrmidon-hermes") } })).toEqual({
      category: "not_applicable",
      image: null,
      reason: "adapterConfig.container.enabled is not true",
    });
    expect(classifyBotImageTracking("hermes_gateway", { container: { enabled: true, image: digest("myrmidon-hermes") } })).toMatchObject({
      category: "not_applicable",
      reason: "container.memoryMb must be a positive number",
    });
  });
});
describe("readBotContainerAgentConfig: shared mount access", () => {
  function config() {
    return { container: { ...VALID_CONTAINER_CONFIG } };
  }
  it("denies shared mount access by default (no instance settings)", () => {
    const result = readBotContainerAgentConfig("hermes_gateway", config());
    expect(result.ok && result.config.hasSharedMountAccess).toBe(false);
  });
  it("denies access when the instance settings disable the shared mount", () => {
    const result = readBotContainerAgentConfig("hermes_gateway", config(), { enabled: false });
    expect(result.ok && result.config.hasSharedMountAccess).toBe(false);
  });
  it("grants access to every bot when the allowlist is empty", () => {
    const result = readBotContainerAgentConfig("hermes_gateway", config(), { enabled: true, allowedBots: [] });
    expect(result.ok && result.config.hasSharedMountAccess).toBe(true);
  });
  it("grants access only to allowlisted bots (per-bot control)", () => {
    const settings = { enabled: true, allowedBots: ["bot-a"] };
    const allowed = readBotContainerAgentConfig("hermes_gateway", config(), settings, "bot-a");
    expect(allowed.ok && allowed.config.hasSharedMountAccess).toBe(true);
    const denied = readBotContainerAgentConfig("hermes_gateway", config(), settings, "bot-b");
    expect(denied.ok && denied.config.hasSharedMountAccess).toBe(false);
  });
});

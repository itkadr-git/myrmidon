import { describe, expect, it } from "vitest";
import type { BotExtraMount } from "./driver.js";
import {
  assertBotRuntimeContract,
  botVolumeLayout,
  BOT_KEY_PATTERN,
  BOT_LABEL_KEYS,
  BOT_RUNTIME_CONTRACT_LABEL,
  BOT_RUNTIME_SCOPE_LABEL,
  BotContainerTemplateError,
  buildBinds,
  buildLabels,
  containerNameFor,
  declaredBotRuntimeContract,
  devbuildContainerEnv,
  devbuildKeyMount,
  helperContainerNameFor,
  isDevBuildImage,
  isImageAllowed,
  isUnderManagedDir,
  mountRootSegment,
  parseDevbuildSettings,
  parseImageAllowlist,
  parseMountSourceAllowlist,
  replacementContainerNameFor,
  resolveProfileFileTarget,
  validateBotKey,
  validateExtraMounts,
} from "./template.js";
import type { CompiledProfileFile } from "./types.js";

describe("validateBotKey / containerNameFor", () => {
  it("accepts lowercase alphanumeric-with-hyphens keys, including uuids", () => {
    expect(() => validateBotKey("agent-a")).not.toThrow();
    expect(() => validateBotKey("3adb3ce4-40a4-4b1e-9c2a-000000000001")).not.toThrow();
    expect(containerNameFor("agent-a")).toBe("myrmidon-bot-agent-a");
  });

  it.each(["Agent-A", "agent_a", "agent.a", "-agent", "agent-", "agent/a", "", "agent a"])(
    "rejects %j",
    (botKey) => {
      expect(() => validateBotKey(botKey)).toThrow(BotContainerTemplateError);
    },
  );
});

describe("helperContainerNameFor / replacementContainerNameFor", () => {
  it("can never equal another bot's own container name", () => {
    // "myrmidon-bot-<key>-helper" would collide with bot key "<key>-helper"; a
    // "." cannot appear in a bot key, so these names are outside that space.
    expect(helperContainerNameFor("agent-a")).toBe("myrmidon-bot-agent-a.helper");
    expect(replacementContainerNameFor("agent-a")).toBe("myrmidon-bot-agent-a.next");
    for (const name of [helperContainerNameFor("agent-a"), replacementContainerNameFor("agent-a")]) {
      const suffix = name.slice("myrmidon-bot-".length);
      expect(BOT_KEY_PATTERN.test(suffix)).toBe(false);
    }
  });

  it("rejects an invalid bot key", () => {
    expect(() => helperContainerNameFor("../x")).toThrow(BotContainerTemplateError);
    expect(() => replacementContainerNameFor("A")).toThrow(BotContainerTemplateError);
  });
});

describe("parseImageAllowlist / isImageAllowed", () => {
  it("parses a comma-separated list, trimming entries and dropping empties", () => {
    expect(parseImageAllowlist(" myrmidon-hermes:1.1.0 , myrmidon-hermes:* ,,")).toEqual([
      "myrmidon-hermes:1.1.0",
      "myrmidon-hermes:*",
    ]);
    expect(parseImageAllowlist(undefined)).toEqual([]);
  });

  it("allows only images that match one of the allowlist globs", () => {
    const allowlist = parseImageAllowlist("myrmidon-hermes:*,registry.example.com/myrmidon/*:1.1.*");
    expect(isImageAllowed("myrmidon-hermes:1.1.0", allowlist)).toBe(true);
    expect(isImageAllowed("myrmidon-hermes:1.2.0-rc1", allowlist)).toBe(true);
    expect(isImageAllowed("registry.example.com/myrmidon/hermes:1.1.5", allowlist)).toBe(true);
    expect(isImageAllowed("evil/other-image:latest", allowlist)).toBe(false);
    expect(isImageAllowed("myrmidon-hermes", allowlist)).toBe(false); // no tag: no glob matches
  });

  it("never lets '*' cross a '/' path segment", () => {
    const allowlist = parseImageAllowlist("myrmidon/*:1.1.0");
    // A caller cannot use the wildcard to smuggle in an extra registry/namespace segment.
    expect(isImageAllowed("myrmidon/evil/hermes:1.1.0", allowlist)).toBe(false);
    expect(isImageAllowed("myrmidon/hermes:1.1.0", allowlist)).toBe(true);
  });

  it("treats regex-special characters in a glob literally", () => {
    const allowlist = parseImageAllowlist("myrmidon-hermes:1.1.0");
    expect(isImageAllowed("myrmidon-hermes:1x1x0", allowlist)).toBe(false); // "." must not mean "any char"
  });
});

describe("buildBinds", () => {
  it("produces exactly ONE bind for a bot (its whole tree at /bot), and nothing else", () => {
    expect(buildBinds("/srv/myrmidon/bots", "agent-a")).toEqual(["/srv/myrmidon/bots/agent-a:/bot"]);
  });

  it("lays the three separate binds under the legacy volume layout (contract \"1\")", () => {
    expect(buildBinds("/srv/myrmidon/bots", "agent-a", { volumeLayout: "legacy" })).toEqual([
      "/srv/myrmidon/bots/agent-a/hermes:/data/hermes",
      "/srv/myrmidon/bots/agent-a/workspace:/workspace",
      "/srv/myrmidon/bots/agent-a/scratch:/scratch",
    ]);
  });

  it("keeps extras and cache binds identical under both layouts, after the base binds", () => {
    const mounts = [{ source: "/srv/shared/sources", containerPath: "/srv/shared/sources", readOnly: true } as const];
    for (const volumeLayout of ["legacy", "single"] as const) {
      expect(buildBinds("/srv/bots", "agent-a", { mounts, allowedSources: ["/srv/shared/sources"], sharedPackageCachePath: "/srv/cache", gitMirror: true, volumeLayout }).slice(0, volumeLayout === "legacy" ? 3 : 1)).toEqual(
        volumeLayout === "legacy"
          ? ["/srv/bots/agent-a/hermes:/data/hermes", "/srv/bots/agent-a/workspace:/workspace", "/srv/bots/agent-a/scratch:/scratch"]
          : ["/srv/bots/agent-a:/bot"],
      );
      const full = buildBinds("/srv/bots", "agent-a", { mounts, allowedSources: ["/srv/shared/sources"], sharedPackageCachePath: "/srv/cache", gitMirror: true, volumeLayout });
      expect(full.slice(-6)).toEqual([
        "/srv/shared/sources:/srv/shared/sources:ro",
        "/srv/cache/pnpm:/cache/pnpm:rw",
        "/srv/cache/go-mod:/cache/go-mod:rw",
        "/srv/cache/go-build:/cache/go-build:rw",
        "/srv/cache/gradle:/cache/gradle:rw",
        "/srv/cache/git:/cache/git:ro",
      ]);
    }
  });

  it("rejects a bot key that could escape the volume root", () => {
    expect(() => buildBinds("/srv/myrmidon/bots", "../../etc")).toThrow(BotContainerTemplateError);
  });

  it("appends an allowlisted extra mount as read-only, after the single bind", () => {
    const mounts = [{ source: "/srv/shared/sources", containerPath: "/srv/shared/sources", readOnly: true } as const];
    expect(buildBinds("/srv/myrmidon/bots", "agent-a", { mounts, allowedSources: ["/srv/shared/sources"] })).toEqual([
      "/srv/myrmidon/bots/agent-a:/bot",
      "/srv/shared/sources:/srv/shared/sources:ro",
    ]);
  });
});

describe("validateExtraMounts", () => {
  const allowed = ["/srv/shared/sources", "/srv/shared/tools"];
  const mount = (over: Partial<Omit<BotExtraMount, "readOnly">> & { readOnly?: boolean } = {}): BotExtraMount =>
    ({
      source: "/srv/shared/sources",
      containerPath: "/srv/shared/sources",
      readOnly: true,
      ...over,
    }) as BotExtraMount;

  it("accepts an allowlisted source with a safe target", () => {
    expect(() => validateExtraMounts([mount(), mount({ source: "/srv/shared/tools", containerPath: "/opt/tools" })], allowed)).not.toThrow();
  });

  it("rejects a source outside the instance allowlist (no prefix rule)", () => {
    expect(() => validateExtraMounts([mount({ source: "/srv/shared/other" })], allowed)).toThrow(BotContainerTemplateError);
    expect(() => validateExtraMounts([mount({ source: "/srv/shared" })], allowed)).toThrow(BotContainerTemplateError);
    expect(() => validateExtraMounts([mount({ source: "/srv/shared/sources/deeper" })], allowed)).toThrow(
      BotContainerTemplateError,
    );
  });

  it("rejects everything when the allowlist is empty", () => {
    expect(() => validateExtraMounts([mount()], [])).toThrow(BotContainerTemplateError);
  });

  it("ignores an allowlist entry that is not a plain absolute directory", () => {
    expect(() => validateExtraMounts([mount({ source: "/srv/shared/sources/" })], ["/srv/shared/sources/"])).toThrow(
      BotContainerTemplateError,
    );
    expect(() => validateExtraMounts([mount({ source: "/srv/../etc" })], ["/srv/../etc"])).toThrow(BotContainerTemplateError);
  });

  it.each(["../etc", "srv/shared", "/srv/../etc", "/srv//shared", "/srv/shared/", "/", "/srv/share\nd"])(
    "rejects an unsafe source %j",
    (source) => {
      expect(() => validateExtraMounts([mount({ source })], [source])).toThrow(BotContainerTemplateError);
    },
  );

  it.each(["/bot", "/bot/x", "/data", "/data/x", "/data/hermes", "/workspace", "/workspace/shared", "/scratch", "/tmp", "/tmp/x", "relative", "/x/../y"])(
    "rejects a reserved or unsafe container path %j",
    (containerPath) => {
      expect(() => validateExtraMounts([mount({ containerPath })], allowed)).toThrow(BotContainerTemplateError);
    },
  );

  it("rejects the same container path twice", () => {
    expect(() => validateExtraMounts([mount(), mount({ source: "/srv/shared/tools" })], allowed)).toThrow(
      BotContainerTemplateError,
    );
  });

  it("rejects a writable extra mount", () => {
    expect(() => validateExtraMounts([mount({ readOnly: false })], allowed)).toThrow(BotContainerTemplateError);
  });
});

describe("parseMountSourceAllowlist", () => {
  it("splits on commas, trims and drops blanks", () => {
    expect(parseMountSourceAllowlist("/srv/shared/sources, /srv/shared/tools ,")).toEqual([
      "/srv/shared/sources",
      "/srv/shared/tools",
    ]);
    expect(parseMountSourceAllowlist(undefined)).toEqual([]);
    expect(parseMountSourceAllowlist("")).toEqual([]);
  });
});

// BUILD-OFFLOAD C: the dev-variant build server wiring.
describe("parseDevbuildSettings", () => {
  it("is off without MYRMIDON_DEVBUILD_HOST, and blanks count as unset", () => {
    expect(parseDevbuildSettings({})).toEqual({ host: null, user: "devbuild", base: "/srv/devbuild" });
    expect(parseDevbuildSettings({ MYRMIDON_DEVBUILD_HOST: "   " })).toEqual({ host: null, user: "devbuild", base: "/srv/devbuild" });
  });

  it("reads the three settings and trims them", () => {
    expect(
      parseDevbuildSettings({
        MYRMIDON_DEVBUILD_HOST: " build-host.internal ",
        MYRMIDON_DEVBUILD_USER: "builder",
        MYRMIDON_DEVBUILD_BASE: "/builds",
      }),
    ).toEqual({ host: "build-host.internal", user: "builder", base: "/builds" });
  });
});

describe("isDevBuildImage", () => {
  it("recognizes the dev-variant image by reference, with any registry, tag or digest", () => {
    expect(isDevBuildImage("ghcr.io/itkadr-git/myrmidon-hermes-dev:main")).toBe(true);
    expect(isDevBuildImage("ghcr.io/itkadr-git/myrmidon-hermes-dev")).toBe(true);
    expect(isDevBuildImage(`ghcr.io/itkadr-git/myrmidon-hermes-dev@sha256:${"0".repeat(64)}`)).toBe(true);
    expect(isDevBuildImage("myrmidon-hermes-dev:latest")).toBe(true);
  });

  it("does not match the other variants or a merely similar name", () => {
    expect(isDevBuildImage("ghcr.io/itkadr-git/myrmidon-hermes:1.1.0")).toBe(false);
    expect(isDevBuildImage("ghcr.io/itkadr-git/myrmidon-hermes-node:latest")).toBe(false);
    expect(isDevBuildImage("ghcr.io/itkadr-git/myrmidon-hermes-devx:latest")).toBe(false);
    expect(isDevBuildImage("ghcr.io/itkadr-git/xmyrmidon-hermes-dev:latest")).toBe(false);
  });
});

describe("devbuildContainerEnv / devbuildKeyMount", () => {
  const settings = (over: Partial<ReturnType<typeof parseDevbuildSettings>> = {}) => ({
    host: "build-host.internal",
    user: "builder",
    base: "/builds",
    ...over,
  });

  it("returns the DEVBUILD_* entries when the wiring is on, null when it is off", () => {
    expect(devbuildContainerEnv(settings())).toEqual({
      DEVBUILD_HOST: "build-host.internal",
      DEVBUILD_USER: "builder",
      DEVBUILD_BASE: "/builds",
    });
    expect(devbuildContainerEnv(settings({ host: null }))).toBeNull();
  });

  it("mounts the first allowlisted source ending in devbuild-ssh, read-only, at the reserved path", () => {
    expect(devbuildKeyMount(settings(), ["/srv/shared/sources", "/srv/keys/devbuild-ssh"])).toEqual({
      source: "/srv/keys/devbuild-ssh",
      containerPath: "/opt/devbuild-ssh",
      readOnly: true,
    });
  });

  it("returns null without HOST, and null when no source matches", () => {
    expect(devbuildKeyMount(settings({ host: null }), ["/srv/keys/devbuild-ssh"])).toBeNull();
    expect(devbuildKeyMount(settings(), ["/srv/shared/sources"])).toBeNull();
  });

  it("ignores a matching entry that is not a plain absolute directory", () => {
    expect(devbuildKeyMount(settings(), ["devbuild-ssh", "/srv/keys/devbuild-ssh/"])).toBeNull();
  });

  it("produces a mount that rides the driver's own slot and renders as a read-only bind", () => {
    const mount = devbuildKeyMount(settings(), ["/srv/keys/devbuild-ssh"])!;
    // A card cannot pass this mount through its own list: /opt/devbuild-ssh is
    // reserved. The driver's own slot accepts it and checks the source the same way.
    expect(() => validateExtraMounts([mount], ["/srv/keys/devbuild-ssh"])).toThrow(BotContainerTemplateError);
    expect(() => buildBinds("/srv/myrmidon/bots", "agent-a", { driverMount: mount })).toThrow(BotContainerTemplateError); // source not allowlisted
    expect(
      buildBinds("/srv/myrmidon/bots", "agent-a", { driverMount: mount, allowedSources: ["/srv/keys/devbuild-ssh"] }),
    ).toEqual([
      "/srv/myrmidon/bots/agent-a:/bot",
      "/srv/keys/devbuild-ssh:/opt/devbuild-ssh:ro",
    ]);
  });
});

describe("mountRootSegment", () => {
  it("uses the container mount path, not the host bind suffix, for the hermes mount", () => {
    const binds = buildBinds("/srv/myrmidon/bots", "agent-a");
    expect(binds[0]).toBe("/srv/myrmidon/bots/agent-a:/bot");
    expect(mountRootSegment({ hostSuffix: "hermes", containerPath: "/data/hermes" })).toBe("data/hermes");
    expect(mountRootSegment({ hostSuffix: "workspace", containerPath: "/workspace" })).toBe("workspace");
    expect(mountRootSegment({ hostSuffix: "scratch", containerPath: "/scratch" })).toBe("scratch");
  });
});

describe("resolveProfileFileTarget", () => {
  function file(path: string): CompiledProfileFile {
    return { path, content: "", mode: 0o644, secret: false };
  }

  it("routes hermes/workspace/scratch prefixes to their mount", () => {
    expect(resolveProfileFileTarget(file("hermes/config.yaml"))).toEqual({
      mount: { hostSuffix: "hermes", containerPath: "/data/hermes" },
      relativePath: "config.yaml",
    });
    expect(resolveProfileFileTarget(file("workspace/AGENTS.md")).relativePath).toBe("AGENTS.md");
    expect(resolveProfileFileTarget(file("scratch/tmp/x")).relativePath).toBe("tmp/x");
  });

  it("rejects any other top-level segment (a compiler bug, not user input)", () => {
    expect(() => resolveProfileFileTarget(file("etc/passwd"))).toThrow(BotContainerTemplateError);
    expect(() => resolveProfileFileTarget(file("hermes"))).toThrow(BotContainerTemplateError); // no relative path
    expect(() => resolveProfileFileTarget(file("hermes/"))).toThrow(BotContainerTemplateError);
  });

  it.each([
    "hermes/../../etc/passwd",
    "hermes/../.myrmidon/applied.json", // would land on the live marker once Docker cleans the staged path
    "hermes/../../workspace/x", // would reach another volume, past the staging directory
    "hermes/config/../../../etc/passwd",
    "workspace/..",
    "hermes/./config.yaml",
    "hermes/.",
    "hermes//config.yaml",
    "hermes/config.yaml/",
  ])("rejects a '..' / '.' / empty segment anywhere in the relative path: %j", (path) => {
    expect(() => resolveProfileFileTarget(file(path))).toThrow(BotContainerTemplateError);
  });

  it("rejects a backslash, a NUL and other control characters", () => {
    expect(() => resolveProfileFileTarget(file("hermes/..\\..\\etc"))).toThrow(/backslash/);
    expect(() => resolveProfileFileTarget(file("hermes/skills\\x.md"))).toThrow(/backslash/);
    expect(() => resolveProfileFileTarget(file("hermes/config.yaml\u0000.png"))).toThrow(/control character/);
    expect(() => resolveProfileFileTarget(file("hermes/a\nhermes/.env"))).toThrow(/control character/);
    expect(() => resolveProfileFileTarget(file("hermes/a\u007f"))).toThrow(/control character/);
  });

  it.each([
    "hermes/.myrmidon/applied.json", // the applied-state marker itself
    "hermes/.myrmidon",
    "hermes/.myrmidon-next-0011223344556677/config.yaml", // another apply's staging
    "hermes/.myrmidon-apply-0011223344556677/applied.json",
    "hermes/.myrmidon-old-0011223344556677/0",
    "hermes/.myrmidon-marker-next/x",
    "workspace/.myrmidon-next-ab/AGENTS.md",
    "hermes/skills-board/x/.myrmidon/y", // reserved anywhere, not only at the mount root
  ])("rejects a path into the driver's reserved bookkeeping: %j", (path) => {
    expect(() => resolveProfileFileTarget(file(path))).toThrow(/reserved/);
  });

  it("still accepts ordinary names that merely contain dots, including a leading dot", () => {
    expect(resolveProfileFileTarget(file("workspace/notes.v2.md")).relativePath).toBe("notes.v2.md");
    expect(resolveProfileFileTarget(file("hermes/.env")).relativePath).toBe(".env");
    expect(resolveProfileFileTarget(file("hermes/skills-board/a..b/SKILL.md")).relativePath).toBe("skills-board/a..b/SKILL.md");
  });
});

describe("isUnderManagedDir", () => {
  it("covers the compiler-owned skills directory and everything under it, nothing else", () => {
    expect(isUnderManagedDir("hermes/skills-board")).toBe(true);
    expect(isUnderManagedDir("hermes/skills-board/a/SKILL.md")).toBe(true);
    expect(isUnderManagedDir("hermes/skills-board-other/a")).toBe(false);
    expect(isUnderManagedDir("hermes/skills/a/SKILL.md")).toBe(false);
    expect(isUnderManagedDir("workspace/AGENTS.md")).toBe(false);
  });
});

describe("buildLabels", () => {
  it("always wins over caller-supplied labels for the identification keys, and cannot be tagged a helper", () => {
    const labels = buildLabels({
      botKey: "agent-a",
      image: "myrmidon-hermes:1.1.0",
      labels: {
        [BOT_LABEL_KEYS.bot]: "someone-else",
        [BOT_LABEL_KEYS.image]: "evil:latest",
        [BOT_LABEL_KEYS.helper]: "agent-a",
        group: "team-b",
      },
    });
    expect(labels).toEqual({
      group: "team-b",
      [BOT_LABEL_KEYS.bot]: "agent-a",
      [BOT_LABEL_KEYS.image]: "myrmidon-hermes:1.1.0",
    });
  });

  it("carries no profile hashes: a label is fixed at creation and can never mean 'applied'", () => {
    const labels = buildLabels({ botKey: "agent-a", image: "myrmidon-hermes:1.1.0" });
    expect(Object.keys(labels).sort()).toEqual([BOT_LABEL_KEYS.bot, BOT_LABEL_KEYS.image].sort());
    expect(Object.keys(labels).some((key) => key.includes("hash"))).toBe(false);
  });
});

describe("assertBotRuntimeContract", () => {
  it("accepts an image that declares a supported contract, whatever else it is labelled with", () => {
    expect(() =>
      assertBotRuntimeContract("myrmidon-hermes:1.1.0", {
        "org.opencontainers.image.title": "myrmidon-hermes",
        [BOT_RUNTIME_CONTRACT_LABEL]: "1",
      }),
    ).not.toThrow();
  });

  it("accepts the single-mount contract \"2\" too", () => {
    expect(() => assertBotRuntimeContract("myrmidon-hermes:1.6.5", { [BOT_RUNTIME_CONTRACT_LABEL]: "2" })).not.toThrow();
  });

  const refused: Array<{ label: string; labels: Record<string, string> | null | undefined }> = [
    { label: "no labels (Docker's null)", labels: null },
    { label: "no labels (absent)", labels: undefined },
    { label: "other labels only", labels: { "org.opencontainers.image.title": "myrmidon-hermes" } },
    { label: "an empty contract", labels: { [BOT_RUNTIME_CONTRACT_LABEL]: "" } },
    { label: "an unknown contract", labels: { [BOT_RUNTIME_CONTRACT_LABEL]: "3" } },
  ];
  it.each(refused)("refuses an image with $label", ({ labels }) => {
    expect(() => assertBotRuntimeContract("myrmidon-hermes:1.0.0", labels)).toThrow(BotContainerTemplateError);
  });
});

// The acceptance of the ticket: the volume layout follows the IMAGE's contract,
// never the board's newest template (1.6.5-rc.1: containers of the 1.6.4 image
// were recreated with the single-mount layout and crash-looped on an empty
// $HERMES_HOME).
describe("botVolumeLayout (volume layout pinned by the image contract)", () => {
  it("contract \"2\" is the single /bot mount", () => {
    expect(botVolumeLayout("myrmidon-hermes:1.6.5", { [BOT_RUNTIME_CONTRACT_LABEL]: "2" })).toBe("single");
    expect(botVolumeLayout("img", { [BOT_RUNTIME_CONTRACT_LABEL]: "2", [BOT_RUNTIME_SCOPE_LABEL]: "1" })).toBe("single");
  });

  it("contract \"1\" without the scope label is the legacy three-volume layout (the 1.6.4 release images)", () => {
    expect(botVolumeLayout("myrmidon-hermes@sha256:164", { [BOT_RUNTIME_CONTRACT_LABEL]: "1" })).toBe("legacy");
    expect(botVolumeLayout("myrmidon-hermes@sha256:164", { [BOT_RUNTIME_CONTRACT_LABEL]: "1", "org.opencontainers.image.title": "myrmidon-hermes" })).toBe("legacy");
  });

  it("contract \"1\" WITH the scope label is the single mount: the BOT-DISK-D/F-era images shipped before the layout was versioned", () => {
    expect(botVolumeLayout("myrmidon-hermes@sha256:rc1", { [BOT_RUNTIME_CONTRACT_LABEL]: "1", [BOT_RUNTIME_SCOPE_LABEL]: "1" })).toBe("single");
  });

  it("refuses an image without a supported contract, like assertBotRuntimeContract", () => {
    expect(() => botVolumeLayout("myrmidon-hermes:1.0.0", null)).toThrow(BotContainerTemplateError);
    expect(() => botVolumeLayout("myrmidon-hermes:bad", { [BOT_RUNTIME_CONTRACT_LABEL]: "9" })).toThrow(/supports only/);
    expect(() => declaredBotRuntimeContract("img", { [BOT_RUNTIME_CONTRACT_LABEL]: "1" })).not.toThrow();
    expect(declaredBotRuntimeContract("img", { [BOT_RUNTIME_CONTRACT_LABEL]: "2" })).toBe("2");
  });
});

// myrmidon(1.6.5-BOT-DISK-H11): the shared bot runtime (the design's class C)
// and operator data directories inside the bot's own volume (class J).
describe("buildBinds: the shared bot runtime (1.6.5-BOT-DISK-H11)", () => {
  const runtime = "/srv/bot-runtime";
  const pairs = [
    `${runtime}/bin:/bot/hermes/bin:ro`,
    `${runtime}/lazy-packages:/bot/hermes/lazy-packages:ro`,
    `${runtime}/lsp:/bot/hermes/lsp:ro`,
  ];

  it("adds the three runtime binds read-only, at the real path inside the bot's own mount", () => {
    expect(buildBinds("/srv/myrmidon/bots", "agent-a", { sharedBotRuntimePath: runtime })).toEqual([
      "/srv/myrmidon/bots/agent-a:/bot",
      ...pairs,
    ]);
  });

  it("keeps the cache binds and then the runtime binds, last", () => {
    expect(buildBinds("/srv/bots", "agent-a", { sharedPackageCachePath: "/srv/cache", sharedBotRuntimePath: runtime })).toEqual([
      "/srv/bots/agent-a:/bot",
      "/srv/cache/pnpm:/cache/pnpm:rw",
      "/srv/cache/go-mod:/cache/go-mod:rw",
      "/srv/cache/go-build:/cache/go-build:rw",
      "/srv/cache/gradle:/cache/gradle:rw",
      ...pairs,
    ]);
  });

  it("binds them at the volume itself under the legacy layout (contract \"1\" images)", () => {
    expect(buildBinds("/srv/bots", "agent-a", { sharedBotRuntimePath: runtime, volumeLayout: "legacy" }).slice(-3)).toEqual([
      `${runtime}/bin:/data/hermes/bin:ro`,
      `${runtime}/lazy-packages:/data/hermes/lazy-packages:ro`,
      `${runtime}/lsp:/data/hermes/lsp:ro`,
    ]);
  });

  it("binds them into the member directory of a shared scope instance (BOT-DISK-F)", () => {
    const scope = { scopeRoot: "/srv/bots/.scopes", dirName: "caste-7" };
    expect(buildBinds("/srv/bots", "agent-a", { sharedBotRuntimePath: runtime, scope }).slice(-3)).toEqual([
      `${runtime}/bin:/bot-scope/agent-a/hermes/bin:ro`,
      `${runtime}/lazy-packages:/bot-scope/agent-a/hermes/lazy-packages:ro`,
      `${runtime}/lsp:/bot-scope/agent-a/hermes/lsp:ro`,
    ]);
  });

  it("stays off unless the operator set the path", () => {
    expect(buildBinds("/srv/bots", "agent-a")).toEqual(["/srv/bots/agent-a:/bot"]);
  });

  it("refuses a path that is not an absolute host directory", () => {
    for (const bad of ["srv/runtime", "/srv/runtime/", "/srv//runtime"]) {
      expect(() => buildBinds("/srv/bots", "agent-a", { sharedBotRuntimePath: bad })).toThrow(BotContainerTemplateError);
    }
  });

  it("still refuses a mount point that would take over a runtime path", () => {
    const mounts = [{ source: "/srv/media", containerPath: "/data/hermes/bin", readOnly: true } as const];
    expect(() => buildBinds("/srv/bots", "agent-a", { mounts, allowedSources: ["/srv/media"] })).toThrow(
      BotContainerTemplateError,
    );
  });
});

describe("buildBinds: owner data inside the bot's own volume (1.6.5-BOT-DISK-H11, class J)", () => {
  const mounts = [{ source: "/srv/media", containerPath: "/data/hermes/media/site", readOnly: true } as const];

  it("binds an owner-data mount at the real path inside the bot's own mount", () => {
    expect(buildBinds("/srv/bots", "agent-a", { mounts, allowedSources: ["/srv/media"] })).toEqual([
      "/srv/bots/agent-a:/bot",
      "/srv/media:/bot/hermes/media/site:ro",
    ]);
  });

  it("keeps its container path under the legacy layout", () => {
    expect(
      buildBinds("/srv/bots", "agent-a", { mounts, allowedSources: ["/srv/media"], volumeLayout: "legacy" }).slice(-1),
    ).toEqual(["/srv/media:/data/hermes/media/site:ro"]);
  });

  it("refuses a mount point under a runtime path of the bot's own tree", () => {
    const taken = [{ source: "/srv/media", containerPath: "/data/hermes/lsp/site", readOnly: true } as const];
    expect(() => buildBinds("/srv/bots", "agent-a", { mounts: taken, allowedSources: ["/srv/media"] })).toThrow(
      BotContainerTemplateError,
    );
  });
});

import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";

import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
  type NativeRuntimeContextSnapshot,
} from "../contracts/runtime-context.js";
import { nativeMcpLaunchBinding } from "./native-mcp.js";
import {
  materializeNativeRuntimeSkills,
  normalizeCodexOpenAiBaseUrl,
  prepareIsolatedCodexHome,
  releaseMaterializedNativeRuntimeSkills,
} from "./runtime-context-materializer.js";

const roots: string[] = [];

async function makeWritable(root: string): Promise<void> {
  const info = await lstat(root).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(root, 0o700);
    for (const entry of await readdir(root)) {
      await makeWritable(join(root, entry));
    }
  } else {
    await chmod(root, 0o600);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

function context(
  skillRoot: string,
  instructionRoot: string,
  runtimeName = "assigned",
): NativeRuntimeContextSnapshot {
  const digest = "0".repeat(64);
  const value = {
    prompt: {
      revision: PAPERCLIP_EXECUTION_PROMPT_REVISION,
      text: PAPERCLIP_EXECUTION_PROMPT,
      digest: nativeRuntimePromptDigest(),
    },
    instructions: {
      entryPath: "AGENTS.md",
      bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        digest,
        manifestDigest: digest,
        rootPath: instructionRoot,
        fileCount: 2,
        totalBytes: 2,
      },
    },
    skills: [{
      key: `company/${runtimeName}`,
      runtimeName,
      versionId: "version-1",
      bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        digest,
        manifestDigest: digest,
        rootPath: skillRoot,
        fileCount: 2,
        totalBytes: 2,
      },
    }],
    mcp: { assignmentSetId: runtimeName, digest, bindingId: "binding" },
  } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
  return { ...value, aggregateDigest: canonicalNativeRuntimeContextDigest(value) };
}

describe("runtime context materialization", () => {
  it("validates native MCP launch bindings before they reach Codex", () => {
    expect(nativeMcpLaunchBinding({})).toBeNull();
    expect(() => nativeMcpLaunchBinding({
      PAPERCLIP_NATIVE_MCP_NAME: "paperclip",
      PAPERCLIP_NATIVE_MCP_URL: "http://paperclip.example/mcp",
      PAPERCLIP_NATIVE_MCP_TOKEN: "x".repeat(40),
    })).toThrow("requires HTTPS or loopback HTTP");
    expect(() => nativeMcpLaunchBinding({
      PAPERCLIP_NATIVE_MCP_NAME: "paperclip",
      PAPERCLIP_NATIVE_MCP_URL: "https://user:pass@paperclip.example/mcp#secret",
      PAPERCLIP_NATIVE_MCP_TOKEN: "x".repeat(40),
    })).toThrow("contains forbidden URL data");
  });

  it("copies only assigned skills and writes an isolated MCP config", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runtime-context-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const instructions = join(root, "instructions-source");
    const hostSkills = join(root, "host-home", "skills", "unassigned");
    const codexHome = join(root, "codex-home");
    await Promise.all([
      mkdir(join(assigned, "references"), { recursive: true }),
      mkdir(instructions),
      mkdir(hostSkills, { recursive: true }),
    ]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(
      join(assigned, "references", "support.md"),
      "support\n",
    );
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");
    await writeFile(join(hostSkills, "SKILL.md"), "# Must not leak\n");

    await prepareIsolatedCodexHome({
      context: context(assigned, instructions),
      codexHome,
      sourceCodexHome: join(root, "host-home"),
      nativeMcp: nativeMcpLaunchBinding({
        PAPERCLIP_NATIVE_MCP_NAME: "paperclip-assigned",
        PAPERCLIP_NATIVE_MCP_URL: "https://paperclip.example/mcp",
        PAPERCLIP_NATIVE_MCP_TOKEN: "x".repeat(40),
      }),
    });

    await expect(readFile(
      join(codexHome, "skills", "assigned", "references", "support.md"),
      "utf8",
    )).resolves.toBe("support\n");
    await expect(stat(join(codexHome, "skills", "unassigned"))).rejects.toThrow();
    expect(
      (await stat(join(codexHome, "skills", "assigned", "SKILL.md"))).mode
      & 0o222,
    ).toBe(0);
    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("shell_snapshot = false");
    expect(config).toContain("paperclip-assigned");
    expect(config).toContain('default_tools_approval_mode = "approve"');
    expect(config).toContain("Bearer ");
    expect(config).not.toContain("unassigned");
  });

  it("rejects repeated assignments without changing the current assignment", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runtime-repeat-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const replacement = join(root, "replacement-source");
    const instructions = join(root, "instructions-source");
    const codexHome = join(root, "codex-home");
    await Promise.all([mkdir(assigned), mkdir(replacement), mkdir(instructions)]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(join(replacement, "SKILL.md"), "# Replacement\n");
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");

    await prepareIsolatedCodexHome({
      context: context(assigned, instructions),
      codexHome,
    });
    await expect(prepareIsolatedCodexHome({
      context: context(replacement, instructions, "replacement"),
      codexHome,
    })).rejects.toThrow("skills home must be a fresh destination");
    await expect(prepareIsolatedCodexHome({
      context: null,
      codexHome,
    })).rejects.toThrow("skills home must be a fresh destination");

    await expect(readFile(
      join(codexHome, "skills", "assigned", "SKILL.md"),
      "utf8",
    )).resolves.toBe("# Assigned\n");
    await expect(stat(join(codexHome, "skills", "replacement"))).rejects
      .toThrow();
  });

  it("rejects source symlinks without changing the current assignment", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runtime-symlink-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const unsafe = join(root, "unsafe-source");
    const instructions = join(root, "instructions-source");
    const external = join(root, "external.txt");
    const codexHome = join(root, "codex-home");
    await Promise.all([mkdir(assigned), mkdir(unsafe), mkdir(instructions)]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");
    await writeFile(external, "secret\n");
    await symlink(external, join(unsafe, "SKILL.md"));

    await prepareIsolatedCodexHome({
      context: context(assigned, instructions),
      codexHome,
    });
    await expect(prepareIsolatedCodexHome({
      context: context(unsafe, instructions, "unsafe"),
      codexHome,
    })).rejects.toThrow("runtime context asset contains a symlink");
    await expect(readFile(
      join(codexHome, "skills", "assigned", "SKILL.md"),
      "utf8",
    )).resolves.toBe("# Assigned\n");
  });

  it("rejects overlapping portable names without changing the current assignment", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runtime-atomic-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const replacement = join(root, "replacement-source");
    const instructions = join(root, "instructions-source");
    const codexHome = join(root, "codex-home");
    await Promise.all([mkdir(assigned), mkdir(replacement), mkdir(instructions)]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(join(replacement, "SKILL.md"), "# Replacement\n");
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");

    await prepareIsolatedCodexHome({
      context: context(assigned, instructions),
      codexHome,
    });
    const replacementContext = context(replacement, instructions, "group/child");
    for (const runtimeName of ["group", "GROUP", "group.", "group "]) {
      const collidingSkill = {
        ...replacementContext.skills[0]!,
        key: `company/${runtimeName}`,
        runtimeName,
      };
      for (const skills of [
        [...replacementContext.skills, collidingSkill],
        [collidingSkill, ...replacementContext.skills],
      ]) {
        const value = { ...replacementContext, skills };
        const collidingContext = {
          ...value,
          aggregateDigest: canonicalNativeRuntimeContextDigest(value),
        };

        await expect(prepareIsolatedCodexHome({
          context: collidingContext,
          codexHome,
        })).rejects.toThrow("skill names must not overlap");
        await expect(readFile(
          join(codexHome, "skills", "assigned", "SKILL.md"),
          "utf8",
        )).resolves.toBe("# Assigned\n");
        await expect(stat(join(codexHome, "skills", "group"))).rejects.toThrow();
      }
    }

    const win32AliasedChild = {
      ...replacementContext.skills[0]!,
      key: "company/group-dot-child",
      runtimeName: "group./child",
    };
    const value = {
      ...replacementContext,
      skills: [...replacementContext.skills, win32AliasedChild],
    };
    await expect(prepareIsolatedCodexHome({
      context: {
        ...value,
        aggregateDigest: canonicalNativeRuntimeContextDigest(value),
      },
      codexHome,
    })).rejects.toThrow("skill names must not overlap");
  });

  it("rejects an existing destination before filesystem mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runtime-existing-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const replacement = join(root, "replacement-source");
    const instructions = join(root, "instructions-source");
    const skillsHome = join(root, "codex-home", "skills");
    await Promise.all([
      mkdir(assigned),
      mkdir(replacement),
      mkdir(instructions),
    ]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(join(replacement, "SKILL.md"), "# Replacement\n");
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");

    await materializeNativeRuntimeSkills(
      context(assigned, instructions),
      skillsHome,
    );
    const originalBytes = await readFile(
      join(skillsHome, "assigned", "SKILL.md"),
    );
    let dependencyCalls = 0;
    await expect(
      materializeNativeRuntimeSkills(
        context(replacement, instructions, "replacement"),
        skillsHome,
        {
          renameTree: async () => {
            dependencyCalls += 1;
          },
          removeTree: async () => {
            dependencyCalls += 1;
          },
        },
      ),
    ).rejects.toThrow("skills home must be a fresh destination");

    expect(dependencyCalls).toBe(0);
    expect(await readFile(join(skillsHome, "assigned", "SKILL.md"))).toEqual(
      originalBytes,
    );
    await expect(stat(join(skillsHome, "replacement"))).rejects.toThrow();
    expect(
      (await readdir(dirname(skillsHome))).filter((entry) =>
        entry.startsWith(".paperclip-skills-"),
      ),
    ).toEqual([]);
  });

  it("cleans private staging when fresh publication fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runtime-publish-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const instructions = join(root, "instructions-source");
    const skillsHome = join(root, "codex-home", "skills");
    await Promise.all([mkdir(assigned), mkdir(instructions)]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");

    await expect(materializeNativeRuntimeSkills(
      context(assigned, instructions),
      skillsHome,
      {
        renameTree: async (source) => {
          await expect(
            readFile(join(source, "assigned", "SKILL.md"), "utf8"),
          ).resolves.toBe("# Assigned\n");
          throw new Error("simulated publication failure");
        },
      },
    )).rejects.toThrow("simulated publication failure");

    await expect(stat(skillsHome)).rejects.toThrow();
    expect(
      (await readdir(dirname(skillsHome))).filter((entry) =>
        entry.startsWith(".paperclip-skills-staging-"),
      ),
    ).toEqual([]);
  });

  it("rejects skill names that can escape or alias the skills home", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runtime-name-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const instructions = join(root, "instructions-source");
    const codexHome = join(root, "codex-home");
    await Promise.all([mkdir(assigned), mkdir(instructions)]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");

    await expect(prepareIsolatedCodexHome({
      context: context(assigned, instructions, "../outside"),
      codexHome,
    })).rejects.toThrow("skill name must be a safe relative path");
    for (const runtimeName of [
      "CON",
      "con.txt",
      "CON .txt",
      "aux .json",
      "COM1 .md",
      "group/AUX",
      "Lpt1.json",
      "group:name",
      "group?name",
      "group*name",
      'group"name',
      "group<name",
      "group>name",
      "group|name",
      "group\u0001name",
      "...",
      ". .",
      "group/...",
      "group/. . ",
    ]) {
      await expect(prepareIsolatedCodexHome({
        context: context(assigned, instructions, runtimeName),
        codexHome,
      })).rejects.toThrow("skill name must be a safe relative path");
    }
    await expect(stat(join(root, "outside"))).rejects.toThrow();
  });

  it("writes API login state as an owner-only file and removes stale auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runtime-auth-"));
    roots.push(root);
    const codexHome = join(root, "codex-home");
    const emptyCodexHome = join(root, "empty-codex-home");
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(emptyCodexHome, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(codexHome, "auth.json"), "stale", { mode: 0o600 }),
      writeFile(join(emptyCodexHome, "auth.json"), "stale", { mode: 0o600 }),
    ]);

    await prepareIsolatedCodexHome({
      context: null,
      codexHome,
      apiKey: "fresh-ephemeral-key",
    });

    await expect(readFile(join(codexHome, "auth.json"), "utf8")).resolves.toBe(
      JSON.stringify({ OPENAI_API_KEY: "fresh-ephemeral-key" }),
    );
    expect((await stat(join(codexHome, "auth.json"))).mode & 0o777).toBe(0o600);

    await prepareIsolatedCodexHome({ context: null, codexHome: emptyCodexHome });
    await expect(stat(join(emptyCodexHome, "auth.json"))).rejects.toThrow();
  });

  it("copies regular host auth but refuses symlinked auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runtime-host-auth-"));
    roots.push(root);
    const codexHome = join(root, "codex-home");
    const symlinkCodexHome = join(root, "symlink-codex-home");
    const sourceHome = join(root, "source-home");
    const secret = join(root, "secret.json");
    await mkdir(sourceHome);
    await writeFile(join(sourceHome, "auth.json"), "host-auth", { mode: 0o600 });

    await prepareIsolatedCodexHome({
      context: null,
      codexHome,
      sourceCodexHome: sourceHome,
    });
    await expect(readFile(join(codexHome, "auth.json"), "utf8")).resolves.toBe(
      "host-auth",
    );

    await rm(join(sourceHome, "auth.json"));
    await writeFile(secret, "must-not-copy");
    await symlink(secret, join(sourceHome, "auth.json"));
    await prepareIsolatedCodexHome({
      context: null,
      codexHome: symlinkCodexHome,
      sourceCodexHome: sourceHome,
    });
    await expect(stat(join(symlinkCodexHome, "auth.json"))).rejects.toThrow();
  });

  describe("OpenAI-compatible gateway address", () => {
    const BASE_URL_ERROR =
      "OPENAI_BASE_URL must be an http:// or https:// URL without whitespace or quotes";

    async function codexHomeRoot(): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), "paperclip-runtime-base-url-"));
      roots.push(root);
      return root;
    }

    it("writes the address as a root-level openai_base_url key before the first table", async () => {
      const root = await codexHomeRoot();
      const codexHome = join(root, "codex-home");
      await mkdir(codexHome);

      await prepareIsolatedCodexHome({
        context: null,
        codexHome,
        openaiBaseUrl: "https://llm-gateway.example:4000/v1",
        nativeMcp: nativeMcpLaunchBinding({
          PAPERCLIP_NATIVE_MCP_NAME: "paperclip-assigned",
          PAPERCLIP_NATIVE_MCP_URL: "https://paperclip.example/mcp",
          PAPERCLIP_NATIVE_MCP_TOKEN: "x".repeat(40),
        }),
      });

      const config = await readFile(join(codexHome, "config.toml"), "utf8");
      expect(config).toContain(
        'openai_base_url = "https://llm-gateway.example:4000/v1"\n',
      );
      // A key after a table header would belong to that table, not to the root.
      expect(config.indexOf("openai_base_url")).toBeLessThan(
        config.indexOf("[features]"),
      );
      const parsed = parse(config);
      expect(parsed.openai_base_url).toBe("https://llm-gateway.example:4000/v1");
      // The keys that were already written stay as they were.
      expect(parsed.features).toEqual({ shell_snapshot: false });
      expect(
        (parsed.mcp_servers as Record<string, { url: string }>)[
          "paperclip-assigned"
        ].url,
      ).toBe("https://paperclip.example/mcp");
      expect((await stat(join(codexHome, "config.toml"))).mode & 0o777).toBe(
        0o600,
      );
    });

    it("keeps the exact value and escapes it as a TOML string", async () => {
      const root = await codexHomeRoot();
      const codexHome = join(root, "codex-home");
      await mkdir(codexHome);
      const address = "http://llm-gateway.example/v1?tag=a%20b&q=%22#frag";

      await prepareIsolatedCodexHome({
        context: null,
        codexHome,
        // Surrounding whitespace comes from copied settings; it is not part of the value.
        openaiBaseUrl: `  ${address}\n`,
      });

      const config = await readFile(join(codexHome, "config.toml"), "utf8");
      expect(config).toContain(`openai_base_url = ${JSON.stringify(address)}\n`);
      expect(parse(config).openai_base_url).toBe(address);
    });

    it("does not write the key when no address is configured", async () => {
      const root = await codexHomeRoot();
      const baselineHome = join(root, "baseline-codex-home");
      await mkdir(baselineHome);
      await prepareIsolatedCodexHome({ context: null, codexHome: baselineHome });
      const baseline = await readFile(join(baselineHome, "config.toml"), "utf8");
      expect(baseline).not.toContain("openai_base_url");

      for (const [index, openaiBaseUrl] of [
        undefined,
        null,
        "",
        "   \n",
      ].entries()) {
        const codexHome = join(root, `codex-home-${index}`);
        await mkdir(codexHome);
        await prepareIsolatedCodexHome({ context: null, codexHome, openaiBaseUrl });
        await expect(
          readFile(join(codexHome, "config.toml"), "utf8"),
        ).resolves.toBe(baseline);
      }
    });

    it("replaces an address from an earlier launch instead of keeping it", async () => {
      const root = await codexHomeRoot();
      const codexHome = join(root, "codex-home");
      await mkdir(codexHome);
      const relaunch = async (openaiBaseUrl?: string) => {
        // The native runner releases the skills of the previous launch first.
        await releaseMaterializedNativeRuntimeSkills(join(codexHome, "skills"));
        await prepareIsolatedCodexHome({ context: null, codexHome, openaiBaseUrl });
      };

      await relaunch("https://old-gateway.example/v1");
      await relaunch("https://new-gateway.example/v1");
      let config = await readFile(join(codexHome, "config.toml"), "utf8");
      expect(config.match(/openai_base_url/g)).toHaveLength(1);
      expect(parse(config).openai_base_url).toBe("https://new-gateway.example/v1");

      await relaunch();
      config = await readFile(join(codexHome, "config.toml"), "utf8");
      expect(config).not.toContain("openai_base_url");
    });

    it("fails the launch for an address that is not a plain http(s) URL, without echoing it", async () => {
      const root = await codexHomeRoot();
      const codexHome = join(root, "codex-home");
      await mkdir(codexHome);
      await writeFile(join(codexHome, "config.toml"), "model = 'kept'\n");

      const bad = [
        "llm-gateway.example/v1",
        "ftp://llm-gateway.example/v1",
        "file:///srv/gateway",
        "javascript:alert(1)",
        "http://",
        "https:///v1",
        "http://llm gateway.example/v1",
        "https://llm-gateway.example/v1\ninjected = true",
        'https://llm-gateway.example/v1"',
        "https://llm-gateway.example/v1'",
        "https://llm-gateway.example/`v1`",
        "https://llm-gateway.example\\v1",
        "https://llm-gateway.example/v1\u0000",
        "https://llm-gateway.example/\u0085v1",
        "https://llm-gateway.example/\ud800v1",
      ];
      for (const openaiBaseUrl of bad) {
        const failure = await prepareIsolatedCodexHome({
          context: null,
          codexHome,
          openaiBaseUrl,
        }).then(
          () => null,
          (error: unknown) => error as Error,
        );
        expect(failure, JSON.stringify(openaiBaseUrl)).toBeInstanceOf(Error);
        expect(failure?.message).toBe(BASE_URL_ERROR);
      }

      // Validation runs before the home is touched.
      await expect(
        readFile(join(codexHome, "config.toml"), "utf8"),
      ).resolves.toBe("model = 'kept'\n");
      await expect(stat(join(codexHome, "skills"))).rejects.toThrow();
    });

    it("normalizes an address and treats an empty one as not configured", () => {
      expect(normalizeCodexOpenAiBaseUrl(undefined)).toBeNull();
      expect(normalizeCodexOpenAiBaseUrl(null)).toBeNull();
      expect(normalizeCodexOpenAiBaseUrl(" \t")).toBeNull();
      expect(normalizeCodexOpenAiBaseUrl(" http://127.0.0.1:4000/v1 ")).toBe(
        "http://127.0.0.1:4000/v1",
      );
      expect(normalizeCodexOpenAiBaseUrl("HTTPS://Gateway.Example/v1")).toBe(
        "HTTPS://Gateway.Example/v1",
      );
      expect(() => normalizeCodexOpenAiBaseUrl("socks5://gateway.example")).toThrow(
        BASE_URL_ERROR,
      );
    });
  });
});

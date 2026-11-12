import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findProviderConfig,
  OMP_MANAGED_SETTINGS_FILE,
  prepareOmpRuntimeConfig,
  writeOmpManagedSettings,
} from "./runtime-config.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function readModelsYml(agentConfigDir: string): Promise<string> {
  return await fs.readFile(path.join(agentConfigDir, "models.yml"), "utf8");
}

describe("prepareOmpRuntimeConfig", () => {
  it("is a no-op when no OMP or PI provider variable is set", async () => {
    const prepared = await prepareOmpRuntimeConfig({ env: { FOO: "bar" } });

    expect(prepared.env).toEqual({ FOO: "bar" });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.env.OMP_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  it("writes the providers YAML to a managed models.yml and points PI_CODING_AGENT_DIR and OMP_CODING_AGENT_DIR at it", async () => {
    const providers = {
      tensorix: {
        baseUrl: "http://gateway.example.svc.cluster.local:8080/anthropic",
        apiKey: "sk-literal",
        api: "anthropic-messages",
        models: [
          {
            id: "deepseek/deepseek-chat-v3.1",
            name: "DeepSeek v3.1",
          },
        ],
      },
    };

    const prepared = await prepareOmpRuntimeConfig({
      env: { MYRMIDON_OMP_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    expect(agentConfigDir).toBeTruthy();
    expect(prepared.env.OMP_CODING_AGENT_DIR).toBe(agentConfigDir);
    cleanupPaths.add(agentConfigDir);

    const yml = await readModelsYml(agentConfigDir);
    expect(yml).toContain("providers:");
    expect(yml).toContain("tensorix:");
    expect(yml).toContain("baseUrl: \"http://gateway.example.svc.cluster.local:8080/anthropic\"");
    expect(prepared.notes.some((n) => n.includes("tensorix"))).toBe(true);

    await prepared.cleanup();
    cleanupPaths.delete(agentConfigDir);
    await expect(fs.access(agentConfigDir)).rejects.toThrow();
  });

  it("falls back to PAPERCLIP_PI_PROVIDERS when MYRMIDON_OMP_PROVIDERS is unset", async () => {
    const providers = { tensorix: { baseUrl: "http://gw/anthropic", api: "anthropic-messages" } };
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    expect(agentConfigDir).toBeTruthy();
    cleanupPaths.add(agentConfigDir);

    const yml = await readModelsYml(agentConfigDir);
    expect(yml).toContain("tensorix:");
    await prepared.cleanup();
  });

  it("expands {env:VAR} placeholders from the run env", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:ANTHROPIC_API_KEY}" },
    };
    const prepared = await prepareOmpRuntimeConfig({
      env: {
        MYRMIDON_OMP_PROVIDERS: JSON.stringify(providers),
        ANTHROPIC_API_KEY: "sk-bf-REALVK",
      },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);

    const yml = await readModelsYml(agentConfigDir);
    expect(yml).toContain('apiKey: "sk-bf-REALVK"');
    await prepared.cleanup();
  });

  it("expands {env:VAR} placeholders from process.env when absent from the run env", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:MYRMIDON_OMP_TEST_KEY}" },
    };
    process.env.MYRMIDON_OMP_TEST_KEY = "sk-from-process-env";
    try {
      const prepared = await prepareOmpRuntimeConfig({
        env: { MYRMIDON_OMP_PROVIDERS: JSON.stringify(providers) },
      });
      const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
      cleanupPaths.add(agentConfigDir);
      const yml = await readModelsYml(agentConfigDir);
      expect(yml).toContain('apiKey: "sk-from-process-env"');
      await prepared.cleanup();
    } finally {
      delete process.env.MYRMIDON_OMP_TEST_KEY;
    }
  });

  it("leaves an unresolvable {env:VAR} placeholder intact", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}" },
    };
    const prepared = await prepareOmpRuntimeConfig({
      env: { MYRMIDON_OMP_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    const yml = await readModelsYml(agentConfigDir);
    expect(yml).toContain('apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}"');
    await prepared.cleanup();
  });

  it("surfaces a note when MYRMIDON_OMP_PROVIDERS contains invalid JSON", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: { MYRMIDON_OMP_PROVIDERS: "{not json" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "MYRMIDON_OMP_PROVIDERS contains invalid JSON; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces a note when MYRMIDON_OMP_PROVIDERS is not a JSON object", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: { MYRMIDON_OMP_PROVIDERS: "[1,2]" },
    });
    expect(prepared.notes).toEqual([
      "MYRMIDON_OMP_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("ignores provider entries that are not objects and names them in the note", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: { MYRMIDON_OMP_PROVIDERS: JSON.stringify({ tensorix: "nope" }) },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.agentConfigDir).toBeNull();
    expect(prepared.notes).toEqual([
      "MYRMIDON_OMP_PROVIDERS: skipped provider(s) with non-object values: tensorix.",
    ]);
    await prepared.cleanup();
  });

  it("still reads the deprecated PAPERCLIP_OMP_PROVIDERS name and says so in the run notes", async () => {
    const providers = { tensorix: { baseUrl: "http://gw/anthropic", api: "anthropic-messages" } };
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    expect(agentConfigDir).toBeTruthy();
    cleanupPaths.add(agentConfigDir);
    expect(await readModelsYml(agentConfigDir)).toContain("tensorix:");
    expect(prepared.notes[0]).toBe(
      "PAPERCLIP_OMP_PROVIDERS is a deprecated alias of MYRMIDON_OMP_PROVIDERS; rename it in the agent environment.",
    );
    await prepared.cleanup();
  });

  it("names the deprecated variable in the warning when its value is broken", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: "{not json" },
    });
    expect(prepared.notes).toEqual([
      "PAPERCLIP_OMP_PROVIDERS is a deprecated alias of MYRMIDON_OMP_PROVIDERS; rename it in the agent environment.",
      "PAPERCLIP_OMP_PROVIDERS contains invalid JSON; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });
});

// myrmidon(OPE-12805)
describe("managed omp settings", () => {
  it("switches off bash service launch next to the managed models.yml", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: { MYRMIDON_OMP_PROVIDERS: JSON.stringify({ gw: { baseUrl: "http://gw/v1", api: "openai-completions" } }) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    expect(agentConfigDir).toBeTruthy();
    cleanupPaths.add(agentConfigDir);

    expect(OMP_MANAGED_SETTINGS_FILE).toBe("config.yml");
    const settings = await fs.readFile(path.join(agentConfigDir, "config.yml"), "utf8");
    expect(settings).toBe("launch:\n  enabled: false\n");
    await prepared.cleanup();
  });

  it("writes the same settings into any board-owned agent config dir", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-omp-settings-test-"));
    cleanupPaths.add(dir);
    await writeOmpManagedSettings(dir);
    expect(await fs.readFile(path.join(dir, "config.yml"), "utf8")).toBe("launch:\n  enabled: false\n");
  });

  it("still writes nothing when no provider config is set (the user's own omp dir is not touched)", async () => {
    const prepared = await prepareOmpRuntimeConfig({ env: {} });
    expect(prepared.agentConfigDir).toBeNull();
    await prepared.cleanup();
  });
});

describe("findProviderConfig", () => {
  it("prefers MYRMIDON_OMP_PROVIDERS over its PAPERCLIP_ alias in the same env", () => {
    expect(
      findProviderConfig({ PAPERCLIP_OMP_PROVIDERS: "{\"old\":{}}", MYRMIDON_OMP_PROVIDERS: "{\"new\":{}}" }, {}),
    ).toEqual({ name: "MYRMIDON_OMP_PROVIDERS", raw: "{\"new\":{}}" });
  });

  it("reads the run env before the process env", () => {
    expect(
      findProviderConfig({ PAPERCLIP_OMP_PROVIDERS: "run" }, { MYRMIDON_OMP_PROVIDERS: "process" }),
    ).toEqual({ name: "PAPERCLIP_OMP_PROVIDERS", raw: "run" });
  });

  it("takes an OMP variable from the process env before a PI variable from the run env", () => {
    expect(
      findProviderConfig({ MYRMIDON_PI_PROVIDERS: "pi" }, { MYRMIDON_OMP_PROVIDERS: "omp" }),
    ).toEqual({ name: "MYRMIDON_OMP_PROVIDERS", raw: "omp" });
  });

  it("returns null when nothing is set", () => {
    expect(findProviderConfig({}, {})).toBeNull();
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOmpRuntimeConfig } from "./runtime-config.js";

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
  it("is a no-op when PAPERCLIP_OMP_PROVIDERS and PAPERCLIP_PI_PROVIDERS are unset", async () => {
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
      env: { PAPERCLIP_OMP_PROVIDERS: JSON.stringify(providers) },
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

  it("falls back to PAPERCLIP_PI_PROVIDERS when PAPERCLIP_OMP_PROVIDERS is unset", async () => {
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
        PAPERCLIP_OMP_PROVIDERS: JSON.stringify(providers),
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
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:PAPERCLIP_OMP_TEST_KEY}" },
    };
    process.env.PAPERCLIP_OMP_TEST_KEY = "sk-from-process-env";
    try {
      const prepared = await prepareOmpRuntimeConfig({
        env: { PAPERCLIP_OMP_PROVIDERS: JSON.stringify(providers) },
      });
      const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
      cleanupPaths.add(agentConfigDir);
      const yml = await readModelsYml(agentConfigDir);
      expect(yml).toContain('apiKey: "sk-from-process-env"');
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_OMP_TEST_KEY;
    }
  });

  it("leaves an unresolvable {env:VAR} placeholder intact", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}" },
    };
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    const yml = await readModelsYml(agentConfigDir);
    expect(yml).toContain('apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}"');
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_OMP_PROVIDERS contains invalid JSON", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: "{not json" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_OMP_PROVIDERS contains invalid JSON; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_OMP_PROVIDERS is not a JSON object", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: "[1,2]" },
    });
    expect(prepared.notes).toEqual([
      "PAPERCLIP_OMP_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("ignores provider entries that are not objects and names them in the note", async () => {
    const prepared = await prepareOmpRuntimeConfig({
      env: { PAPERCLIP_OMP_PROVIDERS: JSON.stringify({ tensorix: "nope" }) },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.agentConfigDir).toBeNull();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_OMP_PROVIDERS: skipped provider(s) with non-object values: tensorix.",
    ]);
    await prepared.cleanup();
  });
});

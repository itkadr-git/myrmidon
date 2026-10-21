import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@myrmidonai/adapter-omp-local/server";

// myrmidon(OMP-LOCAL): targeted environment diagnostic test for omp_local

async function writeFakeOmpCommand(binDir: string, mode: "success" | "auth-required"): Promise<void> {
  const commandPath = path.join(binDir, "omp");
  const script =
    mode === "success"
      ? `#!/usr/bin/env node
if (process.argv.includes("models") && process.argv.includes("ls")) {
  console.log("provider  model");
  console.log("openai    gpt-4o");
  process.exit(0);
}
console.log(JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date().toISOString(), cwd: process.cwd() }));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({
  type: "turn_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } }
  },
  toolResults: []
}));
`
      : `#!/usr/bin/env node
if (process.argv.includes("models") && process.argv.includes("ls")) {
  console.error("auth required: OPENAI_API_KEY is not set");
  process.exit(1);
}
process.exit(1);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("omp_local environment diagnostics", () => {
  it("passes a hello probe when model discovery and execution succeed", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-omp-local-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakeOmpCommand(binDir, "success");

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "omp_local",
      config: {
        command: "omp",
        cwd,
        model: "openai/gpt-4o",
        env: {
          OPENAI_API_KEY: "test-key",
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "omp_models_discovered")).toBe(true);
    expect(result.checks.some((check) => check.code === "omp_hello_probe_passed")).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("surfaces auth required when provider credentials are missing", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-omp-local-auth-required-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakeOmpCommand(binDir, "auth-required");

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "omp_local",
      config: {
        command: "omp",
        cwd,
        model: "openai/gpt-4o",
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.checks.some((check) =>
      check.code === "omp_models_discovery_failed" || check.code === "omp_hello_probe_auth_required"
    )).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });
});

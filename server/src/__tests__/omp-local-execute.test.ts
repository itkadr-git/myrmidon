import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-omp-local/server";

// myrmidon(OMP-LOCAL): targeted execute tests for omp_local

async function writeFakeOmpCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
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
  message: { role: "assistant", content: [{ type: "text", text: "Done with task" }] },
  toolResults: []
}));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeEnvDumpOmpCommand(commandPath: string, envDumpPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("models") && process.argv.includes("ls")) {
  console.log("provider  model");
  console.log("openai    gpt-4o");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(envDumpPath)}, process.env.PATH || "");
console.log(JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date().toISOString(), cwd: process.cwd() }));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({
  type: "turn_end",
  message: { role: "assistant", content: [{ type: "text", text: "Env captured" }] },
  toolResults: []
}));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("omp_local execute", () => {
  it("executes successfully with a configured model and returns completed turn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-omp-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "omp");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeOmpCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-omp-test-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OMP Agent",
          adapterType: "omp_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-4o",
          promptTemplate: "Do the work.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prepends installed skill bin/ dirs to the spawned OMP child PATH", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-omp-path-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "omp");
    const skillDir = path.join(root, "skills", "demo-skill");
    const skillBinDir = path.join(skillDir, "bin");
    const envDumpPath = path.join(root, "env-path.txt");

    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(skillBinDir, { recursive: true });
    await writeEnvDumpOmpCommand(commandPath, envDumpPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-omp-skill-path",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OMP Skill Agent",
          adapterType: "omp_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-4o",
          promptTemplate: "Work.",
        },
        context: {
          paperclipSkills: [
            {
              name: "demo-skill",
              path: skillDir,
            },
          ],
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const dumpedPath = await fs.readFile(envDumpPath, "utf8");
      expect(dumpedPath.split(path.delimiter)[0]).toBe(skillBinDir);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

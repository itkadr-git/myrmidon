import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@myrmidon/adapter-omp-local/server";
import { RunGuard, type RunGuardStopReason } from "@myrmidon/adapter-utils";
import { buildRunGuardHintMessage } from "@myrmidon/adapter-utils/run-guard-hint";

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

// myrmidon(OMP-RUN-GUARD): an omp session that never ends by itself. It makes one
// write and 135 model calls, waits for the board's message in the steer file the
// way the steer extension does, reports what it read, makes 20 more model calls
// and then idles for a minute. Only the run guard ends it within the test.
async function writeEndlessOmpCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("models") && process.argv.includes("ls")) {
  console.log("provider  model");
  console.log("openai    gpt-4o");
  process.exit(0);
}
const emit = (event) => console.log(JSON.stringify(event));
const steerFile = process.env.MYRMIDON_OMP_STEER_FILE || "";
const extensionIndex = process.argv.indexOf("--extension");
emit({ type: "session", version: 3, id: "session-1", timestamp: new Date().toISOString(), cwd: process.cwd() });
emit({ type: "agent_start" });
emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "edit", args: { path: "a.ts" } });
for (let call = 0; call < 135; call += 1) emit({ type: "turn_start" });
const startedAt = Date.now();
const wait = setInterval(() => {
  let text = null;
  try {
    text = fs.readFileSync(steerFile, "utf8");
  } catch {}
  if (text === null && Date.now() - startedAt < 10000) return;
  clearInterval(wait);
  emit({ type: "steer_seen", text, extension: extensionIndex >= 0 ? process.argv[extensionIndex + 1] : null });
  for (let call = 0; call < 20; call += 1) emit({ type: "turn_start" });
  setTimeout(() => {
    emit({ type: "agent_end", messages: [] });
    process.exit(0);
  }, 60000);
}, 25);
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

  // myrmidon(OMP-RUN-GUARD): before this an omp run had no model call limit: the
  // session below would run for its whole minute and end as a success.
  it("hints the session 15 model calls before the limit and stops the process on the first call past it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-omp-run-guard-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "omp");
    await fs.mkdir(workspace, { recursive: true });
    await writeEndlessOmpCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    const guard = new RunGuard();
    const stops: RunGuardStopReason[] = [];
    const startedAt = Date.now();

    try {
      const result = await execute({
        runId: "run-omp-guard-1",
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
          graceSec: 2,
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        runGuard: guard,
        onRunGuardStop: async (reason) => {
          stops.push(reason);
        },
      });

      // The process was ended by the guard, long before its own minute was over.
      expect(Date.now() - startedAt).toBeLessThan(30_000);
      expect(stops).toEqual(["model_call_limit"]);
      expect(result.errorCode).toBe("model_call_limit");
      expect(result.errorMessage).toBe("OMP was stopped by the run guard: model_call_limit.");
      expect(result.exitCode).not.toBe(0);
      expect(guard.stats()).toMatchObject({ modelCalls: 150, writeCalls: 1 });

      // The session read the wrap-up message while it was running, through the
      // steer file the adapter named and next to the extension it loaded.
      const stdout = String((result.resultJson as { stdout?: unknown } | null | undefined)?.stdout ?? "");
      const steerSeen = stdout
        .split("\n")
        .filter((line) => line.includes('"steer_seen"'))
        .map((line) => JSON.parse(line) as { text: string | null; extension: string | null });
      expect(steerSeen).toHaveLength(1);
      expect(steerSeen[0]!.text).toBe(
        buildRunGuardHintMessage({ reason: "model_call_limit", modelCalls: 135, remaining: 15 }),
      );
      expect(steerSeen[0]!.extension).toBe(
        path.join(root, ".omp", "paperclips", "company-1", "agent-1", ".myrmidon", "myrmidon-steer.js"),
      );
      expect(await fs.readFile(steerSeen[0]!.extension!, "utf8")).toContain("MYRMIDON_OMP_STEER_FILE");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runSshCommand } = vi.hoisted(() => ({
  runSshCommand: vi.fn(async (_spec: unknown, _command: string, _options?: unknown) => ({ stdout: "", stderr: "" })),
}));

vi.mock("./ssh.js", () => ({ runSshCommand }));

import {
  SSH_REMOTE_RUN_TAG_ENV,
  buildSshRemoteRunStopScript,
  describeSshRemoteRunStop,
  parseSshRemoteRunStopOutput,
  terminateSshRemoteRun,
} from "./ssh-remote-run-stop.js";

const spec = {
  host: "127.0.0.1",
  port: 2222,
  username: "fixture",
  remoteWorkspacePath: "/workspace",
  remoteCwd: "/workspace",
  privateKey: "PRIVATE KEY",
  knownHosts: "KNOWN HOSTS",
  strictHostKeyChecking: true,
};

function runScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("sh", ["-c", script], { timeout: 30_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isAlive(child)) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// myrmidon(OPE-12801)
describe("ssh remote run stop", () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    while (children.length > 0) {
      const child = children.pop();
      if (child && isAlive(child)) child.kill("SIGKILL");
    }
  });

  function spawnTagged(runTag: string, shellScript: string): ChildProcess {
    // detached: the process leaves the test's session and process group, like
    // a daemon that left the agent CLI's group on the runner.
    const child = spawn("sh", ["-c", shellScript], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", [SSH_REMOTE_RUN_TAG_ENV]: runTag },
      detached: true,
      stdio: "ignore",
    });
    children.push(child);
    return child;
  }

  it("rejects a tag that is not a plain identifier", () => {
    expect(() => buildSshRemoteRunStopScript({ runTag: "run'; rm -rf /" })).toThrow("Invalid remote run tag");
    expect(() => buildSshRemoteRunStopScript({ runTag: "" })).toThrow("Invalid remote run tag");
  });

  it("parses the runner's report", () => {
    expect(parseSshRemoteRunStopOutput("noise\nmyrmidon_remote_stop found=3 survivors=0 forced=1 pids=\n")).toEqual({
      ok: true,
      found: 3,
      survivors: 0,
      forced: true,
      survivorPids: [],
      error: null,
    });
    expect(parseSshRemoteRunStopOutput("myrmidon_remote_stop found=2 survivors=1 forced=1 pids=4242\n")).toMatchObject({
      ok: false,
      survivors: 1,
      survivorPids: [4242],
    });
    expect(parseSshRemoteRunStopOutput("")).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it.runIf(process.platform === "linux")(
    "stops the run's processes, including one that left the process group, and leaves another run alone",
    async () => {
      const runTag = `stop-test-${process.pid}-${Date.now()}`;
      const otherTag = `${runTag}-other`;
      const main = spawnTagged(runTag, "sleep 300");
      const daemon = spawnTagged(runTag, "sleep 300 & wait");
      const other = spawnTagged(otherTag, "sleep 300");
      await new Promise((resolve) => setTimeout(resolve, 300));

      const report = parseSshRemoteRunStopOutput(await runScript(buildSshRemoteRunStopScript({ runTag, graceSec: 3 })));

      expect(report.error).toBeNull();
      expect(report.found).toBeGreaterThanOrEqual(3);
      expect(report.survivors).toBe(0);
      expect(report.ok).toBe(true);
      await waitForExit(main, 2_000);
      await waitForExit(daemon, 2_000);
      expect(isAlive(main)).toBe(false);
      expect(isAlive(daemon)).toBe(false);
      // A tag that only starts with the run's tag belongs to another run.
      expect(isAlive(other)).toBe(true);
    },
    20_000,
  );

  it.runIf(process.platform === "linux")(
    "kills a process that ignores TERM and reports that KILL was needed",
    async () => {
      const runTag = `stop-test-kill-${process.pid}-${Date.now()}`;
      const stubborn = spawnTagged(runTag, 'trap "" TERM; while :; do sleep 1; done');
      await new Promise((resolve) => setTimeout(resolve, 300));

      const report = parseSshRemoteRunStopOutput(await runScript(buildSshRemoteRunStopScript({ runTag, graceSec: 1 })));

      expect(report).toMatchObject({ ok: true, survivors: 0, forced: true, error: null });
      await waitForExit(stubborn, 2_000);
      expect(isAlive(stubborn)).toBe(false);
    },
    20_000,
  );

  it.runIf(process.platform === "linux")("reports nothing to stop when no process carries the tag", async () => {
    const report = parseSshRemoteRunStopOutput(
      await runScript(buildSshRemoteRunStopScript({ runTag: `stop-test-none-${process.pid}-${Date.now()}`, graceSec: 1 })),
    );
    expect(report).toEqual({ ok: true, found: 0, survivors: 0, forced: false, survivorPids: [], error: null });
  });

  it("runs the stop over ssh and returns the verified result", async () => {
    runSshCommand.mockResolvedValueOnce({ stdout: "myrmidon_remote_stop found=4 survivors=0 forced=0 pids=\n", stderr: "" });

    const report = await terminateSshRemoteRun({ spec, runTag: "run-1", graceSec: 5 });

    expect(report).toMatchObject({ ok: true, found: 4, survivors: 0 });
    expect(runSshCommand).toHaveBeenCalledTimes(1);
    const [calledSpec, script, options] = runSshCommand.mock.calls[0];
    expect(calledSpec).toBe(spec);
    expect(script).toContain(`tag='${SSH_REMOTE_RUN_TAG_ENV}=run-1'`);
    expect(script).toContain("kill -TERM");
    expect(script).toContain("kill -KILL");
    expect(options).toMatchObject({ timeoutMs: 25_000 });
    expect(describeSshRemoteRunStop(report)).toBe("Stopped 4 process(es) of the run on the SSH environment");
  });

  it("reports a failure instead of throwing when the runner cannot be reached or a process survives", async () => {
    runSshCommand.mockRejectedValueOnce(new Error("ssh: connect to host 127.0.0.1 port 2222: Connection refused\nmore"));
    const unreachable = await terminateSshRemoteRun({ spec, runTag: "run-2" });
    expect(unreachable.ok).toBe(false);
    expect(unreachable.error).toBe("ssh: connect to host 127.0.0.1 port 2222: Connection refused");
    expect(describeSshRemoteRunStop(unreachable)).toContain("Could not verify");

    runSshCommand.mockResolvedValueOnce({ stdout: "myrmidon_remote_stop found=2 survivors=1 forced=1 pids=777\n", stderr: "" });
    const survived = await terminateSshRemoteRun({ spec, runTag: "run-3" });
    expect(survived.ok).toBe(false);
    expect(describeSshRemoteRunStop(survived)).toContain("still alive");
    expect(describeSshRemoteRunStop(survived)).toContain("777");
  });
});

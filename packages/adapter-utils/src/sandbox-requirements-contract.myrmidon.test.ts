import { describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "./execution-target.js";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  maybeRunSandboxInstallCommand,
} from "./execution-target.js";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { buildSandboxNpmInstallCommand } from "./sandbox-install-command.js";

type RunnerExecutionInput = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

function createMockRunner(
  responses: Array<{
    exitCode?: number | null;
    timedOut?: boolean;
    stdout?: string;
    stderr?: string;
  }> = [],
) {
  let callIndex = 0;
  const calls: RunnerExecutionInput[] = [];

  const execute = vi.fn(async (input: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  }) => {
    calls.push({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
    });
    const response = responses[callIndex] ?? { exitCode: 0, stdout: "", stderr: "" };
    callIndex++;
    return {
      exitCode: response.exitCode !== undefined ? response.exitCode : 0,
      signal: null,
      timedOut: response.timedOut ?? false,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      pid: 1234,
      startedAt: new Date().toISOString(),
    };
  });

  return { execute, calls };
}

function makeTarget(
  runner: ReturnType<typeof createMockRunner>,
  overrides: Partial<AdapterSandboxExecutionTarget> = {},
): AdapterSandboxExecutionTarget {
  return {
    kind: "remote",
    transport: "sandbox",
    remoteCwd: "/workspace",
    runner: runner as unknown as CommandManagedRuntimeRunner,
    ...overrides,
  };
}

describe("SANDBOX-REQUIREMENTS.md contract", () => {
  describe("Detection contract", () => {
    it("Detection contract: probe uses exactly sh -c \"command -v '<cmd>'\"", async () => {
      const runner = createMockRunner([{ exitCode: 0, stdout: "/usr/bin/git\n" }]);
      const target = makeTarget(runner);

      await ensureAdapterExecutionTargetCommandResolvable("git", target, "/workspace", {});

      expect(runner.calls.length).toBe(1);
      expect(runner.calls[0].command).toBe("sh");
      expect(runner.calls[0].args).toEqual(["-c", "command -v 'git'"]);
    });

    it("Detection contract: CLI absent and no install command fails with 'Command \"<cmd>\" is not installed or not on PATH in the sandbox environment'", async () => {
      const runner = createMockRunner([{ exitCode: 1, stdout: "" }]);
      const target = makeTarget(runner);

      await expect(
        ensureAdapterExecutionTargetCommandResolvable("missing-cli", target, "/workspace", {}),
      ).rejects.toThrow(
        'Command "missing-cli" is not installed or not on PATH in the sandbox environment',
      );

      expect(runner.calls.length).toBe(1);
      expect(runner.calls[0].command).toBe("sh");
      expect(runner.calls[0].args).toEqual(["-c", "command -v 'missing-cli'"]);
    });
  });

  describe("Optional CLI installation", () => {
    it("Optional CLI installation: skips install when CLI is already on PATH (detectCommand succeeds)", async () => {
      const runner = createMockRunner([{ exitCode: 0, stdout: "/usr/bin/npm\n" }]);
      const target = makeTarget(runner);
      const onLog = vi.fn();

      await ensureAdapterExecutionTargetRuntimeCommandInstalled({
        runId: "test-run",
        target,
        detectCommand: "npm",
        installCommand: "apt-get update && apt-get install -y npm",
        cwd: "/workspace",
        env: {},
        onLog,
      });

      expect(runner.calls.length).toBe(1);
      expect(runner.calls[0].command).toBe("sh");
      expect(runner.calls[0].args).toEqual(["-c", "command -v 'npm' >/dev/null 2>&1"]);
      expect(onLog).not.toHaveBeenCalled();
    });

    it("Optional CLI installation: runs install command once via sh -c when CLI absent, followed by recheck probe", async () => {
      const runner = createMockRunner([
        { exitCode: 1, stdout: "" }, // probe before install fails
        { exitCode: 0, stdout: "install output" }, // install command
        { exitCode: 0, stdout: "/usr/local/bin/my-cli\n" }, // probe after install succeeds
      ]);
      const target = makeTarget(runner);

      await ensureAdapterExecutionTargetCommandResolvable("my-cli", target, "/workspace", {}, {
        installCommand: "install-my-cli",
      });

      expect(runner.calls.length).toBe(3);
      expect(runner.calls[0].command).toBe("sh");
      expect(runner.calls[0].args).toEqual(["-c", "command -v 'my-cli'"]);

      expect(runner.calls[1].command).toBe("sh");
      expect(runner.calls[1].args).toEqual(["-c", "install-my-cli"]);

      expect(runner.calls[2].command).toBe("sh");
      expect(runner.calls[2].args).toEqual(["-c", "command -v 'my-cli'"]);
    });

    it("Optional CLI installation: uses target.shellCommand (e.g. bash -c) when shellCommand is set to bash", async () => {
      const runner = createMockRunner([
        { exitCode: 1, stdout: "" }, // probe fails
        { exitCode: 0, stdout: "installed" }, // install
      ]);
      const target = makeTarget(runner, { shellCommand: "bash" });

      await ensureAdapterExecutionTargetRuntimeCommandInstalled({
        runId: "test-run",
        target,
        detectCommand: "tool",
        installCommand: "npm install -g tool",
        cwd: "/workspace",
        env: {},
      });

      expect(runner.calls.length).toBe(2);
      expect(runner.calls[0].command).toBe("bash");
      expect(runner.calls[0].args).toEqual(["-c", "command -v 'tool' >/dev/null 2>&1"]);

      expect(runner.calls[1].command).toBe("bash");
      expect(runner.calls[1].args).toEqual(["-c", "npm install -g tool"]);
    });
  });

  describe("Non-fatal install failures", () => {
    it("Optional CLI installation (Non-fatal install failures): maybeRunSandboxInstallCommand returns warn check on failed exit code and does not throw", async () => {
      const runner = createMockRunner([{ exitCode: 127, stderr: "apt-get: command not found" }]);
      const target = makeTarget(runner);

      const check = await maybeRunSandboxInstallCommand({
        runId: "test-run",
        target,
        adapterKey: "apt",
        installCommand: "apt-get install -y something",
      });

      expect(check).not.toBeNull();
      expect(check?.level).toBe("warn");
      expect(check?.message).toContain("Install command exited 127");
      expect(runner.calls.length).toBe(1);
    });

    it("Optional CLI installation (Non-fatal install failures): maybeRunSandboxInstallCommand returns warn check on runner exception and does not throw", async () => {
      const execute = vi.fn(async () => {
        throw new Error("Runner network disconnected");
      });
      const target = makeTarget({ execute, calls: [] } as any);

      const check = await maybeRunSandboxInstallCommand({
        runId: "test-run",
        target,
        adapterKey: "package",
        installCommand: "npm i -g package",
      });

      expect(check).not.toBeNull();
      expect(check?.level).toBe("warn");
      expect(check?.message).toBe("Install command threw before completion.");
      expect(check?.detail).toBe("Runner network disconnected");
    });

    it("Optional CLI installation (Non-fatal install failures): ensureAdapterExecutionTargetRuntimeCommandInstalled logs continuing message when install exits non-zero but CLI is on PATH", async () => {
      const runner = createMockRunner([
        { exitCode: 1, stdout: "" }, // install check probe fails
        { exitCode: 42, stderr: "non-fatal post-install warning" }, // install fails
        { exitCode: 0, stdout: "/usr/bin/tool\n" }, // detect probe succeeds
      ]);
      const target = makeTarget(runner);
      const onLog = vi.fn();

      await ensureAdapterExecutionTargetRuntimeCommandInstalled({
        runId: "test-run",
        target,
        detectCommand: "tool",
        installCommand: "install-tool-cmd",
        cwd: "/workspace",
        env: {},
        onLog,
      });

      expect(onLog).toHaveBeenCalledWith(
        "stderr",
        expect.stringMatching(/Install command exited 42 \(install-tool-cmd\) but tool is on PATH; continuing\./),
      );
    });

    it("Optional CLI installation (Non-fatal install failures): throws when install fails and CLI is not on PATH (расхождение с документом, см. PR)", async () => {
      // NOTE: Расхождение с документом, см. PR:
      // SANDBOX-REQUIREMENTS.md говорит:
      //   "The install command failure is NOT fatal by itself. If the subsequent CLI check passes
      //    (perhaps the binary was already on PATH or provided by a volume mount), the run continues.
      //    If the CLI check also fails, the run fails with the standard 'command not found' error."
      // Фактическое поведение платформы:
      //   Если CLI после сбоя установки не обнаружен, ensureAdapterExecutionTargetRuntimeCommandInstalled
      //   бросает сразу ошибку "Failed to install the adapter runtime command via: ...", а не стандартную "command not found" перед запуском.
      const runner = createMockRunner([
        { exitCode: 1, stdout: "" }, // probe fails
        { exitCode: 2, stderr: "EACCES" }, // install fails
        { exitCode: 1, stdout: "" }, // recheck probe fails
      ]);
      const target = makeTarget(runner);

      await expect(
        ensureAdapterExecutionTargetRuntimeCommandInstalled({
          runId: "test-run",
          target,
          detectCommand: "missing",
          installCommand: "npm install -g missing",
          cwd: "/workspace",
          env: {},
        }),
      ).rejects.toThrow("Failed to install the adapter runtime command via: npm install -g missing");
    });
  });

  describe("Firm rule", () => {
    const SHELL_PROFILE_WRITE_PATTERN =
      /(?:>>?|tee(?:\s+-[a-zA-Z]+)*\s+)[^\n\r;|]*\.(?:bash_profile|bashrc|profile|zprofile|zshrc|zshenv)\b/i;
    const NVM_PATTERN = /\bnvm\b/i;

    function assertCompliesWithFirmRule(script: string) {
      expect(script).not.toMatch(NVM_PATTERN);
      expect(script).not.toMatch(SHELL_PROFILE_WRITE_PATTERN);
    }

    it("Firm rule: buildSandboxNpmInstallCommand output does not contain nvm or write to shell profiles", () => {
      const command = buildSandboxNpmInstallCommand("@myrmidon/cli");
      assertCompliesWithFirmRule(command);
    });

    it("Firm rule: scripts passed to runner during detection and installation do not contain nvm or write to shell profiles", async () => {
      const runner = createMockRunner([
        { exitCode: 1, stdout: "" }, // probe fails
        { exitCode: 0, stdout: "" }, // install succeeds
        { exitCode: 0, stdout: "/bin/tool" }, // probe succeeds
      ]);
      const target = makeTarget(runner);

      const npmInstallCmd = buildSandboxNpmInstallCommand("some-package");

      await ensureAdapterExecutionTargetCommandResolvable("some-package", target, "/workspace", {}, {
        installCommand: npmInstallCmd,
      });

      expect(runner.calls.length).toBe(3);
      for (const call of runner.calls) {
        if (call.args) {
          for (const arg of call.args) {
            assertCompliesWithFirmRule(arg);
          }
        }
      }
    });

    it("Firm rule: assertions fail if script touches nvm or writes to shell profile", () => {
      // Manual verification test per acceptance criteria:
      // "Ложно, если тест «Firm rule» остаётся зелёным при подстановке в проверяемый скрипт строки
      //  echo 'export PATH=/x:$PATH' >> \"$HOME/.bashrc\" или . \"$HOME/.nvm/nvm.sh\""
      const profileMutationScript = 'echo \'export PATH=/x:$PATH\' >> "$HOME/.bashrc"';
      expect(() => assertCompliesWithFirmRule(profileMutationScript)).toThrow();

      const nvmSourceScript = '. "$HOME/.nvm/nvm.sh"';
      expect(() => assertCompliesWithFirmRule(nvmSourceScript)).toThrow();
    });
  });
});

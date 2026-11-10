import { describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "./execution-target.js";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  maybeRunSandboxInstallCommand,
} from "./execution-target.js";
import { buildSandboxNpmInstallCommand } from "./sandbox-install-command.js";

function createMockRunner(
  responses: Array<{
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  }> = [],
) {
  let callIndex = 0;
  const calls: Array<{ command: string; args: string[] }> = [];

  const execute = vi.fn(async (command: string, args: string[]) => {
    calls.push({ command, args });
    const response = responses[callIndex] ?? { exitCode: 0, stdout: "", stderr: "" };
    callIndex++;
    return {
      exitCode: response.exitCode ?? 0,
      signal: null,
      timedOut: false,
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
    runner: runner as any,
    ...overrides,
  };
}

describe("SANDBOX-REQUIREMENTS.md contract", () => {
  describe("Detection contract", () => {
    it("Detection contract: probe uses exactly sh -c \"command -v '<cmd>'\"", async () => {
      const runner = createMockRunner([{ exitCode: 0, stdout: "/usr/bin/git\n" }]);
      const target = makeTarget(runner);

      await ensureAdapterExecutionTargetCommandResolvable("test-run", target, "git");

      expect(runner.calls.length).toBe(1);
      expect(runner.calls[0].command).toBe("sh");
      expect(runner.calls[0].args).toEqual(["-c", "command -v 'git'"]);
    });

    it("Detection contract: CLI absent and no install command fails with 'Command \"<cmd>\" is not installed or not on PATH in the sandbox environment'", async () => {
      const runner = createMockRunner([{ exitCode: 1, stdout: "" }]);
      const target = makeTarget(runner);

      await expect(
        ensureAdapterExecutionTargetCommandResolvable("test-run", target, "missing-cli"),
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
        onLog,
      });

      expect(runner.calls.length).toBe(1);
      expect(runner.calls[0].command).toBe("sh");
      expect(runner.calls[0].args).toEqual(["-c", "command -v 'npm'"]);
      expect(onLog).toHaveBeenCalledWith(expect.stringContaining("npm is on PATH; continuing."));
    });

    it("Optional CLI installation: runs install command once via sh -c when CLI absent, followed by recheck probe", async () => {
      const runner = createMockRunner([
        { exitCode: 1, stdout: "" }, // probe before install fails
        { exitCode: 0, stdout: "install output" }, // install command
        { exitCode: 0, stdout: "/usr/local/bin/my-cli\n" }, // probe after install succeeds
      ]);
      const target = makeTarget(runner);

      await ensureAdapterExecutionTargetCommandResolvable("test-run", target, "my-cli", {
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

    it("Optional CLI installation: uses target.shellCommand (e.g. bash -c) for install command and probe", async () => {
      const runner = createMockRunner([
        { exitCode: 1, stdout: "" }, // probe fails
        { exitCode: 0, stdout: "installed" }, // install
        { exitCode: 0, stdout: "/bin/tool\n" }, // recheck probe succeeds
      ]);
      const target = makeTarget(runner, { shellCommand: "bash" });

      await ensureAdapterExecutionTargetCommandResolvable("test-run", target, "tool", {
        installCommand: "npm install -g tool",
      });

      expect(runner.calls.length).toBe(3);
      expect(runner.calls[0].command).toBe("bash");
      expect(runner.calls[0].args).toEqual(["-c", "command -v 'tool'"]);

      expect(runner.calls[1].command).toBe("bash");
      expect(runner.calls[1].args).toEqual(["-c", "npm install -g tool"]);

      expect(runner.calls[2].command).toBe("bash");
      expect(runner.calls[2].args).toEqual(["-c", "command -v 'tool'"]);
    });
  });

  describe("Non-fatal install failures", () => {
    it("Optional CLI installation (Non-fatal install failures): maybeRunSandboxInstallCommand returns warn check on failed exit code and does not throw", async () => {
      const runner = createMockRunner([{ exitCode: 127, stderr: "apt-get: command not found" }]);
      const target = makeTarget(runner);

      const check = await maybeRunSandboxInstallCommand(
        "test-run",
        target,
        "apt-get install -y something",
        "apt",
      );

      expect(check).not.toBeNull();
      expect(check?.status).toBe("warn");
      expect(check?.message).toContain("Sandbox command installation failed for apt");
      expect(runner.calls.length).toBe(1);
    });

    it("Optional CLI installation (Non-fatal install failures): maybeRunSandboxInstallCommand returns warn check on runner exception and does not throw", async () => {
      const execute = vi.fn(async () => {
        throw new Error("Runner network disconnected");
      });
      const target = makeTarget({ execute, calls: [] } as any);

      const check = await maybeRunSandboxInstallCommand(
        "test-run",
        target,
        "npm i -g package",
        "package",
      );

      expect(check).not.toBeNull();
      expect(check?.status).toBe("warn");
      expect(check?.message).toContain("Sandbox command installation threw an error for package");
    });

    it("Optional CLI installation (Non-fatal install failures): ensureAdapterExecutionTargetRuntimeCommandInstalled logs continuing message when install exits non-zero but CLI is on PATH", async () => {
      const runner = createMockRunner([
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
        onLog,
      });

      expect(onLog).toHaveBeenCalledWith(
        expect.stringMatching(/Install command exited 42 .* but tool is on PATH; continuing\./),
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
      //   бросает сразу ошибку "Install command failed with exit code ...", а не стандартную "command not found".
      const runner = createMockRunner([
        { exitCode: 2, stderr: "EACCES" }, // install fails
        { exitCode: 1, stdout: "" }, // detectCommand fails
      ]);
      const target = makeTarget(runner);

      await expect(
        ensureAdapterExecutionTargetRuntimeCommandInstalled({
          runId: "test-run",
          target,
          detectCommand: "missing",
          installCommand: "npm install -g missing",
        }),
      ).rejects.toThrow(/Install command exited 2/);
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

      await ensureAdapterExecutionTargetCommandResolvable("test-run", target, "some-package", {
        installCommand: npmInstallCmd,
      });

      expect(runner.calls.length).toBe(3);
      for (const call of runner.calls) {
        for (const arg of call.args) {
          assertCompliesWithFirmRule(arg);
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

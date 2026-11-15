import { resolve, isAbsolute, join, dirname, delimiter } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";

import {
  githubCredentialEnvironmentKeys,
} from "../../github-credential-environment.js";

/** DNS and CA files can point outside the minimal /etc filesystem (systemd). */
export function codexNetworkReadOnlyRoots(source: NodeJS.ProcessEnv): string[] {
  if (!codexNetworkAccess(source)) return [];
  const roots = new Set<string>();
  if (source.PAPERCLIP_RUNNER_NETWORK_ROOTS !== undefined) {
    try {
      const projected: unknown = JSON.parse(source.PAPERCLIP_RUNNER_NETWORK_ROOTS);
      if (Array.isArray(projected)) for (const root of projected) {
        if (typeof root === "string" && isAbsolute(root) && resolve(root) !== "/") roots.add(resolve(root));
      }
    } catch { /* A malformed controller projection must not expand access. */ }
  } else {
    for (const file of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ssl/certs", "/etc/ssl/cert.pem"]) {
      try { roots.add(realpathSync(file)); } catch { /* Platform-specific optional resource. */ }
    }
  }
  return [...roots];
}

/** Resolve executable resources only, without exposing their enclosing home. */
export function codexExecutableReadOnlyRoots(source: NodeJS.ProcessEnv, command = "codex"): string[] {
  const roots = new Set<string>();
  const add = (path: string) => {
    try {
      if (!isAbsolute(path) || resolve(path) === "/" || !existsSync(path)) return;
      roots.add(resolve(path));
      roots.add(realpathSync(path));
    } catch { /* Missing resources remain a normal executable-resolution error. */ }
  };
  add(process.execPath);
  const candidates = isAbsolute(command) ? [command]
    : (source.PATH ?? "").split(delimiter).filter(isAbsolute).map(root => resolve(root, command));
  const executable = candidates.find(path => {
    try { const stat = statSync(path); return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0); } catch { return false; }
  });
  if (!executable) return [...roots];
  add(executable);
  try {
    const canonical = realpathSync(executable);
    const manifestPath = resolve(dirname(canonical), "../package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.codex;
    if (manifest.name !== "@openai/codex" || typeof bin !== "string"
      || realpathSync(resolve(dirname(manifestPath), bin)) !== canonical) return [...roots];
    // The npm entrypoint launches the platform package's native executable,
    // which Codex invokes again inside bwrap when starting each shell command.
    const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
    if (manifest.optionalDependencies?.[platformPackage]) {
      const platformManifest = createRequire(manifestPath).resolve(`${platformPackage}/package.json`);
      const packageRoot = realpathSync(dirname(platformManifest));
      const vendor = realpathSync(resolve(packageRoot, "vendor"));
      if (vendor.startsWith(`${packageRoot}/`)) add(vendor);
    } else {
      const packageRoot = realpathSync(dirname(manifestPath));
      const vendor = realpathSync(resolve(packageRoot, "vendor"));
      if (vendor.startsWith(`${packageRoot}/`)) add(vendor);
    }
  } catch { /* Standalone executable installations need no npm resources. */ }
  return [...roots];
}

export const CODEX_SKILLLESS_PERMISSION_PROFILE =
  "paperclip-runner-workspace-only";
export const CODEX_PLANNING_PERMISSION_PROFILE =
  "paperclip-runner-workspace-read-only";
export const CODEX_EXTERNAL_SANDBOX_PERMISSION_PROFILE =
  "paperclip-runner-external-sandbox";

export function codexNetworkAccess(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.PAPERCLIP_RUNNER_NETWORK_ACCESS === "enabled";
}

/**
 * The Codex Linux sandbox (`bwrap`) needs unprivileged user namespaces. When the
 * host kernel or container seccomp/AppArmor profile denies `clone`/`unshare`,
 * every Codex thread/start dies with an opaque bwrap namespace error instead of
 * a diagnosable run failure. Probe the exact helper once per process and let the
 * caller refuse session startup with `codex_sandbox_unavailable` plus operator
 * guidance. The probe itself runs inside the bwrap sandbox (no writes, no
 * network), so a passing probe proves only sandbox availability.
 */
export const CODEX_SANDBOX_UNAVAILABLE = "codex_sandbox_unavailable";

export function codexSandboxUnavailableError(): Error {
  const error = new Error(
    `${CODEX_SANDBOX_UNAVAILABLE}: the Codex sandbox (bwrap) cannot create a user namespace in this environment. ` +
      "Unprivileged user namespaces are required for the native runner's Codex sandbox (it must not be disabled: " +
      "without it Codex reads board-container secrets). Fix the board container runtime, then retry the run: " +
      'run the container with `--security-opt seccomp=<path to myrmidon-board-userns.json>` and ' +
      "`--security-opt apparmor=unconfined` (docker-default AppArmor denies the mount operations bwrap needs), " +
      "and make sure the kernel allows unprivileged user namespaces " +
      "(check sysctl kernel.apparmor_restrict_unprivileged_userns and user.max_user_namespaces).",
  );
  error.name = "CodexSandboxUnavailableError";
  return error;
}

let userNamespaceProbe: boolean | null = null;

function probeCodexSandboxOnce(command: string): boolean {
  if (process.platform !== "linux") return true;
  try {
    execFileSync(command, ["--unshare-user", "--", "true"], {
      timeout: 10_000,
      stdio: "ignore",
      env: { ...process.env, CODEX_SANDBOX_PROBE: "1" },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe whether the Codex fs sandbox helper can actually create a user
 * namespace before a thread is started against it. The result is cached for the
 * process: a kernel or container profile does not change mid-run, and a session
 * must not pay a second helper spawn after a terminal refusal.
 */
export function checkUserNamespacesAvailable(
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  if (usesExternalRunnerSandbox(source)) return true;
  if (process.platform !== "linux") return true;
  if (userNamespaceProbe === null) {
    userNamespaceProbe = probeCodexSandboxOnce(
      // myrmidon(REBRAND-C): our knob, MYRMIDON_ name first; PAPERCLIP_ is the deprecated alias.
      source.MYRMIDON_RUNNER_SANDBOX_COMMAND?.trim() || source.PAPERCLIP_RUNNER_SANDBOX_COMMAND?.trim() || "bwrap",
    );
  }
  return userNamespaceProbe;
}

/** Test hook: reset the cached namespace probe between scenarios. */
export function resetUserNamespaceProbeForTests(): void {
  userNamespaceProbe = null;
}

/**
 * Test hook: preset the cached namespace probe. The package test setup passes it,
 * so driver tests against a fake app-server do not spawn the host `bwrap` (CI
 * hosts deny unprivileged user namespaces); the probe tests reset it first.
 */
export function setUserNamespaceProbeForTests(available: boolean | null): void {
  userNamespaceProbe = available;
}

function gitFilesystemRoots(source: NodeJS.ProcessEnv): { read: string[]; write: string[] } {
  const read: string[] = [];
  const write: string[] = [];
  try {
    const roots: unknown = JSON.parse(source.PAPERCLIP_GIT_METADATA_ROOTS ?? "[]");
    if (Array.isArray(roots)) for (const root of roots) {
      if (typeof root === "string" && isAbsolute(root) && resolve(root) !== "/") write.push(resolve(root));
    }
  } catch { /* Older controllers do not project Git metadata roots. */ }
  if (source.PAPERCLIP_GITHUB_AUTH_MODE === "host" && source.PAPERCLIP_GITHUB_HOST_HOME) {
    for (const relative of [".gitconfig", ".git-credentials", ".config/git", ".config/gh", ".ssh"]) {
      read.push(join(source.PAPERCLIP_GITHUB_HOST_HOME, relative));
    }
    for (const root of [source.GH_CONFIG_DIR, source.GIT_CONFIG_GLOBAL, source.GIT_CONFIG_SYSTEM, source.SSH_AUTH_SOCK]) {
      if (root && isAbsolute(root) && resolve(root) !== "/") read.push(resolve(root));
    }
  }
  return { read: [...new Set(read)], write: [...new Set(write)] };
}

function usesExternalRunnerSandbox(source: NodeJS.ProcessEnv): boolean {
  return source.PAPERCLIP_RUNNER_EXTERNAL_SANDBOX === "1";
}

const SKILLLESS_BASE_CONFIG = {
  "skills.include_instructions": false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: true,
  "features.apps": false,
  "features.plugins": false,
  "features.multi_agent": false,
  "features.memories": false,
  "features.image_generation": false,
} as const;

export function codexCommandEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "LANG",
    "LC_ALL",
  ] as const) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  if (source.PAPERCLIP_GITHUB_AUTH_MODE === "host" && source.PAPERCLIP_GITHUB_HOST_HOME) {
    environment.HOME = source.PAPERCLIP_GITHUB_HOST_HOME;
  } else if (source.PAPERCLIP_GITHUB_LAUNCHER_DIR) {
    environment.HOME = source.PAPERCLIP_GITHUB_LAUNCHER_DIR;
    environment.ZDOTDIR = source.PAPERCLIP_GITHUB_LAUNCHER_DIR;
    environment.BASH_ENV = `${source.PAPERCLIP_GITHUB_LAUNCHER_DIR}/.bashrc`;
  }
  return environment;
}

export function createSkilllessCodexThreadConfig(
  _workingDirectory: string,
  _source: NodeJS.ProcessEnv = process.env,
  includeCollaborationModeInstructions = true,
): Record<string, unknown> {
  return {
    ...SKILLLESS_BASE_CONFIG,
    include_collaboration_mode_instructions:
      includeCollaborationModeInstructions,
  };
}

function collaborationThreadConfig(
  includeCollaborationModeInstructions = true,
  includeSkillInstructions = false,
) {
  return {
    ...SKILLLESS_BASE_CONFIG,
    "skills.include_instructions": includeSkillInstructions,
    include_collaboration_mode_instructions:
      includeCollaborationModeInstructions,
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function createIsolatedCodexAppServerArgs(
  source: NodeJS.ProcessEnv = process.env,
  readOnlyRoots: string[] = [],
): string[] {
  const gitRoots = gitFilesystemRoots(source);
  readOnlyRoots = [...new Set([...readOnlyRoots, ...codexNetworkReadOnlyRoots(source)])];
  const networkAccess = codexNetworkAccess(source);
  const externalRunnerSandbox = usesExternalRunnerSandbox(source);
  const inheritedGitHubKeys = githubCredentialEnvironmentKeys(source);
  const hasProjectedEnvironment = inheritedGitHubKeys.length > 0;
  // Codex filters the configured `set` values through include_only as well.
  // Retain the explicit command PATH/HOME/locale settings, not ambient secrets.
  const commandEnvironment = codexCommandEnvironment(source);
  const shellEnvironmentKeys = [...new Set([...inheritedGitHubKeys, ...Object.keys(commandEnvironment)])].sort();
  if (source.PAPERCLIP_GITHUB_LAUNCHER_DIR) readOnlyRoots = [...readOnlyRoots, source.PAPERCLIP_GITHUB_LAUNCHER_DIR];
  const deniedHostRoots = [
    ...new Set(
      [source.HOME, source.CODEX_HOME]
        .filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
        .map((value) => resolve(value)),
    ),
  ];
  const filesystemRules = [
    `":root"="none"`,
    `":minimal"="read"`,
    `":tmpdir"="none"`,
    ...deniedHostRoots.map((path) => `${tomlString(path)}="none"`),
    ...readOnlyRoots.map((path) => `${tomlString(resolve(path))}="read"`),
    ...gitRoots.read.map((path) => `${tomlString(path)}="read"`),
    ...gitRoots.write.map((path) => `${tomlString(path)}="write"`),
    ...(source.PAPERCLIP_GITHUB_BROKER_TOKEN && source.GH_CONFIG_DIR
      ? [`${tomlString(resolve(source.GH_CONFIG_DIR))}="write"`] : []),
    `":workspace_roots"={"."="write"}`,
  ].join(",");
  const planningFilesystemRules = [
    `":root"="none"`,
    `":minimal"="read"`,
    `":tmpdir"="none"`,
    ...deniedHostRoots.map((path) => `${tomlString(path)}="none"`),
    ...readOnlyRoots.map((path) => `${tomlString(resolve(path))}="read"`),
    ...[...gitRoots.read, ...gitRoots.write].map((path) => `${tomlString(path)}="read"`),
    ...(source.PAPERCLIP_GITHUB_BROKER_TOKEN && source.GH_CONFIG_DIR
      ? [`${tomlString(resolve(source.GH_CONFIG_DIR))}="write"`] : []),
    `":workspace_roots"={"."="read"}`,
  ].join(",");
  const commandEnv = Object.entries(commandEnvironment)
    .map(([key, value]) => `${key}=${tomlString(value)}`)
    .join(",");
  const defaultPermissionProfile = externalRunnerSandbox
    ? CODEX_EXTERNAL_SANDBOX_PERMISSION_PROFILE
    : CODEX_SKILLLESS_PERMISSION_PROFILE;
  return [
    "-c",
    `default_permissions=${tomlString(defaultPermissionProfile)}`,
    "-c",
    `permissions.${CODEX_SKILLLESS_PERMISSION_PROFILE}.filesystem={${filesystemRules}}`,
    "-c",
    `permissions.${CODEX_SKILLLESS_PERMISSION_PROFILE}.network.enabled=${networkAccess}`,
    ...(externalRunnerSandbox
      ? [
          "-c",
          `permissions.${CODEX_EXTERNAL_SANDBOX_PERMISSION_PROFILE}.filesystem={":root"="write"}`,
          "-c",
          `permissions.${CODEX_EXTERNAL_SANDBOX_PERMISSION_PROFILE}.network.enabled=${networkAccess}`,
        ]
      : []),
    "-c",
    `permissions.${CODEX_PLANNING_PERMISSION_PROFILE}.filesystem={${planningFilesystemRules}}`,
    "-c",
    `permissions.${CODEX_PLANNING_PERMISSION_PROFILE}.network.enabled=${networkAccess}`,
    "-c",
    `shell_environment_policy.inherit=${tomlString(hasProjectedEnvironment ? "all" : "none")}`,
    "-c",
    `shell_environment_policy.ignore_default_excludes=${hasProjectedEnvironment}`,
    // Codex applies include_only after inheritance. Always emit the bounded
    // allowlist: neither host mode nor a broker enables ambient secret access.
    // Keep values in the process environment, never in argv/config diagnostics.
    "-c",
    `shell_environment_policy.include_only=${JSON.stringify(shellEnvironmentKeys)}`,
    ...(commandEnv.length > 0
      ? ["-c", `shell_environment_policy.set={${commandEnv}}`]
      : []),
    "--disable",
    "image_generation",
    ...(externalRunnerSandbox
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : []),
    "app-server",
  ];
}

export function createSecuredCodexThreadParams(
  workingDirectory: string,
  mode: "default" | "plan" = "default",
  includeCollaborationModeInstructions = true,
  includeSkillInstructions = false,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const permissionProfile =
    mode === "default" && usesExternalRunnerSandbox(source)
      ? CODEX_EXTERNAL_SANDBOX_PERMISSION_PROFILE
      : mode === "plan"
      ? CODEX_PLANNING_PERMISSION_PROFILE
      : CODEX_SKILLLESS_PERMISSION_PROFILE;
  return {
    cwd: workingDirectory,
    config: collaborationThreadConfig(
      includeCollaborationModeInstructions,
      includeSkillInstructions,
    ),
    permissions: permissionProfile,
    runtimeWorkspaceRoots: [workingDirectory],
  };
}

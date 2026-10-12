import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolveLegacyPaperclipDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  renderTemplate,
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
  isPaperclipRecoveryWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { myrmidonInheritedProcessEnv, readInheritProcessEnvFlag } from "@paperclipai/adapter-utils/myrmidon-run-env";
import {
  promptArgumentOverflowResult,
  writePromptFile,
  type PromptFile,
} from "@paperclipai/adapter-utils/myrmidon-prompt-transport";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { PRODUCT_NAME } from "@paperclipai/adapter-utils";
import { isOmpUnknownSessionError, parseOmpJsonl } from "./parse.js";
import { ensureOmpModelConfiguredAndAvailable } from "./models.js";
import { resolveOmpSkillsHome } from "./skills.js";
import { prepareOmpRuntimeConfig } from "./runtime-config.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function parseModelId(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return trimmed || null;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim() || null;
}

function resolveIsolatedSessionDir(companyId: string, agentId: string): string {
  return path.join(os.homedir(), ".omp", "paperclips", companyId, agentId);
}

function resolveRemoteIsolatedSessionDir(runtimeRootDir: string, companyId: string, agentId: string): string {
  return path.posix.join(runtimeRootDir, "sessions", companyId, agentId);
}

async function ensureOmpSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  targetSkillsDir: string,
  desiredSkillNames?: string[],
) {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  await fs.mkdir(targetSkillsDir, { recursive: true });
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    targetSkillsDir,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only OMP skill "${skillName}" from ${targetSkillsDir}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(targetSkillsDir, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} OMP skill "${entry.runtimeName}" into ${targetSkillsDir}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject OMP skill "${entry.runtimeName}" into ${targetSkillsDir}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function buildOmpSkillsDir(
  config: Record<string, unknown>,
  targetDir?: string,
  extraSkills: Array<{ key: string; runtimeName: string; source: string }> = [],
): Promise<string> {
  const target = targetDir ?? path.join(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-omp-skills-")), "skills");
  await fs.mkdir(target, { recursive: true });
  const configuredEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const availableEntries = [...extraSkills];
  for (const entry of configuredEntries) {
    if (!availableEntries.some((existing) => existing.key === entry.key)) {
      availableEntries.push(entry);
    }
  }
  const desiredNames = new Set([
    ...extraSkills.map((entry) => entry.key),
    ...resolveLegacyPaperclipDesiredSkillNames(config, availableEntries),
  ]);
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName)).catch(() => undefined);
  }
  return target;
}

function resolveOmpBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

function normalizeExecutionCwd(candidate: string, remote: boolean): string {
  return remote ? path.posix.normalize(candidate) : path.resolve(candidate);
}

function executionCwdsMatch(saved: string, current: string, remote: boolean): boolean {
  return normalizeExecutionCwd(saved, remote) === normalizeExecutionCwd(current, remote);
}

function readSessionHeaderCwd(raw: string): string | null {
  const headerLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!headerLine) return null;
  try {
    const parsed = JSON.parse(headerLine) as Record<string, unknown>;
    if (parsed.type !== "session") return null;
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd.trim() : "";
    return cwd.length > 0 ? cwd : null;
  } catch {
    return null;
  }
}

async function readSavedSessionCwd(input: {
  runId: string;
  sessionPath: string;
  executionTarget: ReturnType<typeof readAdapterExecutionTarget>;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<string | null> {
  if (!input.sessionPath.trim()) return null;

  if (!adapterExecutionTargetIsRemote(input.executionTarget)) {
    try {
      return readSessionHeaderCwd(await fs.readFile(input.sessionPath, "utf8"));
    } catch {
      return null;
    }
  }

  try {
    const sessionHeader = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.executionTarget,
      `if [ -f ${shellQuote(input.sessionPath)} ]; then head -n 1 ${shellQuote(input.sessionPath)}; fi`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec > 0 ? Math.min(input.timeoutSec, 15) : 15,
        graceSec: input.graceSec,
      },
    );
    if (sessionHeader.timedOut || (sessionHeader.exitCode ?? 0) !== 0) return null;
    return readSessionHeaderCwd(sessionHeader.stdout);
  } catch {
    return null;
  }
}

async function listSessionFiles(input: {
  runId: string;
  sessionDir: string;
  executionTarget: ReturnType<typeof readAdapterExecutionTarget>;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<string[]> {
  if (!adapterExecutionTargetIsRemote(input.executionTarget)) {
    try {
      const entries = await fs.readdir(input.sessionDir, { withFileTypes: true });
      const files: Array<{ path: string; mtime: number }> = [];
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const fullPath = path.join(input.sessionDir, entry.name);
          const stat = await fs.stat(fullPath);
          files.push({ path: fullPath, mtime: stat.mtimeMs });
        }
      }
      files.sort((a, b) => b.mtime - a.mtime);
      return files.map((f) => f.path);
    } catch {
      return [];
    }
  }

  try {
    const result = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.executionTarget,
      `if [ -d ${shellQuote(input.sessionDir)} ]; then ls -1t ${shellQuote(input.sessionDir)}/*.jsonl 2>/dev/null || true; fi`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec > 0 ? Math.min(input.timeoutSec, 15) : 15,
        graceSec: input.graceSec,
      },
    );
    if (result.timedOut || (result.exitCode ?? 0) !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.endsWith(".jsonl"));
  } catch {
    return [];
  }
}

async function findNewlyCreatedSessionFile(input: {
  runId: string;
  sessionDir: string;
  executionTarget: ReturnType<typeof readAdapterExecutionTarget>;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  existingSessionFiles: Set<string>;
}): Promise<string | null> {
  const currentFiles = await listSessionFiles(input);
  const newFiles = currentFiles.filter((f) => !input.existingSessionFiles.has(f));
  return newFiles.length > 0 ? newFiles[0] : null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "omp");
  const model = asString(config.model, "").trim();
  const thinking = asString(config.thinking, "").trim();

  const provider = parseModelProvider(model);
  const modelId = parseModelId(model);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const isolatedSessionDir = executionTargetIsRemote
    ? "" // resolved later once remoteRuntimeRootDir is known
    : resolveIsolatedSessionDir(agent.companyId, agent.id);

  if (!executionTargetIsRemote) {
    await fs.mkdir(isolatedSessionDir, { recursive: true });
  }

  // Build environment
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");

  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  // Materialize custom OMP providers into models.yml in managed PI_CODING_AGENT_DIR
  const preparedRuntimeConfig = await prepareOmpRuntimeConfig({ env });
  const localAgentConfigDir = preparedRuntimeConfig.agentConfigDir ?? "";
  if (localAgentConfigDir) {
    env.PI_CODING_AGENT_DIR = localAgentConfigDir;
    env.OMP_CODING_AGENT_DIR = localAgentConfigDir;
  }

  // Materialize skills in managed skills directory
  const rawContextSkills = Array.isArray((context as Record<string, unknown> | undefined)?.paperclipSkills)
    ? ((context as Record<string, unknown>).paperclipSkills as Array<Record<string, unknown>>)
    : [];
  const contextSkillEntries: Array<{ key: string; runtimeName: string; source: string }> = rawContextSkills
    .map((s) => {
      const name = typeof s?.name === "string" ? s.name.trim() : "";
      const skillPath = typeof s?.path === "string" ? s.path.trim() : "";
      if (!name || !skillPath) return null;
      return {
        key: name.toLowerCase(),
        runtimeName: name,
        source: path.resolve(skillPath),
      };
    })
    .filter((entry): entry is { key: string; runtimeName: string; source: string } => entry !== null);

  const configuredSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const ompSkillEntries = [...contextSkillEntries];
  for (const entry of configuredSkillEntries) {
    if (!ompSkillEntries.some((existing) => existing.key === entry.key)) {
      ompSkillEntries.push(entry);
    }
  }

  const legacyDesired = resolveLegacyPaperclipDesiredSkillNames(config, ompSkillEntries);
  const desiredOmpSkillNames = Array.from(
    new Set([
      ...contextSkillEntries.map((entry) => entry.key),
      ...legacyDesired,
    ]),
  );
  const targetSkillsDir = localAgentConfigDir
    ? path.join(localAgentConfigDir, "skills")
    : resolveOmpSkillsHome({ env });

  if (!executionTargetIsRemote) {
    await ensureOmpSkillsInjected(onLog, ompSkillEntries, targetSkillsDir, desiredOmpSkillNames);
  }

  try {
    const injectedSkillKeys = new Set(desiredOmpSkillNames);
    const candidateBinDirs = ompSkillEntries
      .filter((entry) => injectedSkillKeys.has(entry.key) && entry.source.length > 0)
      .map((entry) => path.join(entry.source, "bin"));
    const skillBinDirs = (
      await Promise.all(
        candidateBinDirs.map(async (binDir) => {
          try {
            const stat = await fs.stat(binDir);
            return stat.isDirectory() ? binDir : null;
          } catch {
            return null;
          }
        }),
      )
    ).filter((dir): dir is string => dir !== null);

    const mergedEnv = ensurePathInEnv({ ...myrmidonInheritedProcessEnv(config, "omp_local"), ...env });
    const pathKey =
      typeof mergedEnv.Path === "string" && mergedEnv.Path.length > 0 && !mergedEnv.PATH
        ? "Path"
        : "PATH";
    const basePath = mergedEnv[pathKey] ?? "";
    if (skillBinDirs.length > 0) {
      const existing = basePath.split(path.delimiter).filter(Boolean);
      const additions = skillBinDirs.filter((dir) => !existing.includes(dir));
      if (additions.length > 0) {
        mergedEnv[pathKey] = [...additions, basePath].filter(Boolean).join(path.delimiter);
      }
    }
    const runtimeEnv = Object.fromEntries(
      Object.entries(mergedEnv).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);

    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: SANDBOX_INSTALL_COMMAND,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    let loggedEnv = buildInvocationEnvForLogs(env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });

    if (!executionTargetIsRemote) {
      await ensureOmpModelConfiguredAndAvailable({
        model,
        command,
        cwd,
        env: runtimeEnv,
      });
    }

    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();

    let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
    let remoteRuntimeRootDir: string | null = null;
    let localSkillsDir: string | null = null;
    let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
    let managedRemoteAgentConfigDir: string | null = null;

    if (executionTargetIsRemote) {
      try {
        if (!localAgentConfigDir) {
          managedRemoteAgentConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-omp-agent-config-"));
        }
        const effectiveAgentConfigDir = localAgentConfigDir || managedRemoteAgentConfigDir!;
        const remoteSkillsStagingDir = path.join(effectiveAgentConfigDir, "skills");
        localSkillsDir = await buildOmpSkillsDir(config, remoteSkillsStagingDir, contextSkillEntries);

        await onLog(
          "stdout",
          `[paperclip] Syncing workspace and OMP runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        const preparedRemoteRuntime = await prepareAdapterExecutionTargetRuntime({
          runId,
          target: executionTarget,
          adapterKey: "omp",
          timeoutSec,
          workspaceLocalDir: cwd,
          installCommand: SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          onProgress: (line) => onLog("stdout", line),
          onRuntimeProgress: ctx.onRuntimeProgress,
          assets: [
            {
              key: "skills",
              localDir: localSkillsDir,
              followSymlinks: true,
            },
            {
              key: "agentConfig",
              localDir: effectiveAgentConfigDir,
              followSymlinks: true,
            },
          ],
        });
        restoreRemoteWorkspace = () =>
          preparedRemoteRuntime.restoreWorkspace((line) => onLog("stdout", line));
        effectiveExecutionCwd = preparedRemoteRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
        refreshPaperclipWorkspaceEnvForExecution({
          env,
          envConfig,
          workspaceCwd: effectiveWorkspaceCwd,
          workspaceSource,
          workspaceId,
          workspaceRepoUrl,
          workspaceRepoRef,
          workspaceHints,
          agentHome,
          executionTargetIsRemote,
          executionCwd: effectiveExecutionCwd,
        });
        if (adapterExecutionTargetUsesManagedHome(executionTarget) && preparedRemoteRuntime.runtimeRootDir) {
          env.HOME = preparedRemoteRuntime.runtimeRootDir;
        }
        remoteRuntimeRootDir = preparedRemoteRuntime.runtimeRootDir;
        if (preparedRemoteRuntime.assetDirs.agentConfig) {
          env.PI_CODING_AGENT_DIR = preparedRemoteRuntime.assetDirs.agentConfig;
          env.OMP_CODING_AGENT_DIR = preparedRemoteRuntime.assetDirs.agentConfig;
        }
      } catch (error) {
        await Promise.allSettled([
          restoreRemoteWorkspace?.(),
          managedRemoteAgentConfigDir ? fs.rm(managedRemoteAgentConfigDir, { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
        ]);
        throw error;
      }
    }

    const effectiveSessionDir = executionTargetIsRemote && remoteRuntimeRootDir
      ? resolveRemoteIsolatedSessionDir(remoteRuntimeRootDir, agent.companyId, agent.id)
      : isolatedSessionDir;

    if (executionTargetIsRemote && remoteRuntimeRootDir) {
      await ensureAdapterExecutionTargetDirectory(runId, executionTarget, effectiveSessionDir, {
        cwd,
        env,
        timeoutSec: 15,
        createIfMissing: true,
      });
    }

    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "omp",
        timeoutSec,
        hostApiToken: env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(env, paperclipBridge.env);
        loggedEnv = buildInvocationEnvForLogs(env, {
          runtimeEnv: Object.fromEntries(
            Object.entries(ensurePathInEnv({ ...myrmidonInheritedProcessEnv(config, "omp_local"), ...env })).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          includeRuntimeKeys: ["HOME"],
          resolvedCommand,
        });
      }
    }

    // Session resolution & isolation check
    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const sessionTargetMatches = adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const sessionParamsCwdMatches =
      runtimeSessionCwd.length === 0 ||
      executionCwdsMatch(runtimeSessionCwd, effectiveExecutionCwd, executionTargetIsRemote);

    // Verify session belongs to this agent and company (isolation)
    const normalizedSessionPath = runtimeSessionId.replace(/\\/g, "/");
    const isolatedLocalTree = "/.omp/paperclips/";
    const agentLocalSegment = `/.omp/paperclips/${agent.companyId}/${agent.id}`;
    const remoteSessionBase = remoteRuntimeRootDir
      ? path.posix.join(remoteRuntimeRootDir, "sessions")
      : null;
    const agentRemoteSegment = `/sessions/${agent.companyId}/${agent.id}`;
    const sessionBelongsToOtherAgent =
      (normalizedSessionPath.includes(isolatedLocalTree) &&
        !normalizedSessionPath.includes(agentLocalSegment)) ||
      (executionTargetIsRemote &&
        Boolean(remoteSessionBase && normalizedSessionPath.includes(remoteSessionBase)) &&
        !normalizedSessionPath.includes(agentRemoteSegment));

    const sessionBelongsToAgent = runtimeSessionId.length > 0 && !sessionBelongsToOtherAgent;

    const savedSessionCwd =
      runtimeSessionId.length > 0 && sessionBelongsToAgent
        ? await readSavedSessionCwd({
            runId,
            sessionPath: runtimeSessionId,
            executionTarget: runtimeExecutionTarget ?? null,
            cwd,
            env,
            timeoutSec,
            graceSec,
          })
        : null;

    const sessionHeaderCwdMatches =
      runtimeSessionId.length === 0 ||
      (savedSessionCwd !== null &&
        executionCwdsMatch(savedSessionCwd, effectiveExecutionCwd, executionTargetIsRemote));

    const canResumeSession =
      runtimeSessionId.length > 0 &&
      sessionBelongsToAgent &&
      sessionTargetMatches &&
      sessionParamsCwdMatches &&
      sessionHeaderCwdMatches;

    if (runtimeSessionId && !canResumeSession) {
      const staleSessionCwdNote =
        savedSessionCwd !== null && !sessionHeaderCwdMatches
          ? ` OMP stored cwd "${savedSessionCwd}" in the session header, so ${PRODUCT_NAME} will start a fresh session for "${effectiveExecutionCwd}".`
          : "";
      await onLog(
        "stdout",
        executionTargetIsRemote
          ? `[paperclip] OMP session "${runtimeSessionId}" does not match the current remote execution state and will not be resumed in "${effectiveExecutionCwd}".${staleSessionCwdNote} Starting a fresh remote session.\n`
          : `[paperclip] OMP session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".${staleSessionCwdNote}\n`,
      );
    }

    // Handle instructions file and build system prompt extension
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const resolvedInstructionsFilePath = instructionsFilePath
      ? path.resolve(cwd, instructionsFilePath)
      : "";
    const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";

    let systemPromptExtension = "";
    let instructionsReadFailed = false;
    if (resolvedInstructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
        systemPromptExtension =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsFileDir}.\n\n` +
          (context.conversationMode === true
            ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
            : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
      } catch (err) {
        instructionsReadFailed = true;
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
        );
        systemPromptExtension = promptTemplate;
      }
    } else {
      systemPromptExtension = promptTemplate;
    }

    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const renderedSystemPromptExtension = renderTemplate(systemPromptExtension, templateData);
    const renderedBootstrapPrompt =
      !canResumeSession && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const taskContextNote = context.conversationMode === true
      ? selectPaperclipTaskMarkdown(context, { resumedSession: canResumeSession })
      : "";
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
      conversationMode: context.conversationMode === true,
      resumedSession: canResumeSession,
      suppressIssueDescription: taskContextNote.length > 0,
    });
    const shouldUseResumeDeltaPrompt = canResumeSession && wakePrompt.length > 0;
    const renderedHeartbeatPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const userPrompt = joinPromptSections([
      renderedBootstrapPrompt,
      wakePrompt,
      taskContextNote,
      sessionHandoffNote,
      renderedHeartbeatPrompt,
    ]);
    const promptMetrics = {
      systemPromptChars: renderedSystemPromptExtension.length,
      promptChars: userPrompt.length,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      taskContextChars: taskContextNote.length,
      sessionHandoffChars: sessionHandoffNote.length,
      heartbeatPromptChars: renderedHeartbeatPrompt.length,
    };

    const commandNotes = (() => {
      const notes = [...preparedRuntimeConfig.notes];
      if (!resolvedInstructionsFilePath) return notes;
      if (instructionsReadFailed) {
        notes.push(
          `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
        );
        return notes;
      }
      notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
      notes.push(
        `Appended instructions + path directive to system prompt (relative references from ${instructionsFileDir}).`,
      );
      return notes;
    })();

    let systemPromptFile: PromptFile | null = null;

    // Build args: on first turn, DO NOT pass --session; pass --session-dir.
    // On resume, pass --session <sessionPath>.
    // Never pass --skill.
    const buildArgs = (sessionToResume: string | null): string[] => {
      const args: string[] = [];
      args.push("--mode", "json");
      args.push("-p");
      args.push("--append-system-prompt", systemPromptFile?.path ?? renderedSystemPromptExtension);

      if (provider) args.push("--provider", provider);
      if (modelId) args.push("--model", modelId);
      if (thinking) args.push("--thinking", thinking);

      args.push("--tools", "read,bash,edit,write,grep,find,ls");

      if (sessionToResume) {
        args.push("--session", sessionToResume);
      } else if (effectiveSessionDir) {
        args.push("--session-dir", effectiveSessionDir);
      }

      if (extraArgs.length > 0) args.push(...extraArgs);
      return args;
    };

    const runAttempt = async (sessionToResume: string | null) => {
      const args = buildArgs(sessionToResume);
      if (onMeta) {
        await onMeta({
          adapterType: "omp_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: [...args, `<stdin prompt ${userPrompt.length} chars>`],
          env: loggedEnv,
          prompt: userPrompt,
          promptMetrics,
          context,
        });
      }

      let stdoutBuffer = "";
      const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stderr") {
          await onLog(stream, chunk);
          return;
        }

        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          if (line) {
            await onLog(stream, line + "\n");
          }
        }
      };

      const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
        inheritProcessEnv: readInheritProcessEnvFlag(config),
        runEnvAdapterType: "omp_local",
        cwd,
        env: executionTargetIsRemote ? env : runtimeEnv,
        stdin: userPrompt,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog: bufferedOnLog,
        runLogTail: paperclipBridge?.runLogTail,
        settleRunDisposition: paperclipBridge?.settleRunDisposition,
      });

      if (stdoutBuffer) {
        await onLog("stdout", stdoutBuffer);
      }

      return {
        proc,
        rawStderr: proc.stderr,
        parsed: parseOmpJsonl(proc.stdout),
      };
    };

    let preRunSessionFiles = new Set<string>();

    const toResult = async (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; errorCode?: string | null };
        rawStderr: string;
        parsed: ReturnType<typeof parseOmpJsonl>;
      },
      resumedSessionPath: string | null,
      clearSessionOnMissingSession = false,
    ): Promise<AdapterExecutionResult> => {
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      // Discover or confirm session file
      let finalSessionPath: string | null = resumedSessionPath;
      if (!finalSessionPath && !clearSessionOnMissingSession) {
        finalSessionPath = await findNewlyCreatedSessionFile({
          runId,
          sessionDir: effectiveSessionDir,
          executionTarget: runtimeExecutionTarget ?? null,
          cwd,
          env: executionTargetIsRemote ? env : runtimeEnv,
          timeoutSec,
          graceSec,
          existingSessionFiles: preRunSessionFiles,
        });
      }

      const resolvedSessionId = clearSessionOnMissingSession ? null : finalSessionPath;
      const resolvedSessionParams = resolvedSessionId
        ? {
            sessionId: resolvedSessionId,
            cwd: effectiveExecutionCwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
            ...(executionTargetIsRemote
              ? {
                  remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
                }
              : {}),
          }
        : null;

      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const rawExitCode = attempt.proc.exitCode;
      const parsedError = attempt.parsed.errors.find((error) => error.trim().length > 0) ?? "";
      const effectiveExitCode = (rawExitCode ?? 0) === 0 && parsedError ? 1 : rawExitCode;
      const fallbackErrorMessage = parsedError || stderrLine || `OMP exited with code ${rawExitCode ?? -1}`;

      return {
        exitCode: effectiveExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: (effectiveExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
        errorCode: attempt.proc.errorCode ?? null,
        usage: {
          inputTokens: attempt.parsed.usage.inputTokens,
          outputTokens: attempt.parsed.usage.outputTokens,
          cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: provider,
        biller: resolveOmpBiller(runtimeEnv, provider),
        model: model,
        billingType: "unknown",
        costUsd: attempt.parsed.usage.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
        },
        summary: attempt.parsed.finalMessage ?? attempt.parsed.messages.join("\n\n").trim(),
        clearSession: Boolean(clearSessionOnMissingSession),
      };
    };

    try {
      if (executionTargetIsRemote) {
        const promptOverflow = promptArgumentOverflowResult("OMP system prompt", renderedSystemPromptExtension);
        if (promptOverflow) return promptOverflow;
      } else {
        systemPromptFile = await writePromptFile(renderedSystemPromptExtension, { fileName: "system-prompt.md" });
      }

      preRunSessionFiles = new Set(
        await listSessionFiles({
          runId,
          sessionDir: effectiveSessionDir,
          executionTarget: runtimeExecutionTarget ?? null,
          cwd,
          env: executionTargetIsRemote ? env : runtimeEnv,
          timeoutSec,
          graceSec,
        }),
      );

      const initialSessionToResume = canResumeSession ? runtimeSessionId : null;
      const initial = await runAttempt(initialSessionToResume);
      const initialFailed =
        !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || initial.parsed.errors.length > 0);

      if (
        canResumeSession &&
        initialFailed &&
        isOmpUnknownSessionError(initial.proc.stdout, initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] OMP session "${runtimeSessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        const retry = await runAttempt(null);
        return await toResult(retry, null, true);
      }

      return await toResult(initial, initialSessionToResume);
    } finally {
      await systemPromptFile?.cleanup().catch(() => undefined);
      await Promise.all([
        paperclipBridge?.stop(),
        restoreRemoteWorkspace?.(),
        managedRemoteAgentConfigDir ? fs.rm(managedRemoteAgentConfigDir, { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
      ]);
    }
  } finally {
    await preparedRuntimeConfig.cleanup();
  }
}

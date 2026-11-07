import { buildAdapterEnvConfig, type CreateConfigValues } from "@myrmidon/adapter-utils";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function buildClaudeLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.claudeEngine === "cli") ac.engine = "cli";
  if (v.claudeEngine === "acp") {
    ac.engine = "acp";
    if (v.claudeAcpAgentCommand) ac.agentCommand = v.claudeAcpAgentCommand;
    if (v.claudeAcpMode) ac.mode = v.claudeAcpMode;
    if (v.claudeAcpNonInteractivePermissions) {
      ac.nonInteractivePermissions = v.claudeAcpNonInteractivePermissions;
    }
    if (v.claudeAcpStateDir) ac.stateDir = v.claudeAcpStateDir;
    if (typeof v.claudeAcpWarmHandleIdleMs === "number") {
      ac.warmHandleIdleMs = v.claudeAcpWarmHandleIdleMs;
    }
  }
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.model) ac.model = v.model;
  if (v.thinkingEffort) ac.effort = v.thinkingEffort;
  if (v.chrome) ac.chrome = true;
  ac.timeoutSec = 0;
  ac.graceSec = 15;
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;
  ac.maxTurnsPerRun = v.maxTurnsPerRun;
  ac.dangerouslySkipPermissions = v.dangerouslySkipPermissions;
  if (v.workspaceStrategyType === "git_worktree") {
    ac.workspaceStrategy = {
      type: "git_worktree",
      ...(v.workspaceBaseRef ? { baseRef: v.workspaceBaseRef } : {}),
      ...(v.workspaceBranchTemplate ? { branchTemplate: v.workspaceBranchTemplate } : {}),
      ...(v.worktreeParentDir ? { worktreeParentDir: v.worktreeParentDir } : {}),
    };
  }
  const runtimeServices = parseJsonObject(v.runtimeServicesJson ?? "");
  if (runtimeServices && Array.isArray(runtimeServices.services)) {
    ac.workspaceRuntime = runtimeServices;
  }
  if (v.filesystemScope) ac.filesystemScope = v.filesystemScope;
  if (v.networkScope) ac.networkScope = v.networkScope;
  if (v.networkScope === "allowlist") ac.networkAllowlist = (v.networkAllowlist ?? "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs);
  // myrmidon(1.6.6 OPE-11239): sandbox and timeout settings from the Agent Settings form.
  const form = v.adapterSchemaValues ?? {};
  if (form.filesystemScope === "workspace") ac.filesystemScope = "workspace";
  if (Array.isArray(form.filesystemExtraPaths) && form.filesystemExtraPaths.length > 0) {
    ac.filesystemExtraPaths = form.filesystemExtraPaths;
  }
  if (form.networkScope === "deny" || form.networkScope === "allowlist") ac.networkScope = form.networkScope;
  if (Array.isArray(form.networkAllowlist) && form.networkAllowlist.length > 0) {
    ac.networkAllowlist = form.networkAllowlist;
  }
  for (const key of ["helloProbeTimeoutSec", "terminalResultCleanupGraceMs"] as const) {
    const value = form[key];
    if (typeof value === "number" && value > 0) ac[key] = value;
  }
  return ac;
}

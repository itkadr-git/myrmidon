import { buildAdapterEnvConfig, type CreateConfigValues } from "@myrmidon/adapter-utils";

export function buildOmpLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  ac.filesystemScope = "workspace";
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.model) ac.model = v.model;
  if (v.thinkingEffort) ac.thinking = v.thinkingEffort;
  
  // OMP sessions can run until the CLI exits naturally; keep timeout disabled (0)
  ac.timeoutSec = 0;
  ac.graceSec = 20;
  
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;
  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = v.extraArgs;
  if (v.args) ac.args = v.args;

  if (v.filesystemScope) ac.filesystemScope = v.filesystemScope;
  if (v.networkScope) ac.networkScope = v.networkScope;
  if (v.networkScope === "allowlist") ac.networkAllowlist = (v.networkAllowlist ?? "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean);

  const form = v.adapterSchemaValues ?? {};
  if (form.filesystemScope === "workspace" || form.filesystemScope === "off" || form.filesystemScope === "") {
    if (form.filesystemScope) ac.filesystemScope = form.filesystemScope;
  }
  if (Array.isArray(form.filesystemExtraPaths) && form.filesystemExtraPaths.length > 0) {
    ac.filesystemExtraPaths = form.filesystemExtraPaths;
  }
  if (form.networkScope === "deny" || form.networkScope === "allowlist" || form.networkScope === "off") {
    if (form.networkScope) ac.networkScope = form.networkScope;
  }
  if (Array.isArray(form.networkAllowlist) && form.networkAllowlist.length > 0) {
    ac.networkAllowlist = form.networkAllowlist;
  }

  return ac;
}

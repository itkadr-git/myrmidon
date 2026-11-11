import {
  parseLocalProcessFilesystemScope,
  parseLocalProcessNetworkAllowlist,
  parseLocalProcessNetworkScope,
  parseLocalProcessSandboxExtraPaths,
} from "@myrmidon/adapter-utils/local-process-sandbox";

/**
 * myrmidon(1.6.6 OPE-11239): save-time rules for the adapter settings the Agent
 * Settings form edits. Pure functions: the agents route turns a returned
 * problem into a 422 and a security change into an instance-admin check.
 */

// myrmidon(1.6.7 OPE-12266): omp_local joins the local CLI adapters — the same
// sandbox keys are validated on save and gated as security changes.
const LOCAL_CLI_ADAPTERS = new Set(["claude_local", "codex_local", "omp_local"]);

/** Sandbox and permission keys of the local CLI adapters. Changing one is a security change. */
export const LOCAL_ADAPTER_SECURITY_KEYS = [
  "filesystemScope",
  "filesystemExtraPaths",
  "filesystemSandboxCommand",
  "networkScope",
  "networkAllowlist",
  "dangerouslySkipPermissions",
  "dangerouslyBypassApprovalsAndSandbox",
  "dangerouslyBypassSandbox",
] as const;

function booleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

/**
 * True when a security key of a claude_local / codex_local config differs in its
 * effective meaning. An absent key means the adapter default (`adapterDefaults`),
 * so the create form, which always submits the permission defaults, is not a change.
 */
export function localAdapterSecurityConfigChanged(
  adapterType: string | null | undefined,
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
  adapterDefaults: Record<string, unknown>,
): boolean {
  if (!adapterType || !LOCAL_CLI_ADAPTERS.has(adapterType)) return false;
  const before = previous ?? {};
  const after = next ?? {};
  const effective = (config: Record<string, unknown>, key: string): unknown => {
    const raw = config[key];
    const value = raw === undefined || raw === null || raw === "" ? adapterDefaults[key] : raw;
    if (Array.isArray(value)) return value.length === 0 ? undefined : value;
    return booleanLike(value) ?? value;
  };
  return LOCAL_ADAPTER_SECURITY_KEYS.some(
    (key) => JSON.stringify(effective(before, key)) !== JSON.stringify(effective(after, key)),
  );
}

const LOCAL_ADAPTER_NUMBER_KEYS = [
  "timeoutSec",
  "graceSec",
  "helloProbeTimeoutSec",
  "terminalResultCleanupGraceMs",
  "outputInactivityTimeoutMs",
] as const;

/**
 * Problem text for an invalid claude_local / codex_local config, else null. The
 * sandbox keys go through the parsers the run path uses, so a value accepted here
 * cannot fail the first run.
 */
export function localAdapterConfigProblem(
  adapterType: string | null | undefined,
  config: Record<string, unknown>,
): string | null {
  if (!adapterType || !LOCAL_CLI_ADAPTERS.has(adapterType)) return null;
  const parsed: Array<[string, (value: unknown) => unknown, boolean]> = [
    ["filesystemScope", parseLocalProcessFilesystemScope, false],
    ["networkScope", parseLocalProcessNetworkScope, false],
    ["filesystemExtraPaths", parseLocalProcessSandboxExtraPaths, true],
    ["networkAllowlist", parseLocalProcessNetworkAllowlist, true],
  ];
  for (const [key, parser, isList] of parsed) {
    const value = config[key];
    if (isList && value !== undefined && value !== null && !Array.isArray(value) && typeof value !== "string") {
      return `${key} must be a list`;
    }
    try {
      parser(value);
    } catch (err) {
      return err instanceof Error ? err.message : `${key} is invalid`;
    }
  }
  const sandboxCommand = config.filesystemSandboxCommand;
  if (
    sandboxCommand !== undefined && sandboxCommand !== null &&
    (typeof sandboxCommand !== "string" || !sandboxCommand.trim())
  ) {
    return "filesystemSandboxCommand must be a non-empty string";
  }
  for (const key of LOCAL_ADAPTER_NUMBER_KEYS) {
    const value = config[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return `${key} must be a non-negative number`;
    }
  }
  return null;
}

/**
 * Problem text for an invalid hermes_gateway config, else null. The gateway ignores
 * out-of-range or malformed values of these keys without a trace, so they are
 * refused while the operator is still looking at the form.
 */
export function hermesGatewayConfigProblem(
  adapterType: string | null | undefined,
  config: Record<string, unknown>,
): string | null {
  if (adapterType !== "hermes_gateway") return null;
  const timeout = config.createRequestTimeoutSec;
  if (timeout !== undefined && timeout !== null && timeout !== "") {
    const seconds = typeof timeout === "number" ? timeout : typeof timeout === "string" ? Number(timeout) : Number.NaN;
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 300) {
      return "createRequestTimeoutSec must be a number from 5 to 300";
    }
  }
  for (const key of ["centralHistoryUrl", "runtimeMcpUrlBase"]) {
    const value = config[key];
    if (value === undefined || value === null || value === "") continue;
    let protocol = "";
    try {
      protocol = typeof value === "string" ? new URL(value).protocol : "";
    } catch {
      protocol = "";
    }
    if (protocol !== "http:" && protocol !== "https:") return `${key} must be an http(s) URL`;
  }
  return null;
}

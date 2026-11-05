import type { AdapterConfigSchema } from "@myrmidon/adapter-utils";
import {
  DEFAULT_ACP_ENGINE_MODE,
  DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
} from "@myrmidon/adapter-utils/acpx-engine/constants";

const acpVisible = { visibleWhen: { key: "engine", values: ["acp"] } };

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "engine",
        label: "Execution engine",
        type: "select",
        default: "auto",
        options: [
          { value: "auto", label: "Default (ACP)" },
          { value: "cli", label: "Claude CLI" },
          { value: "acp", label: "ACP" },
        ],
        hint: "Default uses ACP. If ACP is unavailable, the run fails with a setup error. Choose CLI explicitly to use it.",
      },
      {
        key: "filesystemScope",
        label: "Filesystem scope",
        type: "select",
        options: [{ value: "workspace", label: "Workspace only" }],
        hint: "Confine CLI filesystem access to the workspace. Requires Bubblewrap and explicit CLI execution.",
      },
      {
        key: "filesystemExtraPaths",
        label: "Filesystem extra paths",
        type: "text",
        hint: "Comma-separated absolute paths exposed inside the workspace sandbox.",
      },
      {
        key: "filesystemSandboxCommand",
        label: "Filesystem sandbox command",
        type: "text",
        default: "bwrap",
        hint: "Bubblewrap executable used for filesystem confinement.",
      },
      {
        key: "networkScope",
        label: "Network scope",
        type: "select",
        options: [
          { value: "deny", label: "Deny network" },
          { value: "allowlist", label: "Allowlist" },
        ],
        hint: "Restrict CLI network access. Allowlist requires networkAllowlist.",
      },
      {
        key: "networkAllowlist",
        label: "Network allowlist",
        type: "text",
        hint: "Comma-separated hostnames, host:port entries, or origin URLs.",
      },
      {
        key: "probe",
        label: "Environment probe",
        type: "toggle",
        default: false,
        hint: "Probe the configured local CLI environment before execution.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        hint: "Maximum run duration in seconds.",
      },
      {
        key: "graceSec",
        label: "Grace seconds",
        type: "number",
        hint: "Seconds after SIGTERM before force-killing the process.",
      },
      {
        key: "approvalMode",
        label: "Approval mode",
        type: "select",
        options: [
          { value: "default", label: "Default" },
          { value: "deny", label: "Deny approvals" },
          { value: "bypass", label: "Bypass approvals" },
        ],
        hint: "Controls local CLI approval behavior; security-sensitive modes remain server-validated.",
      },
      {
        key: "dangerouslySkipPermissions",
        label: "Skip Claude permissions",
        type: "toggle",
        default: true,
        hint: "Allow non-interactive Claude CLI runs to proceed without permission prompts.",
      },
      {
        key: "agentCommand",
        label: "ACP server command",
        type: "text",
        hint: "Optional override for the Claude ACP server command. Defaults to the package-local claude-agent-acp binary.",
        meta: acpVisible,
      },
      {
        key: "mode",
        label: "ACP session mode",
        type: "select",
        default: DEFAULT_ACP_ENGINE_MODE,
        options: [
          { value: "persistent", label: "Persistent" },
          { value: "oneshot", label: "One-shot" },
        ],
        hint: "Persistent keeps ACP session state between runs. One-shot starts fresh each run.",
        meta: acpVisible,
      },
      {
        key: "nonInteractivePermissions",
        label: "ACP non-interactive permissions",
        type: "select",
        default: DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
        options: [
          { value: "deny", label: "Deny" },
          { value: "fail", label: "Fail" },
        ],
        hint: "Fallback if the ACP agent asks for input outside an interactive session.",
        meta: acpVisible,
      },
      {
        key: "stateDir",
        label: "ACP state directory",
        type: "text",
        hint: "Optional ACP session state directory. Defaults to Paperclip-managed company/agent scoped storage.",
        meta: acpVisible,
      },
      {
        key: "warmHandleIdleMs",
        label: "ACP warm process idle ms",
        type: "number",
        default: DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
        hint: "Defaults to 0, which closes the ACP process after each run while retaining persistent session state.",
        meta: acpVisible,
      },
    ],
  };
}

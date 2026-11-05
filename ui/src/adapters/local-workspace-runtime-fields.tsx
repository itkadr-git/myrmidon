import type { AdapterConfigFieldsProps } from "./types";
import { configFieldsForSection } from "./config-sections";
import { DraftInput, Field } from "../components/agent-config-primitives";

const inputClass = "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono";

export function parseNetworkAllowlist(value: string): string[] {
  return value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

export function LocalWorkspaceRuntimeFields({
  section, isCreate, values, set, config, eff, mark, adapterType, managedSandboxOnly,
}: AdapterConfigFieldsProps) {
  if (adapterType !== "claude_local" && adapterType !== "codex_local" && adapterType !== "hermes_local") return null;
  const filesystemScope = isCreate ? values?.filesystemScope ?? "" : eff("adapterConfig", "filesystemScope", String(config.filesystemScope ?? ""));
  const networkScope = isCreate ? values?.networkScope ?? "" : eff("adapterConfig", "networkScope", String(config.networkScope ?? ""));
  const networkAllowlist = isCreate
    ? values?.networkAllowlist ?? ""
    : eff("adapterConfig", "networkAllowlist", Array.isArray(config.networkAllowlist) ? config.networkAllowlist.join(", ") : "");
  const engine = adapterType === "claude_local" ? values?.claudeEngine : values?.codexEngine;
  const storedEngine = isCreate ? engine : eff("adapterConfig", "engine", String(config.engine ?? "auto"));
  const needsCli = adapterType !== "hermes_local" && storedEngine !== "cli";
  const sandboxDisabled = managedSandboxOnly || needsCli;
  const update = (key: "filesystemScope" | "networkScope" | "networkAllowlist", value: string) => {
    if (key === "networkAllowlist" && parseNetworkAllowlist(value).some((entry) => {
      try {
        const url = new URL(entry.includes("://") ? entry : `https://${entry}`);
        return Boolean(url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.hostname || url.hostname.includes("*"));
      } catch { return true; }
    })) return;
    if (isCreate) set?.({ [key]: value || undefined });
    else mark("adapterConfig", key, key === "networkAllowlist" ? parseNetworkAllowlist(value) : value || undefined);
  };
  const validAllowlist = parseNetworkAllowlist(networkAllowlist).every((entry) => {
    try {
      const url = new URL(entry.includes("://") ? entry : `https://${entry}`);
      return !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && Boolean(url.hostname) && !url.hostname.includes("*");
    } catch { return false; }
  });
  return configFieldsForSection(section, (
    <>
      <Field configSection="advanced" label="Filesystem scope" hint="Bubblewrap confines the CLI to the workspace; off by default.">
        <select aria-label="Filesystem scope" className={inputClass} value={filesystemScope} disabled={sandboxDisabled} onChange={(event) => update("filesystemScope", event.target.value)}>
          <option value="">Off</option><option value="workspace">Workspace only</option>
        </select>
      </Field>
      <Field configSection="advanced" label="Network scope" hint="Bubblewrap blocks direct sockets. Allowlist routes HTTP(S) through the egress proxy.">
        <select aria-label="Network scope" className={inputClass} value={networkScope} disabled={sandboxDisabled} onChange={(event) => update("networkScope", event.target.value)}>
          <option value="">Off</option><option value="deny">Deny</option><option value="allowlist">Allowlist</option>
        </select>
      </Field>
      {networkScope === "allowlist" && <Field configSection="advanced" label="Network allowlist" hint="Comma-separated hostnames, host:port entries, or origin URLs. Include the provider endpoint.">
        <DraftInput value={networkAllowlist} className={inputClass} disabled={sandboxDisabled} onCommit={(value) => update("networkAllowlist", value)} />
        {!validAllowlist && <p role="alert" className="text-xs text-destructive">Use exact hostnames, host:port, or origin URLs without credentials or paths.</p>}
      </Field>}
      {needsCli && <Field configSection="advanced" label="Sandbox engine"><p className="text-xs text-muted-foreground">Select the CLI engine before enabling Bubblewrap confinement; ACP is not supported.</p></Field>}
    </>
  ));
}

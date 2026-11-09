import { describe, expect, it } from "vitest";
import {
  hermesGatewayConfigProblem,
  localAdapterConfigProblem,
  localAdapterSecurityConfigChanged,
} from "./agent-local-adapter-config.js";

const claudeDefaults = { dangerouslySkipPermissions: true };
const codexDefaults = { dangerouslyBypassApprovalsAndSandbox: true };

describe("localAdapterConfigProblem", () => {
  it("accepts the config the create form submits and the documented sandbox shapes", () => {
    expect(localAdapterConfigProblem("claude_local", { timeoutSec: 0, graceSec: 15, dangerouslySkipPermissions: true })).toBeNull();
    expect(localAdapterConfigProblem("codex_local", {
      filesystemScope: "workspace",
      filesystemExtraPaths: ["/opt/cache", { path: "/var/lib/tool", access: "rw" }],
      networkScope: "allowlist",
      networkAllowlist: ["api.openai.com", "https://api.anthropic.com", "gateway.test:8443"],
      helloProbeTimeoutSec: 60,
      terminalResultCleanupGraceMs: 5000,
      outputInactivityTimeoutMs: null,
    })).toBeNull();
    expect(localAdapterConfigProblem("claude_local", { filesystemExtraPaths: "/opt/cache, /var/lib/tool" })).toBeNull();
  });

  it("rejects values the run path would throw on", () => {
    expect(localAdapterConfigProblem("claude_local", { filesystemScope: "unrestricted" })).toContain("filesystemScope");
    expect(localAdapterConfigProblem("claude_local", { networkScope: "all" })).toContain("networkScope");
    expect(localAdapterConfigProblem("claude_local", { filesystemExtraPaths: ["relative"] })).toContain("absolute");
    expect(localAdapterConfigProblem("claude_local", { filesystemExtraPaths: 5 })).toContain("list");
    expect(localAdapterConfigProblem("codex_local", { networkAllowlist: ["*.example.com"] })).toContain("exact hostname");
    expect(localAdapterConfigProblem("codex_local", { networkAllowlist: [false] })).toContain("string");
    expect(localAdapterConfigProblem("codex_local", { filesystemSandboxCommand: "  " })).toContain("filesystemSandboxCommand");
  });

  it("rejects negative or non-numeric timeouts but not a zero (no limit) timeout", () => {
    expect(localAdapterConfigProblem("claude_local", { timeoutSec: -1 })).toContain("timeoutSec");
    expect(localAdapterConfigProblem("claude_local", { graceSec: "15" })).toContain("graceSec");
    expect(localAdapterConfigProblem("claude_local", { helloProbeTimeoutSec: -5 })).toContain("helloProbeTimeoutSec");
    expect(localAdapterConfigProblem("claude_local", { timeoutSec: 0, graceSec: 15 })).toBeNull();
  });

  it("ignores other adapters", () => {
    expect(localAdapterConfigProblem("hermes_local", { filesystemScope: "unrestricted" })).toBeNull();
  });
});

describe("localAdapterSecurityConfigChanged", () => {
  it("does not treat the permission defaults as a change on create or on an untouched save", () => {
    expect(localAdapterSecurityConfigChanged("claude_local", null, { dangerouslySkipPermissions: true, timeoutSec: 0 }, claudeDefaults)).toBe(false);
    expect(localAdapterSecurityConfigChanged("codex_local", null, { dangerouslyBypassApprovalsAndSandbox: true }, codexDefaults)).toBe(false);
    expect(localAdapterSecurityConfigChanged("claude_local", { model: "a" }, { model: "b", dangerouslySkipPermissions: true }, claudeDefaults)).toBe(false);
    expect(localAdapterSecurityConfigChanged("claude_local", { filesystemExtraPaths: [] }, {}, claudeDefaults)).toBe(false);
  });

  it("flags a permission or sandbox change", () => {
    expect(localAdapterSecurityConfigChanged("claude_local", null, { dangerouslySkipPermissions: false }, claudeDefaults)).toBe(true);
    expect(localAdapterSecurityConfigChanged("codex_local", {}, { dangerouslyBypassApprovalsAndSandbox: "false" }, codexDefaults)).toBe(true);
    expect(localAdapterSecurityConfigChanged("codex_local", {}, { networkScope: "deny" }, codexDefaults)).toBe(true);
    expect(localAdapterSecurityConfigChanged("claude_local", { networkAllowlist: ["a.test"] }, { networkAllowlist: ["b.test"] }, claudeDefaults)).toBe(true);
    expect(localAdapterSecurityConfigChanged("claude_local", { filesystemSandboxCommand: "bwrap" }, {}, claudeDefaults)).toBe(true);
  });

  it("ignores other adapters", () => {
    expect(localAdapterSecurityConfigChanged("hermes_local", {}, { networkScope: "deny" }, {})).toBe(false);
  });

  // myrmidon(1.6.7 OMP-HARDEN, OPE-12266): omp_local's declared create default is
  // filesystemScope=workspace (the gate treats it as the baseline via
  // `previousAdapterConfig == null ? { filesystemScope: "workspace" } : {}` in the
  // agents route), while edits compare every explicit sandbox key directly with no
  // defaults — removing an existing workspace scope stays an instance-admin change.
  it("treats omp_local sandbox keys as direct comparisons without defaults", () => {
    expect(localAdapterSecurityConfigChanged("omp_local", null, { model: "x" }, {})).toBe(false);
    expect(localAdapterSecurityConfigChanged("omp_local", null, { filesystemScope: "workspace" }, {})).toBe(true);
    expect(localAdapterSecurityConfigChanged("omp_local", null, { filesystemScope: "workspace" }, { filesystemScope: "workspace" })).toBe(false);
    expect(localAdapterSecurityConfigChanged("omp_local", { filesystemScope: "workspace" }, { filesystemScope: "workspace" }, {})).toBe(false);
    expect(localAdapterSecurityConfigChanged("omp_local", { filesystemScope: "workspace" }, {}, {})).toBe(true);
    expect(localAdapterSecurityConfigChanged("omp_local", {}, { networkScope: "deny" }, {})).toBe(true);
  });
});

describe("hermesGatewayConfigProblem", () => {
  it("accepts in-range timeouts and http(s) URLs", () => {
    expect(hermesGatewayConfigProblem("hermes_gateway", {
      createRequestTimeoutSec: 90,
      centralHistoryUrl: "https://hindsight.example",
      runtimeMcpUrlBase: "http://127.0.0.1:3100",
    })).toBeNull();
    expect(hermesGatewayConfigProblem("hermes_gateway", { centralHistoryUrl: "", createRequestTimeoutSec: "60" })).toBeNull();
  });

  it("rejects values the gateway would silently ignore", () => {
    expect(hermesGatewayConfigProblem("hermes_gateway", { createRequestTimeoutSec: 4 })).toContain("createRequestTimeoutSec");
    expect(hermesGatewayConfigProblem("hermes_gateway", { createRequestTimeoutSec: 301 })).toContain("createRequestTimeoutSec");
    expect(hermesGatewayConfigProblem("hermes_gateway", { createRequestTimeoutSec: "soon" })).toContain("createRequestTimeoutSec");
    expect(hermesGatewayConfigProblem("hermes_gateway", { centralHistoryUrl: "ftp://hindsight.example" })).toContain("centralHistoryUrl");
    expect(hermesGatewayConfigProblem("hermes_gateway", { runtimeMcpUrlBase: "not a url" })).toContain("runtimeMcpUrlBase");
  });

  it("ignores other adapters", () => {
    expect(hermesGatewayConfigProblem("hermes_local", { createRequestTimeoutSec: 1 })).toBeNull();
  });
});

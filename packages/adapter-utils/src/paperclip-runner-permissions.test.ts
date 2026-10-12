import { describe, expect, it } from "vitest";

import {
  PAPERCLIP_RUNNER_DEFAULT_MODELS,
  PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES,
  isPaperclipRunnerProvider,
  resolvePaperclipRunnerModel,
  resolvePaperclipRunnerPermissionMode,
} from "./paperclip-runner-permissions.js";

describe("Paperclip Runner permission defaults", () => {
  it("defaults Codex to the only qualified non-interactive mode", () => {
    expect(resolvePaperclipRunnerPermissionMode("codex", undefined)).toBe(
      "never",
    );
    expect(resolvePaperclipRunnerPermissionMode("codex", "on-request")).toBe("never");
    expect(resolvePaperclipRunnerPermissionMode("codex", "untrusted")).toBe("never");
  });

  it("uses interactive defaults for dormant non-Codex providers", () => {
    expect(resolvePaperclipRunnerPermissionMode("opencode", undefined)).toBe(
      "ask",
    );
    expect(resolvePaperclipRunnerPermissionMode("acpx", undefined)).toBe(
      "approve-reads",
    );
  });

  // myrmidon(1.6.6 PLUGIN-REGISTRY 3/3, OPE-5065 piece B): the agent-card
  // mode selector exposes exactly the three existing permissionMode values
  // under operator-facing labels (full auto / restricted / deny). The
  // vendor's fourth mode (approve-paperclip) must never enter the catalog,
  // and the runtime values stay the contract the executor reads.
  it("maps the ACPX agent-card modes onto the three existing values", () => {
    const acpx = PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES.acpx;
    expect(acpx.options.map((option) => option.value)).toEqual([
      "approve-all",
      "approve-reads",
      "deny-all",
    ]);
    expect(acpx.options.map((option) => option.label)).toEqual([
      "Full auto (approve all)",
      "Restricted (approve reads)",
      "Deny all (forbidden)",
    ]);
    expect(acpx.defaultMode).toBe("approve-reads");
    for (const value of ["approve-all", "approve-reads", "deny-all"]) {
      expect(resolvePaperclipRunnerPermissionMode("acpx", value)).toBe(value);
    }
    expect(resolvePaperclipRunnerPermissionMode("acpx", "approve-paperclip")).toBe(
      "approve-reads",
    );
  });

  it("recognizes only exact provider identifiers", () => {
    expect(isPaperclipRunnerProvider("codex")).toBe(true);
    expect(isPaperclipRunnerProvider("opencode")).toBe(true);
    expect(isPaperclipRunnerProvider("claude_managed")).toBe(true);
    expect(isPaperclipRunnerProvider("aws_agentcore")).toBe(true);
    expect(isPaperclipRunnerProvider("acpx")).toBe(true);
    expect(isPaperclipRunnerProvider("toString")).toBe(false);
    expect(isPaperclipRunnerProvider("__proto__")).toBe(false);
  });

  it("keeps managed provider permissions under the qualified profile", () => {
    expect(resolvePaperclipRunnerPermissionMode("claude_managed", "never"))
      .toBe("provider-managed");
    expect(resolvePaperclipRunnerPermissionMode("aws_agentcore", "approve-all"))
      .toBe("provider-managed");
  });

  it("uses the Codex default for missing or blank models", () => {
    expect(resolvePaperclipRunnerModel("codex", undefined)).toBe(
      PAPERCLIP_RUNNER_DEFAULT_MODELS.codex,
    );
    expect(resolvePaperclipRunnerModel("codex", "   ")).toBe(
      PAPERCLIP_RUNNER_DEFAULT_MODELS.codex,
    );
  });

  it("preserves an explicit Codex model", () => {
    expect(resolvePaperclipRunnerModel("codex", "gpt-5.5")).toBe("gpt-5.5");
    expect(resolvePaperclipRunnerModel("codex", "  gpt-5.5  ")).toBe("gpt-5.5");
  });
});

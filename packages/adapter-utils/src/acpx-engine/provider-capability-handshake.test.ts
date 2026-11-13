import { describe, expect, it } from "vitest";

import {
  EXTERNAL_AGENT_CAPABILITY_CATALOG,
  EXTERNAL_AGENT_PROVIDERS,
  EXTERNAL_AGENT_RESULT_SCHEMA,
  EXTERNAL_AGENT_TASK_SCHEMA,
  isExternalAgentSecretLeaf,
  validateExternalAgentResult,
  validateExternalAgentTask,
  type ExternalAgentProvider,
} from "./provider-capability-handshake.js";

// OPE-12936 pins the external-agent launch contract of the ACP engine:
// a valid task/result envelope is accepted, an unsupported provider is
// rejected, unsupported per-provider capabilities are rejected before any
// process launch, partial/invalid envelopes never pass, and secret material
// is never serialized into the validated task payload.

function validTask(provider: ExternalAgentProvider = "claude") {
  return {
    schema: EXTERNAL_AGENT_TASK_SCHEMA,
    provider,
    taskId: "OPE-12936",
    prompt: "Validate the ACP handshake boundary.",
    cwd: "/workspace/OPE-12936",
    model: "claude-sonnet-5",
    workMode: "standard",
    capabilities: {
      persistentSessions: { required: true },
      mcpServers: { required: true },
      skills: { required: true },
    },
  };
}

function validResult(provider: ExternalAgentProvider = "claude") {
  return {
    schema: EXTERNAL_AGENT_RESULT_SCHEMA,
    provider,
    taskId: "OPE-12936",
    status: "completed",
    summary: "Handshake validated.",
  };
}

describe("external-agent task envelope — accepted contracts", () => {
  it.each(EXTERNAL_AGENT_PROVIDERS)(
    "accepts a fully valid envelope for %s and returns the provider catalog capabilities",
    (provider) => {
      const outcome = validateExternalAgentTask(validTask(provider));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.task.provider).toBe(provider);
      expect(outcome.task.schema).toBe(EXTERNAL_AGENT_TASK_SCHEMA);
      expect(outcome.task.taskId).toBe("OPE-12936");
      expect(outcome.task.model).toBe("claude-sonnet-5");
      expect(outcome.task.workMode).toBe("standard");
      // The negotiated capabilities are the provider's catalog, not the caller's
      // request: the engine implements exactly what its launch path implements.
      expect(outcome.task.capabilities).toEqual(EXTERNAL_AGENT_CAPABILITY_CATALOG[provider]);
    },
  );

  it("treats model and workMode as optional", () => {
    const task = validTask("codex");
    delete (task as Record<string, unknown>).model;
    delete (task as Record<string, unknown>).workMode;
    const outcome = validateExternalAgentTask(task);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.task.model).toBeNull();
    expect(outcome.task.workMode).toBeNull();
  });

  it("accepts optional (required:false) capabilities the provider does not implement", () => {
    const task = validTask("claude");
    (task.capabilities as Record<string, unknown>).fastMode = { required: false };
    const outcome = validateExternalAgentTask(task);
    expect(outcome.ok).toBe(true);
  });
});

describe("external-agent provider capability handshake — unsupported provider", () => {
  it.each(["kimi", "grok", "custom", "opencode", "claude-code", ""])(
    "rejects unsupported provider %s with provider_unsupported",
    (provider) => {
      const outcome = validateExternalAgentTask({ ...validTask("claude"), provider });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.issues.map((i) => i.code)).toContain("provider_unsupported");
    },
  );

  it("rejects a non-string provider as envelope_invalid, not provider_unsupported", () => {
    const outcome = validateExternalAgentTask({ ...validTask("claude"), provider: 42 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((i) => i.code)).toContain("envelope_invalid");
    expect(outcome.issues.map((i) => i.code)).not.toContain("provider_unsupported");
  });
});

describe("external-agent provider capability handshake — unsupported capability", () => {
  it("rejects fastMode for claude (fastMode is codex-only in the engine)", () => {
    const outcome = validateExternalAgentTask({
      ...validTask("claude"),
      capabilities: { fastMode: { required: true } },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toEqual([
      {
        code: "capability_unsupported",
        path: "/capabilities/fastMode",
        message: "provider claude does not support fastMode",
      },
    ]);
  });

  it("rejects thinkingEffort for claude and gemini (it is wired only into the codex startup config)", () => {
    for (const provider of ["claude", "gemini"] as const) {
      const outcome = validateExternalAgentTask({
        ...validTask(provider),
        capabilities: { thinkingEffort: { required: true } },
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.issues[0]?.code).toBe("capability_unsupported");
      }
    }
  });

  it("accepts fastMode and thinkingEffort only for codex", () => {
    const outcome = validateExternalAgentTask({
      ...validTask("codex"),
      capabilities: {
        fastMode: { required: true },
        thinkingEffort: { required: true },
      },
    });
    expect(outcome.ok).toBe(true);
  });

  it("accepts required skills for claude (all three providers prepare skills, each in its own mode)", () => {
    const outcome = validateExternalAgentTask({
      ...validTask("claude"),
      capabilities: { skills: { required: true } },
    });
    // claude supports skills; this control case must pass before the
    // genuinely-unsupported variants below.
    expect(outcome.ok).toBe(true);
  });
});

describe("external-agent task envelope — invalid/partial envelopes are rejected", () => {
  it("rejects a non-object envelope", () => {
    for (const value of [null, "task", 42, []]) {
      const outcome = validateExternalAgentTask(value);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.issues[0]?.code).toBe("envelope_invalid");
      }
    }
  });

  it("rejects a missing or unknown schema discriminator", () => {
    for (const schema of [undefined, "paperclip.external_agent_task.v2", "paperclip.prp.fixture.v1"]) {
      const outcome = validateExternalAgentTask({ ...validTask("claude"), schema });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.issues.map((i) => i.path)).toContain("/schema");
      }
    }
  });

  it.each(["taskId", "prompt", "cwd", "capabilities"] as const)(
    "rejects an envelope missing %s",
    (field) => {
      const task = { ...validTask("claude") } as Record<string, unknown>;
      delete task[field];
      const outcome = validateExternalAgentTask(task);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.issues.map((i) => i.path)).toContain(`/${field}`);
      }
    },
  );

  it("rejects empty-string required fields", () => {
    const outcome = validateExternalAgentTask({ ...validTask("claude"), prompt: "   " });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.map((i) => i.path)).toContain("/prompt");
    }
  });

  it("rejects an over-long taskId", () => {
    const outcome = validateExternalAgentTask({
      ...validTask("claude"),
      taskId: "T".repeat(201),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.map((i) => i.path)).toContain("/taskId");
    }
  });

  it("rejects non-boolean or malformed capability entries", () => {
    const outcome = validateExternalAgentTask({
      ...validTask("claude"),
      capabilities: { mcpServers: { required: "yes" } },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.map((i) => i.path)).toContain("/capabilities/mcpServers");
    }
  });

  it("rejects empty capability declarations", () => {
    const outcome = validateExternalAgentTask({
      ...validTask("claude"),
      capabilities: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.map((i) => i.path)).toContain("/capabilities");
    }
  });

  it("rejects unknown capability keys (closed capability set)", () => {
    const outcome = validateExternalAgentTask({
      ...validTask("claude"),
      capabilities: {
        mcpServers: { required: true },
        teleportation: { required: true },
      },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.map((i) => i.path)).toContain("/capabilities/teleportation");
    }
  });
});

describe("external-agent secrets hygiene", () => {
  it("never serializes a nested API key into the validated task payload", () => {
    const outcome = validateExternalAgentTask({
      ...validTask("claude"),
      credentials: { apiToken: "pcp_aaaaaaaaaaaaaaaa" },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const secretIssue = outcome.issues.find((i) => i.code === "secret_in_payload");
    expect(secretIssue?.path).toBe("/credentials/apiToken");
    // The message carries only a digest, never the value.
    expect(secretIssue?.message).not.toContain("pcp_aaaaaaaaaaaaaaaa");
    expect(secretIssue?.message).toMatch(/digest sha256:[0-9a-f]{16}/);
  });

  it("flags secret-shaped values regardless of their key name", () => {
    expect(isExternalAgentSecretLeaf("notes", "sk-proj-AAAAAAAAAAAAAAAA1")).toBe(true);
    expect(isExternalAgentSecretLeaf("notes", "ghp_0123456789abcdefghijAAAA")).toBe(true);
    expect(isExternalAgentSecretLeaf("auth", "Bearer abc.def")).toBe(true);
    expect(isExternalAgentSecretLeaf("PAPERCLIP_API_KEY", "pcp_kkkk11112222")).toBe(true);
    // Ordinary prompt/cwd/model content is not a secret.
    expect(isExternalAgentSecretLeaf("prompt", "fix the pcp_ placeholder handling")).toBe(false);
    expect(isExternalAgentSecretLeaf("cwd", "/workspace/OPE-12936")).toBe(false);
    expect(isExternalAgentSecretLeaf("model", "claude-sonnet-5")).toBe(false);
  });

  it("rejects a secret nested deep inside an otherwise valid envelope", () => {
    const outcome = validateExternalAgentTask({
      ...validTask("gemini"),
      context: { launch: { env: { GEMINI_API_KEY: "0000000000000000" } } },
    });
    // The Google key shape is not in the closed value list, but the KEY NAME
    // `GEMINI_API_KEY` normalizes to apikey and must fail the leaf check.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const secretIssue = outcome.issues.find((i) => i.code === "secret_in_payload");
      expect(secretIssue?.path).toBe("/context/launch/env/GEMINI_API_KEY");
    }
  });
});

describe("external-agent result envelope", () => {
  it.each(EXTERNAL_AGENT_PROVIDERS)("accepts a completed result for %s", (provider) => {
    const outcome = validateExternalAgentResult(validResult(provider));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.status).toBe("completed");
    expect(outcome.result.summary).toBe("Handshake validated.");
    expect(outcome.result.errorCode).toBeNull();
  });

  it("accepts failed results only with a bounded error identity", () => {
    const failed = {
      ...validResult("codex"),
      status: "failed",
      error: { code: "AGENT_STARTUP_FAILED", message: "agent exited before handshake" },
    };
    const outcome = validateExternalAgentResult(failed);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.errorCode).toBe("AGENT_STARTUP_FAILED");

    const withoutError = validateExternalAgentResult({
      ...validResult("gemini"),
      status: "failed",
    });
    expect(withoutError.ok).toBe(false);
    if (!withoutError.ok) {
      expect(withoutError.issues.map((i) => i.path)).toContain("/error");
    }
  });

  it.each(["pending", "running", "", null, 7])("rejects unknown status %s", (status) => {
    const outcome = validateExternalAgentResult({ ...validResult("claude"), status });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.map((i) => i.path)).toContain("/status");
    }
  });

  it("rejects partial result envelopes", () => {
    for (const field of ["schema", "provider", "taskId", "status"] as const) {
      const envelope = { ...validResult("claude") } as Record<string, unknown>;
      delete envelope[field];
      const outcome = validateExternalAgentResult(envelope);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.issues.length).toBeGreaterThan(0);
      }
    }
  });

  it("rejects an over-long summary", () => {
    const outcome = validateExternalAgentResult({
      ...validResult("claude"),
      summary: "x".repeat(8193),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.map((i) => i.path)).toContain("/summary");
    }
  });

  it("rejects an unsupported provider in the result envelope", () => {
    const outcome = validateExternalAgentResult({ ...validResult("kimi") });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.map((i) => i.code)).toContain("provider_unsupported");
    }
  });
});

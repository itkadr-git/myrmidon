import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock server-utils to control runChildProcess output
vi.mock("@myrmidon/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myrmidon/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

// Mock fs to avoid disk access in execute()
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute, isProviderErrorAsContent, PROVIDER_ERROR_AS_CONTENT_PATTERNS } from "./execute.js";
import * as serverUtils from "@myrmidon/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const onSpawn = vi.fn(async () => undefined);
  const onLog = vi.fn(async () => undefined);
  const onMeta = vi.fn(async () => undefined);
  return {
    ctx: {
      runId: "test-run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "/usr/bin/hermes",
        timeoutSec: 60,
        graceSec: 5,
        model: "gpt-4o",
        ...overrides,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog,
      onMeta,
      onSpawn,
    } satisfies Record<string, unknown>,
    onLog,
    onSpawn,
  };
}

describe("provider error responses disguised as content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recognizes the HTTP-200 overload response", () => {
    expect(isProviderErrorAsContent("The server is (sometimes) overloaded due to high user traffic. Please retry!")).toBe(true);
  });

  it("keeps short normal model responses as content", () => {
    for (const response of ["Hello.", "Try again tomorrow.", "The server is helpful.", "Quota means a limit.", "Please retry this command later."]) {
      expect(isProviderErrorAsContent(response)).toBe(false);
    }
  });

  it("keeps the detector patterns in a testable constant", () => {
    expect(PROVIDER_ERROR_AS_CONTENT_PATTERNS.length).toBeGreaterThanOrEqual(1);
  });

  it("suppresses provider overload response and reclassifies as hermes_transient_upstream", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "The server is (sometimes) overloaded due to high user traffic. Please retry!\n\nsession_id: test-session-123\n",
      stderr: "",
      pid: 1234,
      startedAt: new Date(),
    });

    const { ctx, onLog } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorCode).toBe("hermes_transient_upstream");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorMessage).toBe("Provider returned an overload or quota error as successful response content");
    expect(result.summary).toBeUndefined();
    expect(result.resultJson?.result).toBe("");
    expect(result.resultJson?.provider_error_as_content).toBe(true);
    expect(onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("provider_error_as_content model=gpt-4o"));
  });

  it("preserves standard valid model responses as content without errors", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Task completed successfully with all criteria met.\n\nsession_id: test-session-456\n",
      stderr: "",
      pid: 1234,
      startedAt: new Date(),
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorCode).toBeUndefined();
    expect(result.errorFamily).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
    expect(result.summary).toBe("Task completed successfully with all criteria met.");
    expect(result.resultJson?.result).toBe("Task completed successfully with all criteria met.");
    expect(result.resultJson?.provider_error_as_content).toBeUndefined();
  });
});

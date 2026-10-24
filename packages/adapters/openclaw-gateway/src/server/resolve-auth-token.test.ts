import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAuthToken } from "./execute.js";

describe("openclaw gateway token precedence", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers the agent token (config) over headers and env", () => {
    vi.stubEnv("OPENCLAW_TOKEN", "env-token");
    expect(
      resolveAuthToken({ authToken: "agent-token" }, { "x-openclaw-token": "header-token" }),
    ).toBe("agent-token");
  });

  it("accepts the legacy config key `token` as the agent token", () => {
    vi.stubEnv("OPENCLAW_TOKEN", "env-token");
    expect(resolveAuthToken({ token: "agent-legacy" }, {})).toBe("agent-legacy");
  });

  it("uses headers when the agent has no token: x-openclaw-token, then authorization", () => {
    vi.stubEnv("OPENCLAW_TOKEN", "env-token");
    expect(
      resolveAuthToken({}, { "X-OpenClaw-Token": "header-token", authorization: "Bearer auth-token" }),
    ).toBe("header-token");
    expect(resolveAuthToken({}, { Authorization: "Bearer auth-token" })).toBe("auth-token");
  });

  it("uses OPENCLAW_TOKEN only as the last emergency fallback", () => {
    vi.stubEnv("OPENCLAW_TOKEN", "env-token");
    expect(resolveAuthToken({}, {})).toBe("env-token");
  });

  it("returns null when nothing is set", () => {
    vi.stubEnv("OPENCLAW_TOKEN", "");
    expect(resolveAuthToken({}, {})).toBeNull();
  });
});

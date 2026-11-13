// server/src/myrmidon/agent-liveness/probe-sweep.test.ts
//
// Unit tests for the agent-liveness probe sweep (OPE-13021): URL resolution
// and outcome classification. DB writes are covered by CI integration.

import { describe, expect, it } from "vitest";
import {
  AGENT_LIVENESS_PROBEABLE_ADAPTERS,
  classifyAgentProbeOutcome,
  resolveAgentProbeUrl,
  type AgentLivenessProbePort,
} from "./probe-sweep.js";

function candidate(adapterType: string, adapterConfig: unknown) {
  return { agentId: "agent-1", companyId: "company-1", adapterType, adapterConfig };
}

describe("classifyAgentProbeOutcome", () => {
  it("counts any HTTP answer below 500 as alive, including auth failures", () => {
    expect(classifyAgentProbeOutcome(200)).toBe("ok");
    expect(classifyAgentProbeOutcome(302)).toBe("ok");
    expect(classifyAgentProbeOutcome(401)).toBe("ok");
    expect(classifyAgentProbeOutcome(403)).toBe("ok");
    expect(classifyAgentProbeOutcome(404)).toBe("ok");
    expect(classifyAgentProbeOutcome(429)).toBe("ok");
  });

  it("counts 5xx and transport failure (null) as unreachable", () => {
    expect(classifyAgentProbeOutcome(500)).toBe("unreachable");
    expect(classifyAgentProbeOutcome(503)).toBe("unreachable");
    expect(classifyAgentProbeOutcome(null)).toBe("unreachable");
  });
});

describe("resolveAgentProbeUrl", () => {
  it("maps the hermes dashboard root and /chat onto /api/health", () => {
    expect(resolveAgentProbeUrl(candidate("hermes_gateway", { apiBaseUrl: "http://myrmidon-bot-abc:9119" }))).toBe(
      "http://myrmidon-bot-abc:9119/api/health",
    );
    expect(resolveAgentProbeUrl(candidate("hermes_gateway", { apiBaseUrl: "http://myrmidon-bot-abc:9119/chat" }))).toBe(
      "http://myrmidon-bot-abc:9119/api/health",
    );
  });

  it("keeps a non-default hermes path as-is and appends /health", () => {
    expect(resolveAgentProbeUrl(candidate("hermes_gateway", { apiBaseUrl: "https://gw.example.com/api" }))).toBe(
      "https://gw.example.com/api/health",
    );
  });

  it("rejects plain http to remote non-bot hosts without the escape hatch", () => {
    expect(resolveAgentProbeUrl(candidate("hermes_gateway", { apiBaseUrl: "http://evil.example.com:9119" }))).toBeNull();
    expect(resolveAgentProbeUrl(candidate("http", { url: "http://10.0.0.5:3000" }))).toBeNull();
  });

  it("allows plain http to bot containers, loopback, and the explicit escape hatch", () => {
    expect(resolveAgentProbeUrl(candidate("hermes_gateway", { apiBaseUrl: "http://myrmidon-bot-abc:9119" }))).toBe(
      "http://myrmidon-bot-abc:9119/api/health",
    );
    expect(resolveAgentProbeUrl(candidate("hermes_gateway", { apiBaseUrl: "http://127.0.0.1:9119" }))).toBe(
      "http://127.0.0.1:9119/api/health",
    );
    expect(
      resolveAgentProbeUrl(candidate("http", { url: "http://10.0.0.5:3000", dangerouslyAllowInsecureRemoteHttp: true })),
    ).toBe("http://10.0.0.5:3000/health");
  });

  it("probes the http adapter's own configured url", () => {
    expect(resolveAgentProbeUrl(candidate("http", { url: "https://mcp.example.com/" }))).toBe(
      "https://mcp.example.com/health",
    );
  });

  it("returns null when there is nothing to probe", () => {
    expect(resolveAgentProbeUrl(candidate("claude_local", {}))).toBeNull();
    expect(resolveAgentProbeUrl(candidate("hermes_gateway", null))).toBeNull();
    expect(resolveAgentProbeUrl(candidate("hermes_gateway", { apiBaseUrl: "ftp://x" }))).toBeNull();
    expect(resolveAgentProbeUrl(candidate("hermes_gateway", { apiBaseUrl: "not a url" }))).toBeNull();
  });

  it("declares exactly the adapters with a probeable HTTP surface", () => {
    expect(AGENT_LIVENESS_PROBEABLE_ADAPTERS).toEqual(["hermes_gateway", "http"]);
  });
});

describe("port contract", () => {
  it("documents the probe surface the sweep expects", async () => {
    const port: AgentLivenessProbePort = {
      probe: async ({ url, timeoutMs }) => {
        expect(url).toBe("https://gw.example.com/api/health");
        expect(timeoutMs).toBe(5_000);
        return { status: 200 };
      },
    };
    expect((await port.probe({ url: "https://gw.example.com/api/health", timeoutMs: 5_000 })).status).toBe(200);
  });
});

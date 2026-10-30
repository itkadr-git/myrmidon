// myrmidon(BROWSER-CONSOLE): the part-B gateway seam of the bot pause.
//
// The gateway knows the live browser only by the resolved MCP endpoint; this
// test pins the decision table of the seam it calls before dispatching:
//   open session on a mapped endpoint -> the pause info (the gateway turns it
//     into ToolGatewayHttpError 423 browser_console_mcp_paused),
//   no session / unmapped endpoint / no guard installed -> null (call runs).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertBrowserConsoleMcpAllowed,
  browserConsoleMcpPauseForEndpoint,
  browserIdForMcpEndpoint,
  registerBrowserConsoleMcpGuard,
} from "./mcp-guard.js";
import { BrowserConsoleError, type BrowserConsoleService } from "./service.js";

const ENDPOINT = "http://mcp-reaper.invalid:8932/mcp";
const ENVS = { MYRMIDON_BROWSER_CONSOLE_MCP_URLS: JSON.stringify({ [ENDPOINT]: "browser-a" }) } as NodeJS.ProcessEnv;

afterEach(() => {
  registerBrowserConsoleMcpGuard(null as unknown as BrowserConsoleService);
});

describe("browserIdForMcpEndpoint", () => {
  it("maps the configured endpoint, trailing slash and whitespace included", () => {
    expect(browserIdForMcpEndpoint(ENDPOINT, ENVS)).toBe("browser-a");
    expect(browserIdForMcpEndpoint(`${ENDPOINT}/`, ENVS)).toBe("browser-a");
    expect(browserIdForMcpEndpoint(` ${ENDPOINT}`, ENVS)).toBe("browser-a");
    expect(browserIdForMcpEndpoint("http://other.invalid/mcp", ENVS)).toBeNull();
  });

  it("no or malformed mapping reads as empty (fail-open, never throws)", () => {
    expect(browserIdForMcpEndpoint(ENDPOINT, {} as NodeJS.ProcessEnv)).toBeNull();
    const warn = vi.fn();
    expect(browserIdForMcpEndpoint(ENDPOINT, { MYRMIDON_BROWSER_CONSOLE_MCP_URLS: "{not json" } as NodeJS.ProcessEnv, )).toBeNull();
    expect(browserIdForMcpEndpoint(ENDPOINT, { MYRMIDON_BROWSER_CONSOLE_MCP_URLS: "[1,2]" } as NodeJS.ProcessEnv)).toBeNull();
    void warn;
  });
});

describe("browserConsoleMcpPauseForEndpoint", () => {
  it("an open session on the mapped endpoint yields the pause (gateway answers 423)", async () => {
    const guard = {
      assertBrowserScreenFreeForMcp: vi.fn(async (browserId: string) => {
        throw new BrowserConsoleError(423, `An owner screen session is open on ${browserId}; MCP calls are paused`);
      }),
    } as unknown as BrowserConsoleService;
    registerBrowserConsoleMcpGuard(guard);
    const pause = await browserConsoleMcpPauseForEndpoint(ENDPOINT, ENVS);
    expect(pause).toMatchObject({ browserId: "browser-a" });
    expect(pause!.message).toContain("MCP calls are paused");
    expect(guard.assertBrowserScreenFreeForMcp).toHaveBeenCalledWith("browser-a");
  });

  it("without a session the call passes; an unmapped endpoint never consults the service", async () => {
    const guard = { assertBrowserScreenFreeForMcp: vi.fn(async () => undefined) } as unknown as BrowserConsoleService;
    registerBrowserConsoleMcpGuard(guard);
    expect(await browserConsoleMcpPauseForEndpoint(ENDPOINT, ENVS)).toBeNull();
    expect(await browserConsoleMcpPauseForEndpoint("http://slack-mcp.invalid/mcp", ENVS)).toBeNull();
    expect(guard.assertBrowserScreenFreeForMcp).toHaveBeenCalledTimes(1);
  });

  it("no guard installed (part A standalone): the seam is inert, never throws", async () => {
    registerBrowserConsoleMcpGuard(null as unknown as BrowserConsoleService);
    expect(await browserConsoleMcpPauseForEndpoint(ENDPOINT, ENVS)).toBeNull();
  });

  it("the direct call point keeps the 423 status for other guards", async () => {
    const guard = {
      assertBrowserScreenFreeForMcp: vi.fn(async () => {
        throw new BrowserConsoleError(423, "paused");
      }),
    } as unknown as BrowserConsoleService;
    registerBrowserConsoleMcpGuard(guard);
    await expect(assertBrowserConsoleMcpAllowed("browser-a")).rejects.toMatchObject({ status: 423 });
  });
});

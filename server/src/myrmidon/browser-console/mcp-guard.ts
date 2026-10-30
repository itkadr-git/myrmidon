// myrmidon(BROWSER-CONSOLE): the server-side MCP guard (bot pause, contour 2).
//
// While an owner screen session is open on a browser, the board must not let
// bot MCP clients drive that browser. The tool gateway consults this module
// at its browser-tool call points via assertBrowserConsoleMcpAllowed(). The
// guard is registered by the wiring (wiring.ts) so tests can install their
// own fake service.
//
// Part B wires the call point into the gateway: the gateway knows the live
// browser only by its MCP endpoint, so MYRMIDON_BROWSER_CONSOLE_MCP_URLS maps
// `endpoint -> fleet browser id`; an endpoint that is not in the map is not a
// live browser and passes untouched.

import type { BrowserConsoleService } from "./service.js";
import { readBrowserConsoleMcpUrlMap } from "./settings.js";

let guardService: BrowserConsoleService | null = null;

export function registerBrowserConsoleMcpGuard(service: BrowserConsoleService | null): void {
  guardService = service;
}

/**
 * Throw when a screen session is open on the browser a tool call targets.
 * The input names the browser the way the caller knows it; unknown ids are
 * free (the registry is env-configured and may lag a caller).
 */
export async function assertBrowserConsoleMcpAllowed(browserId: string): Promise<void> {
  const service = guardService;
  if (!service) return;
  await service.assertBrowserScreenFreeForMcp(browserId);
}

/** The fleet browser id an MCP endpoint belongs to, or null (not a live browser). */
export function browserIdForMcpEndpoint(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const map = readBrowserConsoleMcpUrlMap(env);
  const normalized = endpoint.trim().replace(/\/+$/, "");
  for (const [configured, browserId] of Object.entries(map)) {
    if (configured.trim().replace(/\/+$/, "") === normalized) return browserId;
  }
  return null;
}

/**
 * Gateway call point (part B): the pause decision for one resolved MCP
 * endpoint. Returns null when the call may run — the endpoint is not a live
 * browser, or no owner session is open — and the owning browser id plus the
 * message when it must not. The gateway turns a hit into its own
 * ToolGatewayHttpError(423) so this module keeps no dependency on the
 * gateway's error type (dependency direction: gateway -> guard -> service).
 */
export async function browserConsoleMcpPauseForEndpoint(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ browserId: string; message: string } | null> {
  const browserId = browserIdForMcpEndpoint(endpoint, env);
  if (!browserId) return null;
  const service = guardService;
  if (!service) return null;
  try {
    await service.assertBrowserScreenFreeForMcp(browserId);
  } catch (err) {
    return { browserId, message: err instanceof Error ? err.message : "MCP calls to this browser are paused" };
  }
  return null;
}

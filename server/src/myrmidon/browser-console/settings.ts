// myrmidon(BROWSER-CONSOLE): screen-console settings (part B).
//
// The screen rides the same Guacamole client as the fleet console
// (MYRMIDON_FLEET_CONSOLE_URL) and the same shared signing secret
// (`guacamole-json-secret-key` in the panel secret store). Part B adds one
// setting of its own: MYRMIDON_BROWSER_VNC_TARGET, the `host[:port]` the
// guacd process must reach (x11vnc on the exec host). Like the fleet
// console URL it has no neutral default: an instance that has not set it
// refuses to hand out a console token instead of pointing guacd at a guess.
// Documented in docs/myrmidon/SETTINGS.md.

import {
  DEFAULT_BROWSER_VNC_PORT,
  parseBrowserVncTarget,
  type BrowserVncTarget,
} from "@paperclipai/shared/myrmidon-browser-console";
import { FLEET_CONSOLE_SECRET_KEY_NAME, FLEET_CONSOLE_URL_ENV, FLEET_CONSOLE_TOKEN_TTL_MS } from "../fleet-console/settings.js";

/** The address of the x11vnc endpoint that guacd must reach (`host[:port]`). */
export const BROWSER_VNC_TARGET_ENV = "MYRMIDON_BROWSER_VNC_TARGET";

/**
 * The screen token is signed with the same shared secret as the fleet
 * console: one name in the panel secret store, one value, never duplicated
 * (the task forbids a second key with the same material).
 */
export const BROWSER_CONSOLE_SECRET_KEY_NAME = FLEET_CONSOLE_SECRET_KEY_NAME;

/** Live-browser MCP endpoint → browser id map for the gateway pause guard. */
export const BROWSER_CONSOLE_MCP_URLS_ENV = "MYRMIDON_BROWSER_CONSOLE_MCP_URLS";

/** The standard VNC port, re-exported for the node contract and tests. */
export { DEFAULT_BROWSER_VNC_PORT };

export interface BrowserConsoleSettings {
  /** Base URL of the shared Guacamole client; `null` when not configured. */
  guacamoleUrl: string | null;
  /** Name of the company secret holding the shared `json-secret-key`. */
  secretKeyName: string;
  /** Lifetime of an issued screen token, milliseconds (same TTL as the fleet console). */
  tokenTtlMs: number;
  /** The VNC target parsed from MYRMIDON_BROWSER_VNC_TARGET; `null` when unset or invalid. */
  vncTarget: BrowserVncTarget | null;
  /** Raw MYRMIDON_BROWSER_VNC_TARGET value, for the error message (never a secret). */
  vncTargetRaw: string | null;
}

function normalizeBaseUrl(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export function readBrowserConsoleSettings(env: NodeJS.ProcessEnv = process.env): BrowserConsoleSettings {
  const raw = env[BROWSER_VNC_TARGET_ENV]?.trim();
  return {
    // The screen and the fleet-terminal ride the same Guacamole client
    // (screen-solution decision step0-solution-choice): one URL, one signing secret.
    guacamoleUrl: normalizeBaseUrl(env[FLEET_CONSOLE_URL_ENV]),
    secretKeyName: FLEET_CONSOLE_SECRET_KEY_NAME,
    tokenTtlMs: FLEET_CONSOLE_TOKEN_TTL_MS,
    vncTarget: parseBrowserVncTarget(raw),
    vncTargetRaw: raw && raw.length > 0 ? raw : null,
  };
}

/**
 * Parse MYRMIDON_BROWSER_CONSOLE_MCP_URLS: a JSON object mapping the live
 * browser MCP endpoint (what the tool gateway resolves for the connection) to
 * the fleet browser id the guard checks. Invalid JSON reads as empty — the
 * guard then never fires, same fail-open as an unconfigured registry.
 */
export function readBrowserConsoleMcpUrlMap(
  env: NodeJS.ProcessEnv = process.env,
  logWarn?: (message: string) => void,
): Record<string, string> {
  const raw = env[BROWSER_CONSOLE_MCP_URLS_ENV]?.trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logWarn?.(`${BROWSER_CONSOLE_MCP_URLS_ENV} must be a JSON object of endpoint -> browser id; the pause guard is off`);
      return {};
    }
    const map: Record<string, string> = {};
    for (const [endpoint, browserId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof browserId === "string" && browserId.trim().length > 0) map[endpoint] = browserId;
    }
    return map;
  } catch {
    logWarn?.(`${BROWSER_CONSOLE_MCP_URLS_ENV} is not valid JSON; the pause guard is off`);
    return {};
  }
}

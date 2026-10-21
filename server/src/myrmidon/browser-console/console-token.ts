// myrmidon(BROWSER-CONSOLE): the screen console token (part B).
//
// The screen rides the same Guacamole client as the fleet console: the panel
// signs a short-lived auth-JSON (AES-128-CBC + HMAC-SHA256, the shared
// `guacamole-json-secret-key` from the panel secret store — the same key
// name, one value, never duplicated) and hands the browser only the URL with
// the ciphertext in the `data` parameter. guacd decrypts through the
// guacamole-auth-json extension and opens the VNC connection to the x11vnc
// endpoint the exec host started for this browser.
//
// The token binds to the session the part-A lifecycle already opened: issuing
// never creates a second session record and never writes a journal entry —
// the part-A journal row (who/when/duration/closed-by) already covers it.

import {
  AUTH_JSON_SECRET_KEY_PATTERN,
  signGuacamoleAuthJson,
  type GuacamoleAuthJson,
} from "../fleet-console/token.js";

export const BROWSER_CONSOLE_ERROR_CODES = {
  sessionRequired: "screen_session_required",
  notConfigured: "console_not_configured",
  secretMissing: "console_secret_missing",
  secretInvalid: "console_secret_invalid",
} as const;

/** One VNC connection for one browser; the key Guacamole shows in its UI. */
export function buildScreenAuthJson(input: {
  browserId: string;
  hostname: string;
  port: number;
  expiresAt: number;
}): GuacamoleAuthJson {
  return {
    username: input.browserId,
    expires: input.expiresAt,
    connections: {
      [input.browserId]: {
        protocol: "vnc",
        parameters: {
          hostname: input.hostname,
          port: String(input.port),
        },
      },
    },
  };
}

/** The Guacamole client URL with the blob: what the UI loads in the iframe. */
export function screenConsoleUrl(guacamoleBaseUrl: string, token: string): string {
  const base = guacamoleBaseUrl.endsWith("/") ? guacamoleBaseUrl.slice(0, -1) : guacamoleBaseUrl;
  return `${base}/#/?data=${encodeURIComponent(token)}`;
}

export interface ScreenTokenIssueInput {
  browserId: string;
  /** Epoch ms of the issuing moment (the injected service clock). */
  nowMs: number;
  guacamoleUrl: string | null;
  vncTarget: { hostname: string; port: number } | null;
  secretKey: string | null;
  tokenTtlMs: number;
}

export type ScreenTokenIssueFailure =
  | { ok: false; status: 409; code: typeof BROWSER_CONSOLE_ERROR_CODES.sessionRequired; message?: string }
  | { ok: false; status: 503; code: typeof BROWSER_CONSOLE_ERROR_CODES.notConfigured; message: string }
  | { ok: false; status: 503; code: typeof BROWSER_CONSOLE_ERROR_CODES.secretMissing; message?: string }
  | { ok: false; status: 503; code: typeof BROWSER_CONSOLE_ERROR_CODES.secretInvalid; message?: string };

export interface ScreenTokenIssued {
  ok: true;
  token: string;
  consoleUrl: string;
  expiresAt: number;
}

/**
 * The pure decision: what may a token be signed for, and with what failure
 * when it may not. Session presence is checked by the service before this is
 * called (the sessionRequired arm exists so the route can answer the stable
 * code when the session closed between the check and the signing).
 */
export function issueScreenToken(input: ScreenTokenIssueInput): ScreenTokenIssued | ScreenTokenIssueFailure {
  if (!input.guacamoleUrl) {
    return { ok: false, status: 503, code: BROWSER_CONSOLE_ERROR_CODES.notConfigured, message: "The instance has no console URL configured" };
  }
  if (!input.vncTarget) {
    return { ok: false, status: 503, code: BROWSER_CONSOLE_ERROR_CODES.notConfigured, message: "The instance has no VNC target configured" };
  }
  if (!input.secretKey) {
    return { ok: false, status: 503, code: BROWSER_CONSOLE_ERROR_CODES.secretMissing };
  }
  if (!AUTH_JSON_SECRET_KEY_PATTERN.test(input.secretKey)) {
    return { ok: false, status: 503, code: BROWSER_CONSOLE_ERROR_CODES.secretInvalid };
  }
  const expiresAt = input.nowMs + input.tokenTtlMs;
  const token = signGuacamoleAuthJson(
    buildScreenAuthJson({
      browserId: input.browserId,
      hostname: input.vncTarget.hostname,
      port: input.vncTarget.port,
      expiresAt,
    }),
    input.secretKey,
  );
  return { ok: true, token, consoleUrl: screenConsoleUrl(input.guacamoleUrl, token), expiresAt };
}

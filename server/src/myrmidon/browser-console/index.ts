// myrmidon(BROWSER-CONSOLE): module entry point.
//
// Part A: the registry, the API, the session timers, the journal, the
// site-data clear and both contours of the bot pause. Part B adds the
// screen node (ops/browser-console-node, x11vnc on the exec host), the
// Guacamole console-token signing and the gateway call point of the MCP
// guard.

export { browserConsoleService, BrowserConsoleError, type BrowserConsoleService } from "./service.js";
export { browserConsoleRoutes } from "./routes.js";
export { myrmidonBrowserConsoleRoutes, getBrowserConsoleService } from "./wiring.js";
export {
  registerBrowserConsoleMcpGuard,
  assertBrowserConsoleMcpAllowed,
  browserIdForMcpEndpoint,
  browserConsoleMcpPauseForEndpoint,
} from "./mcp-guard.js";
export {
  readBrowserConsoleSettings,
  BROWSER_VNC_TARGET_ENV,
  BROWSER_CONSOLE_MCP_URLS_ENV,
  BROWSER_CONSOLE_SECRET_KEY_NAME,
  type BrowserConsoleSettings,
} from "./settings.js";
export {
  issueScreenToken,
  buildScreenAuthJson,
  screenConsoleUrl,
  BROWSER_CONSOLE_ERROR_CODES,
  type ScreenTokenIssued,
  type ScreenTokenIssueFailure,
} from "./console-token.js";
export {
  readBrowserConsoleTimers,
  sessionDeadlines,
  autoCloseReason,
  AUTO_CLOSE_WARN_MS,
  DEFAULT_IDLE_TIMEOUT_MIN,
  DEFAULT_MAX_DURATION_MIN,
  BROWSER_IDLE_TIMEOUT_MIN_ENV,
  BROWSER_MAX_DURATION_MIN_ENV,
  type BrowserConsoleTimers,
} from "./timers.js";
export {
  readScreenConsoleSettings,
  screenConsoleClient,
  ScreenConsoleError,
  BROWSER_CONSOLE_HOST_ENV,
  BROWSER_CONSOLE_TOKEN_ENV,
  type ScreenConsoleClient,
} from "./screen-console-client.js";
export {
  readBrowserSessionDocument,
  mutateBrowserSessionDocument,
  parseBrowserSessionDocument,
  BROWSER_SESSIONS_GENERAL_KEY,
  BROWSER_JOURNAL_LIMIT,
} from "./store.js";

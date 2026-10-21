// myrmidon(BROWSER-CONSOLE): real wiring for app.ts.
//
// One process-wide service: routes, the MCP guard registration and (part B)
// the Guacamole console-token signing all share the same session state.

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { secretService } from "../../services/secrets.js";
import { browserConsoleService, type BrowserConsoleService } from "./service.js";
import { readScreenConsoleSettings, screenConsoleClient } from "./screen-console-client.js";
import { BROWSER_CONSOLE_SECRET_KEY_NAME, readBrowserConsoleSettings } from "./settings.js";
import { browserConsoleRoutes } from "./routes.js";
import { registerBrowserConsoleMcpGuard } from "./mcp-guard.js";

let registered: BrowserConsoleService | null = null;

/** The service the MCP guard uses; null before the first wiring. */
export function getBrowserConsoleService(): BrowserConsoleService | null {
  return registered;
}

export function myrmidonBrowserConsoleRoutes(db: Db) {
  const secrets = secretService(db);

  // Part B: the screen token is signed with the same company secret the fleet
  // console uses (`guacamole-json-secret-key` in the panel secret store) —
  // one name, one value, not duplicated. A secret that is missing or cannot
  // be resolved reads as null, and the service answers 503.
  async function readSecretKey(companyId: string): Promise<string | null> {
    try {
      const secret = await secrets.getByKey(companyId, BROWSER_CONSOLE_SECRET_KEY_NAME);
      if (!secret) return null;
      return await secrets.resolveSecretValue(companyId, secret.id, "latest");
    } catch (err) {
      logger.warn({ err, companyId, secretKey: BROWSER_CONSOLE_SECRET_KEY_NAME }, "browser console secret could not be resolved");
      return null;
    }
  }

  const service = browserConsoleService({
    db,
    client: screenConsoleClient(readScreenConsoleSettings() ?? { host: "http://localhost.invalid", token: "unset" }),
    settings: readBrowserConsoleSettings(),
    readSecretKey,
  });
  registered = service;
  registerBrowserConsoleMcpGuard(service);
  return browserConsoleRoutes({ service });
}

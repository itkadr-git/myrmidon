// myrmidon(GOOGLE-AI-CONNECT-UI): wiring for app.ts and index.ts.
//
// One process-wide service: the owner routes and the agent call surface share
// the same state. The owner connects by pasting their exported cookie bundle;
// the bundle lands in a company secret of the instance's secret store
// (write-only from the UI's point of view) and reaches the bridge through the
// session-delivery route (mode `endpoint`) or a rotation hook (mode `hook`).
// The bridge base URL and the delivery token come from the environment (our
// production values live in the deploy repository); with none set, the
// connector still serves the state/grant/journal surface, health probes answer
// "bridge unreachable", and generation calls are refused.

import type { Db } from "@paperclipai/db";
import { Router } from "express";
import type { GaiDeliveryMode } from "@paperclipai/shared/myrmidon-google-ai-connector";
import { gaiBridgeClient, type GaiBridgeClient } from "./bridge.js";
import { secretGaiSessionStore } from "./session-store.js";
import type { GaiSessionStore } from "./types.js";
import { googleAiConnectorService, type GoogleAiConnectorService } from "./service.js";
import { googleAiConnectorRoutes } from "./routes.js";
import { agentRoleFromDb, dbGoogleAiConnectorStore, type GoogleAiConnectorStore } from "./store.js";

export interface GoogleAiConnectorWiringOptions {
  /** Override for tests; production uses the instance settings row. */
  store?: GoogleAiConnectorStore;
  /** Override for tests; production uses the instance secret store. */
  session?: GaiSessionStore;
  /** Override for tests; production calls the bridge over the internal net. */
  bridge?: GaiBridgeClient;
  /** Override for tests. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface GoogleAiConnectorWiring {
  routes: Router;
  service: GoogleAiConnectorService;
}

function readDeliveryMode(env: NodeJS.ProcessEnv): GaiDeliveryMode {
  const raw = env.MYRMIDON_GOOGLE_AI_DELIVERY?.trim();
  if (raw === "endpoint" || raw === "hook") return raw;
  return "off";
}

export function createGoogleAiConnector(options: { db: Db } & GoogleAiConnectorWiringOptions): GoogleAiConnectorWiring {
  const env = options.env ?? process.env;
  const documentStore = options.store ?? dbGoogleAiConnectorStore(options.db);
  const sessionStore = options.session ?? secretGaiSessionStore(options.db);
  const baseUrl = env.MYRMIDON_GOOGLE_AI_BRIDGE_URL?.trim() || null;
  const bridge =
    options.bridge ??
    gaiBridgeClient({ baseUrl: () => baseUrl, fetchImpl: options.fetchImpl });
  const service = googleAiConnectorService({
    store: documentStore,
    session: sessionStore,
    bridge,
    agentRole: agentRoleFromDb(options.db),
    deliveryMode: readDeliveryMode(env),
  });
  const deliveryToken = env.MYRMIDON_GOOGLE_AI_DELIVERY_TOKEN?.trim() || null;

  const router = Router();
  router.use(
    googleAiConnectorRoutes({
      service,
      session: sessionStore,
      bridgeDeliveryToken: () => deliveryToken,
    }),
  );
  return { routes: router, service };
}

export function myrmidonGoogleAiConnectorRoutes(db: Db, options: GoogleAiConnectorWiringOptions = {}) {
  return createGoogleAiConnector({ db, ...options }).routes;
}

export { googleAiConnectorService, type GoogleAiConnectorService } from "./service.js";
export { googleAiConnectorRoutes } from "./routes.js";
export { gaiBridgeClient, type GaiBridgeClient } from "./bridge.js";
export { secretGaiSessionStore, memoryGaiSessionStore } from "./session-store.js";
export { dbGoogleAiConnectorStore, memoryGoogleAiConnectorStore } from "./store.js";
export { GoogleAiConnectorError, type GaiAgentIdentity, type GaiSessionStore } from "./types.js";
export { parseCookiePaste, CookiePasteError } from "./cookies.js";
export {
  googleAiSweepOnce,
  startGoogleAiSweep,
  readGoogleAiSweepIntervalMs,
  GOOGLE_AI_SWEEP_INTERVAL_SEC_ENV,
  staleOwnerMessage,
  type GoogleAiSweepDeps,
} from "./sweep.js";

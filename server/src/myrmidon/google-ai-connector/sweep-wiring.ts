// myrmidon(GOOGLE-AI-CONNECT-UI): sweep wiring for index.ts.
//
// Builds the production sweep: the same document store and bridge client the
// routes use (service via createGoogleAiConnector) and the owner notifier on
// the board's Telegram outbox. A no-op while no company has a Google AI
// connection — the tick costs one settings read per interval.

import type { Db } from "@paperclipai/db";
import { createGoogleAiConnector } from "./index.js";
import { googleAiOwnerNotifier } from "./notify.js";
import { startGoogleAiSweep } from "./sweep.js";

export function startGoogleAiSweepWithNotify(db: Db): () => void {
  const { service } = createGoogleAiConnector({ db });
  return startGoogleAiSweep({ service, notify: googleAiOwnerNotifier(db) });
}

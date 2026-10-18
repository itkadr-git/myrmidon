// myrmidon(SERVER-ONBOARD A): wiring for app.ts.
//
// Mounts the onboard routes with real deps: the onboard store, the panel
// secret port and registry lookups through the onboard store itself, so the
// console and onboarding share one myrmidon_fleet_servers registry.

import type { Db } from "@paperclipai/db";
import { onboardRoutes } from "./routes.js";
import { onboardService, panelSecretPort } from "./service.js";
import { readFleetOnboardSettings } from "./settings.js";
import { fleetOnboardStore } from "./store.js";

export function myrmidonOnboardRoutes(db: Db) {
  const store = fleetOnboardStore(db);
  const service = onboardService(db, {
    store,
    settings: readFleetOnboardSettings(),
    secrets: panelSecretPort(db),
    getServer: async (companyId, serverId) => {
      const row = await store.getServerById(companyId, serverId);
      if (!row) return null;
      return {
        id: row.id,
        slug: row.slug,
        hostname: row.hostname,
        port: row.port,
        username: row.username,
        protocol: row.protocol,
        passwordSecretKey: row.passwordSecretKey,
        accessKeySecretKey: row.accessKeySecretKey,
        hostKeyFingerprint: row.hostKeyFingerprint,
        role: row.role,
        keepPassword: row.keepPassword,
      };
    },
  });
  return onboardRoutes({ service });
}

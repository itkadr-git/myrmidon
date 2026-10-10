// server/src/myrmidon/monitoring/dashboard/routes.ts
// myrmidon(1.6.6 MONITORING C): the fleet dashboard API.
//
//   GET   /api/myrmidon/monitoring                    (board; connection settings — secret REFS only)
//   PATCH /api/myrmidon/monitoring                    (instance admin; additive merge)
//   GET   /api/myrmidon/monitoring/dashboard          (board; one aggregated snapshot)
//   GET   /api/myrmidon/monitoring/dashboard/selfcheck (board; per-source probe, no secrets)
//
// Part B shipped no base route on main; this part C introduces the shared
// base route. Any later part extends the stored settings document additively
// (unknown keys are preserved verbatim on write). The routes never resolve or
// return a secret VALUE — only the env:/file: reference names.
//
// Both sources are read-only by construction (VM `/api/v1/query`, Zabbix
// `host.get`/`item.get`/`apiinfo.version`); the module performs no write
// against either system.

import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { validate } from "../../../middleware/validate.js";
import {
  assertBoard,
  assertCompanyAccess,
  assertInstanceAdmin,
} from "../../../routes/authz.js";
import {
  createDbMonitoringSettingsStore,
  monitoringConnectionPatchSchema,
  monitoringSettingsView,
  type MonitoringSettingsStore,
} from "./settings.js";
import { vmClient } from "./vm.js";
import { zabbixReadClient } from "./zabbix.js";
import { buildDashboardView, buildSelfcheckView } from "./service.js";

export interface MonitoringDashboardRoutesDeps {
  db: Db;
  /** Injectable for tests. */
  settingsStore?: MonitoringSettingsStore;
  /** Injectable for tests: build the source clients from settings. */
  clients?: (settings: Awaited<ReturnType<MonitoringSettingsStore["get"]>>) => {
    vm: ReturnType<typeof vmClient> | null;
    zabbix: ReturnType<typeof zabbixReadClient> | null;
  };
  now?: () => Date;
}

export function monitoringDashboardRoutes(deps: MonitoringDashboardRoutesDeps) {
  const router = Router();
  const settingsStore = deps.settingsStore ?? createDbMonitoringSettingsStore(deps.db);
  const makeClients =
    deps.clients ??
    ((settings: Awaited<ReturnType<MonitoringSettingsStore["get"]>>) => ({
      vm: settings.vmUrl
        ? vmClient({ url: settings.vmUrl, tokenRef: settings.vmTokenRef, timeoutMs: settings.timeoutMs })
        : null,
      zabbix: settings.zabbixUrl
        ? zabbixReadClient({
            url: settings.zabbixUrl,
            tokenRef: settings.zabbixTokenRef,
            hostGroups: settings.zabbixHostGroups,
            timeoutMs: settings.timeoutMs,
          })
        : null,
    }));

  function resolveCompanyId(req: Request): string {
    const fromQuery = typeof req.query.companyId === "string" ? req.query.companyId : null;
    if (fromQuery) {
      assertCompanyAccess(req, fromQuery);
      return fromQuery;
    }
    const actor = req.actor as { companyIds?: string[]; isInstanceAdmin?: boolean; source?: string };
    const ids = actor.companyIds ?? [];
    if (ids.length === 1) return ids[0];
    if (actor.isInstanceAdmin || actor.source === "local_implicit") {
      if (ids.length === 1) return ids[0];
      return "default";
    }
    return ids[0] ?? "default";
  }

  router.get("/myrmidon/monitoring", async (req, res) => {
    assertBoard(req);
    const companyId = resolveCompanyId(req);
    res.json(monitoringSettingsView(await settingsStore.get(companyId)));
  });

  router.patch(
    "/myrmidon/monitoring",
    validate(monitoringConnectionPatchSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const companyId = resolveCompanyId(req);
      const updated = await settingsStore.patch(companyId, req.body);
      res.json(monitoringSettingsView(updated));
    },
  );

  router.get("/myrmidon/monitoring/dashboard", async (req, res) => {
    assertBoard(req);
    const companyId = resolveCompanyId(req);
    const settings = await settingsStore.get(companyId);
    const clients = makeClients(settings);
    res.json(
      await buildDashboardView({
        settings,
        vm: clients.vm,
        zabbix: clients.zabbix,
        now: deps.now,
      }),
    );
  });

  router.get("/myrmidon/monitoring/dashboard/selfcheck", async (req, res) => {
    assertBoard(req);
    const companyId = resolveCompanyId(req);
    const settings = await settingsStore.get(companyId);
    const clients = makeClients(settings);
    res.json(
      await buildSelfcheckView({
        settings,
        vm: clients.vm,
        zabbix: clients.zabbix,
      }),
    );
  });

  return router;
}

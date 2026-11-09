// server/src/myrmidon/bot-containers/fleetd-routing.ts
//
// myrmidon(FLEETD-VMEXEC): one BotContainerDriver in front of many hosts. The
// reconciler (reconciler.ts) and "apply now" (index.ts) keep their single
// `deps.driver` field; this driver routes each call by the bot's host, taken
// from the agent's card (adapterConfig.container.host, cardFleetHost):
//   - default host (no name): the local driver, exactly as before;
//   - a named host: that host's fleetd client.
//
// The host map is resolved per call from the sweep's agent record, so a card
// edit moves a bot on the next tick without a restart. The fleet clients are
// built once per host (their token is resolved by the wiring, not here).
//
// Error discipline: a card naming a host that is not in the map throws — an
// unknown host must surface as a reconcile error, never fall back to the
// local driver (a bot would silently run on the wrong machine).
//
// Optional methods: the router is typed `Required<BotContainerDriver>`, so every
// optional method of the interface is answered here whatever the host behind it
// supports. A service that tests `driver.method` for presence (reconciler,
// clone-report collector, git-store route, IDLE-STOP) sees a router that always
// has it; the router therefore keeps each method's "driver without it" answer:
//   - updateResources: the host's, else `recreate`;
//   - stopIdle: the host's, else the IDLE-STOP "not supported" error;
//   - statusWithDrift: the host's, else `status` + `templateDrift` (what the
//     reconciler does with a driver that lacks the probe);
//   - listRunning: the host's, else `list` filtered to running;
//   - readCloneReport / readBotSkills: the host's, else null ("nothing to read").
// A router that forwarded only the required methods silently turned all of the
// above off for every bot (IDLE-STOP: "idle-stop route is not supported by this
// driver" on each sweep).

import { cardFleetHost, fleetSiteKey, type FleetHostConfig } from "./fleetd-hosts.js";
import {
  IDLE_STOP_UNSUPPORTED_MESSAGE,
  type BotContainerDriver,
  type BotContainerSpec,
  type BotContainerStatus,
  type BotSkillDirectory,
  type TemplateDriftReport,
} from "./driver.js";
import type { CompiledProfile } from "./types.js";
import type { DriverOomEvent } from "./container-oom.js";

export interface FleetRoutingDeps {
  /** The local docker driver (default host). */
  local: BotContainerDriver;
  /**
   * A fleetd client per configured host name (static env map), or a provider of
   * the current map. The provider is asked with the company of the bot's card and
   * returns only that company's clients by bare name; a routed call of a bot
   * without a companyId fails closed. Called without a company (list) it returns
   * all clients.
   */
  fleet: ReadonlyMap<string, BotContainerDriver> | ((companyId?: string) => ReadonlyMap<string, BotContainerDriver>);
  /**
   * Awaited before every routing decision: lets a dynamic registry reload its
   * clients (hot-reload) so a CRUD change applies without a server restart.
   * A failure here must not break routing — the last good map is used.
   */
  ready?: () => Promise<void>;
}

/** The per-bot agent record the routing needs: the container block of the card. */
export interface RoutedBotAgent {
  /** The agent's company: when set, the host is looked up company-scoped (fleetSiteKey). */
  companyId?: string;
  adapterConfig: { container?: unknown };
}

function resolveFleetMap(deps: FleetRoutingDeps, companyId?: string): ReadonlyMap<string, BotContainerDriver> {
  return typeof deps.fleet === "function" ? deps.fleet(companyId) : deps.fleet;
}

async function awaitReady(deps: FleetRoutingDeps): Promise<void> {
  if (!deps.ready) return;
  try {
    await deps.ready();
  } catch {
    // keep routing on the last good client map
  }
}

async function driverFor(
  deps: FleetRoutingDeps,
  agentOrPromise: RoutedBotAgent | undefined | Promise<RoutedBotAgent | undefined>,
): Promise<BotContainerDriver> {
  await awaitReady(deps);
  const agent = await agentOrPromise;
  const host = agent ? cardFleetHost(agent.adapterConfig) : null;
  if (host === null) return deps.local;
  // Tenant isolation: a provider is asked for the agent's own company only, and
  // a call without a companyId is refused (fail-closed). A static env map keeps
  // the bare name (no company-scoped sites there).
  if (typeof deps.fleet === "function" && !agent?.companyId) {
    throw new Error(`container.host "${host}" cannot be routed: the bot's card has no companyId`);
  }
  const fleetMap = resolveFleetMap(deps, agent?.companyId);
  const driver = fleetMap.get(typeof deps.fleet !== "function" && agent?.companyId ? fleetSiteKey(agent.companyId, host) : host);
  if (!driver) {
    throw new Error(
      `container.host "${host}" names no configured fleet host (check MYRMIDON_FLEET_HOSTS or fleet sites registry)`,
    );
  }
  return driver;
}

/** A driver whose every call is routed by the bot's card host. */
export function fleetRoutingDriver(
  deps: FleetRoutingDeps,
  agentOf: (botKey: string) => RoutedBotAgent | undefined | Promise<RoutedBotAgent | undefined>,
): BotContainerDriver {
  // `Required`: adding an optional method to BotContainerDriver without routing it here is a
  // compile error, not a feature that quietly stops working behind the router.
  const routed: Required<BotContainerDriver> = {
    async status(botKey: string): Promise<BotContainerStatus> {
      const driver = await driverFor(deps, agentOf(botKey));
      return driver.status(botKey);
    },
    async list(botKeys: readonly string[]): Promise<BotContainerStatus[]> {
      await awaitReady(deps);
      const fleetMap = resolveFleetMap(deps);
      // A routed list is the union of all hosts' own lists.
      const results = await Promise.all(
        [deps.local, ...fleetMap.values()].map((driver) => driver.list(botKeys)),
      );
      return results.flat();
    },
    async listRunning(botKeys: readonly string[]): Promise<BotContainerStatus[]> {
      await awaitReady(deps);
      const fleetMap = resolveFleetMap(deps);
      // The union of all hosts' running bots; a host without the probe (fleetd) is asked
      // through `list` and filtered, which is what the caller does with a driver lacking it.
      const results = await Promise.all(
        [deps.local, ...fleetMap.values()].map(async (driver) =>
          driver.listRunning
            ? driver.listRunning(botKeys)
            : (await driver.list(botKeys)).filter((bot) => bot.state === "running"),
        ),
      );
      return results.flat();
    },
    async statusWithDrift(spec: BotContainerSpec): Promise<{ status: BotContainerStatus; drift: TemplateDriftReport }> {
      const driver = await driverFor(deps, agentOf(spec.botKey));
      if (driver.statusWithDrift) return driver.statusWithDrift(spec);
      // A host without the one-inspect probe (fleetd): the reconciler's own fallback, the
      // status and then the drift check on that status. No container, no drift to report.
      const status = await driver.status(spec.botKey);
      if (status.state === "missing") return { status, drift: { drifted: false, fields: [] } };
      return { status, drift: await driver.templateDrift(spec, status) };
    },
    async templateDrift(spec: BotContainerSpec, knownStatus?: BotContainerStatus): Promise<TemplateDriftReport> {
      const driver = await driverFor(deps, agentOf(spec.botKey));
      return driver.templateDrift(spec, knownStatus);
    },
    async updateResources(spec: BotContainerSpec): Promise<void> {
      const driver = await driverFor(deps, agentOf(spec.botKey));
      if (driver.updateResources) await driver.updateResources(spec);
      else await driver.recreate(spec);
    },
    async create(spec: BotContainerSpec): Promise<void> {
      const driver = await driverFor(deps, agentOf(spec.botKey));
      await driver.create(spec);
    },
    async recreate(spec: BotContainerSpec): Promise<void> {
      const driver = await driverFor(deps, agentOf(spec.botKey));
      await driver.recreate(spec);
    },
    async writeProfile(botKey: string, profile: CompiledProfile): Promise<void> {
      const driver = await driverFor(deps, agentOf(botKey));
      await driver.writeProfile(botKey, profile);
    },
    async start(botKey: string): Promise<void> {
      const driver = await driverFor(deps, agentOf(botKey));
      await driver.start(botKey);
    },
    async restart(botKey: string): Promise<void> {
      const driver = await driverFor(deps, agentOf(botKey));
      await driver.restart(botKey);
    },
    async stop(botKey: string): Promise<void> {
      const driver = await driverFor(deps, agentOf(botKey));
      await driver.stop(botKey);
    },
    async stopIdle(botKey: string): Promise<void> {
      const driver = await driverFor(deps, agentOf(botKey));
      if (!driver.stopIdle) throw new Error(IDLE_STOP_UNSUPPORTED_MESSAGE);
      await driver.stopIdle(botKey);
    },
    async readCloneReport(botKey: string): Promise<string | null> {
      const driver = await driverFor(deps, agentOf(botKey));
      return driver.readCloneReport ? driver.readCloneReport(botKey) : null;
    },
    async readBotSkills(botKey: string): Promise<BotSkillDirectory[] | null> {
      const driver = await driverFor(deps, agentOf(botKey));
      return driver.readBotSkills ? driver.readBotSkills(botKey) : null;
    },
    async getOomEvents(sinceNano?: number): Promise<DriverOomEvent[]> {
      await awaitReady(deps);
      const drivers = [deps.local, ...resolveFleetMap(deps).values()];
      const settled = await Promise.allSettled(
        drivers.map(async (d) => (d.getOomEvents ? d.getOomEvents(sinceNano) : [])),
      );
      const events: DriverOomEvent[] = [];
      for (const res of settled) {
        if (res.status === "fulfilled" && Array.isArray(res.value)) {
          events.push(...res.value);
        }
      }
      return events;
    },
  };
  return routed;
}

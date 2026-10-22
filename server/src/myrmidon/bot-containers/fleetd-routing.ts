// server/src/myrmidon/bot-containers/fleetd-routing.ts
//
// myrmidon(FLEETD-VMEXEC): one BotContainerDriver in front of many hosts. The
// reconciler (reconciler.ts) and "apply now" (index.ts) keep their single
// `deps.driver` field; this driver routes each call by the bot's host, taken
// from the agent's card (adapterConfig.container.site, or the legacy .host; cardFleetPlacement):
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

import { cardFleetPlacement } from "./fleetd-hosts.js";
import type { BotContainerDriver, BotContainerSpec, BotContainerStatus, TemplateDriftReport } from "./driver.js";
import type { CompiledProfile } from "./types.js";

export interface FleetRoutingDeps {
  /** The local docker driver (default host). */
  local: BotContainerDriver;
  /** A fleetd client per configured host/site name, or a provider of the current
   *  map (the registry changes while the board runs). The provider gets the
   *  company of the bot's card, so two companies' sites of the same name never
   *  mix; without a company (a card read without one) it has nothing routable
   *  and the call fails closed. */
  fleet: ReadonlyMap<string, BotContainerDriver> | ((companyId?: string) => ReadonlyMap<string, BotContainerDriver>);
  /** Resolves when the first load of the registry is done; every call waits for it. */
  ready?: Promise<unknown>;
  /** Called when an optional driver method is asked for a bot placed on a remote
   *  site whose driver does not have it (listing, skills back-import, clone
   *  report): the call degrades to "nothing" instead of reaching a wrong host. */
  onRemoteUnsupported?: (method: string, botKey: string) => void;
}

/** The per-bot agent record the routing needs: the container block of the card. */
export interface RoutedBotAgent {
  adapterConfig: { container?: unknown };
  companyId?: string;
}

function resolveFleetMap(deps: FleetRoutingDeps, companyId?: string): ReadonlyMap<string, BotContainerDriver> {
  return typeof deps.fleet === "function" ? deps.fleet(companyId) : deps.fleet;
}

// Fail-closed: an error from `agentOf` (for example the card could not be read)
// propagates. Only a card that was read and names no site/host, or no card at
// all, is local; a failed read must never turn a remote bot into a local one.
// `hostPinned` is not read here: pinning is for the automatic mover, the router
// always follows the card.
async function routeFor(
  deps: FleetRoutingDeps,
  readAgent: () => RoutedBotAgent | undefined | Promise<RoutedBotAgent | undefined>,
): Promise<{ driver: BotContainerDriver; remote: boolean }> {
  if (deps.ready) await deps.ready;
  const agent = await readAgent();
  const placement = agent ? cardFleetPlacement(agent.adapterConfig) : null;
  if (placement === null) return { driver: deps.local, remote: false };
  const driver = resolveFleetMap(deps, agent?.companyId).get(placement.name);
  if (!driver) {
    throw new Error(
      placement.field === "site"
        ? `container.site "${placement.name}" names no active site in the fleet sites registry (check the registry or MYRMIDON_FLEET_HOSTS)`
        : `container.host "${placement.name}" names no configured fleet host (check MYRMIDON_FLEET_HOSTS)`,
    );
  }
  return { driver, remote: true };
}

async function driverFor(
  deps: FleetRoutingDeps,
  readAgent: () => RoutedBotAgent | undefined | Promise<RoutedBotAgent | undefined>,
): Promise<BotContainerDriver> {
  return (await routeFor(deps, readAgent)).driver;
}

/** A driver whose every call is routed by the bot's card host. */
export function fleetRoutingDriver(
  deps: FleetRoutingDeps,
  agentOf: (botKey: string) => RoutedBotAgent | undefined | Promise<RoutedBotAgent | undefined>,
): BotContainerDriver {
  const routed: BotContainerDriver = {
    async status(botKey: string): Promise<BotContainerStatus> {
      const driver = await driverFor(deps, () => agentOf(botKey));
      return driver.status(botKey);
    },
    async list(botKeys: readonly string[]): Promise<BotContainerStatus[]> {
      if (deps.ready) await deps.ready;
      const fleetMap = resolveFleetMap(deps);
      // A routed list is the union of all hosts' own lists.
      const results = await Promise.all(
        [deps.local, ...fleetMap.values()].map((driver) => driver.list(botKeys)),
      );
      return results.flat();
    },
    async templateDrift(spec: BotContainerSpec, knownStatus?: BotContainerStatus): Promise<TemplateDriftReport> {
      const driver = await driverFor(deps, () => agentOf(spec.botKey));
      return driver.templateDrift(spec, knownStatus);
    },
    async create(spec: BotContainerSpec): Promise<void> {
      const driver = await driverFor(deps, () => agentOf(spec.botKey));
      await driver.create(spec);
    },
    async recreate(spec: BotContainerSpec): Promise<void> {
      const driver = await driverFor(deps, () => agentOf(spec.botKey));
      await driver.recreate(spec);
    },
    async writeProfile(botKey: string, profile: CompiledProfile): Promise<void> {
      const driver = await driverFor(deps, () => agentOf(botKey));
      await driver.writeProfile(botKey, profile);
    },
    async start(botKey: string): Promise<void> {
      const driver = await driverFor(deps, () => agentOf(botKey));
      await driver.start(botKey);
    },
    async restart(botKey: string): Promise<void> {
      const driver = await driverFor(deps, () => agentOf(botKey));
      await driver.restart(botKey);
    },
    async stop(botKey: string): Promise<void> {
      const driver = await driverFor(deps, () => agentOf(botKey));
      await driver.stop(botKey);
    },
  };

  // Optional methods. The local driver has them and the board relies on them for
  // local bots (one-inspect probe, clone reports, skills back-import), so they are
  // kept for local bots. They are never proxied blindly to a remote site: a remote
  // bot gets the method of its own site's driver if it has one, else the plain
  // fallback or "nothing" (a remote bot keeps no skills back-import, v1 degradation).
  const local = deps.local;
  if (local.listRunning) {
    // Local containers only: a running-list of remote sites is not available in v1.
    routed.listRunning = async (botKeys) => {
      if (deps.ready) await deps.ready;
      return local.listRunning!(botKeys);
    };
  }
  if (local.statusWithDrift) {
    routed.statusWithDrift = async (spec) => {
      const { driver, remote } = await routeFor(deps, () => agentOf(spec.botKey));
      if (!remote) return local.statusWithDrift!(spec);
      if (driver.statusWithDrift) return driver.statusWithDrift(spec);
      const status = await driver.status(spec.botKey);
      return { status, drift: await driver.templateDrift(spec, status) };
    };
  }
  if (local.readCloneReport) {
    routed.readCloneReport = async (botKey) => {
      const { driver, remote } = await routeFor(deps, () => agentOf(botKey));
      if (driver.readCloneReport) return driver.readCloneReport(botKey);
      if (remote) deps.onRemoteUnsupported?.("readCloneReport", botKey);
      return null;
    };
  }
  if (local.readBotSkills) {
    routed.readBotSkills = async (botKey) => {
      const { driver, remote } = await routeFor(deps, () => agentOf(botKey));
      if (driver.readBotSkills) return driver.readBotSkills(botKey);
      if (remote) deps.onRemoteUnsupported?.("readBotSkills", botKey);
      return null;
    };
  }
  return routed;
}

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

import { cardFleetHost, type FleetHostConfig } from "./fleetd-hosts.js";
import type { BotContainerDriver, BotContainerSpec, BotContainerStatus, TemplateDriftReport } from "./driver.js";
import type { CompiledProfile } from "./types.js";

export interface FleetRoutingDeps {
  /** The local docker driver (default host). */
  local: BotContainerDriver;
  /** A fleetd client per configured host name, or a dynamic map provider. */
  fleet: ReadonlyMap<string, BotContainerDriver> | (() => ReadonlyMap<string, BotContainerDriver>);
}

/** The per-bot agent record the routing needs: the container block of the card. */
export interface RoutedBotAgent {
  adapterConfig: { container?: unknown };
}

function resolveFleetMap(deps: FleetRoutingDeps): ReadonlyMap<string, BotContainerDriver> {
  return typeof deps.fleet === "function" ? deps.fleet() : deps.fleet;
}

async function driverFor(
  deps: FleetRoutingDeps,
  agentOrPromise: RoutedBotAgent | undefined | Promise<RoutedBotAgent | undefined>,
): Promise<BotContainerDriver> {
  const agent = await agentOrPromise;
  const host = agent ? cardFleetHost(agent.adapterConfig) : null;
  if (host === null) return deps.local;
  const fleetMap = resolveFleetMap(deps);
  const driver = fleetMap.get(host);
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
  return {
    async status(botKey: string): Promise<BotContainerStatus> {
      const driver = await driverFor(deps, agentOf(botKey));
      return driver.status(botKey);
    },
    async list(botKeys: readonly string[]): Promise<BotContainerStatus[]> {
      const fleetMap = resolveFleetMap(deps);
      // A routed list is the union of all hosts' own lists.
      const results = await Promise.all(
        [deps.local, ...fleetMap.values()].map((driver) => driver.list(botKeys)),
      );
      return results.flat();
    },
    async templateDrift(spec: BotContainerSpec, knownStatus?: BotContainerStatus): Promise<TemplateDriftReport> {
      const driver = await driverFor(deps, agentOf(spec.botKey));
      return driver.templateDrift(spec, knownStatus);
    },
    async updateResources(spec: BotContainerSpec): Promise<void> {
      const driver = driverFor(deps, agentOf(spec.botKey));
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
  };
}

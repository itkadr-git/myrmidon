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
// myrmidon(1.6.7 FLEET-SITE-ENROLL): `list` and `listRunning` group the asked bot keys by the host
// of each card and ask every driver only for its own bots. Before, every key went to the local
// driver (dockergate answered `bot_not_enrolled` for a bot of a remote site, and one refused call
// failed the whole list) and to every site. A failure of one host does not fail the list: the
// bots of the hosts that answered are returned and the failure goes to `onHostError`. The list
// fails only when no host answered and at least one failed, so a total outage is not an empty list.
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
//   - readCloneReport / readBotSkills: the host's, else null ("nothing to read");
//   - decommission (OPE-12654): the host's, else the host's `cleanup` (fleetd removes the
//     container and the bot directory itself), else the "not supported" error.
// A router that forwarded only the required methods silently turned all of the
// above off for every bot (IDLE-STOP: "idle-stop route is not supported by this
// driver" on each sweep).

import { cardFleetHost, fleetSiteKey, type FleetHostConfig } from "./fleetd-hosts.js";
import {
  CLEANUP_UNSUPPORTED_MESSAGE,
  DECOMMISSION_UNSUPPORTED_MESSAGE,
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
  /**
   * Told when a host could not be asked in a routed `list` / `listRunning` (the host is unknown, its
   * client failed, or the bot's card could not be read). `host` is null for the local driver or when the
   * card names no readable host. Must not throw; a throw is swallowed.
   */
  onHostError?: (info: { host: string | null; botKeys: readonly string[]; error: unknown }) => void;
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

/** The fleet client of a named host; throws when the card cannot be routed there. */
function hostDriver(deps: FleetRoutingDeps, agent: RoutedBotAgent | undefined, host: string): BotContainerDriver {
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

async function driverFor(
  deps: FleetRoutingDeps,
  agentOrPromise: RoutedBotAgent | undefined | Promise<RoutedBotAgent | undefined>,
): Promise<BotContainerDriver> {
  await awaitReady(deps);
  const agent = await agentOrPromise;
  const host = agent ? cardFleetHost(agent.adapterConfig) : null;
  if (host === null) return deps.local;
  return hostDriver(deps, agent, host);
}

/** Bots whose card is read at the same time while a list is grouped. */
const AGENT_LOOKUP_CONCURRENCY = 8;

interface KeyGroup {
  host: string | null;
  driver: BotContainerDriver;
  botKeys: string[];
}

interface KeyFailure {
  host: string | null;
  botKeys: readonly string[];
  error: unknown;
}

type Target = { host: string | null; driver: BotContainerDriver } | { host: string | null; error: unknown };

/** The driver a card points at, or why it cannot be reached; never falls back to the local driver. */
function targetOf(deps: FleetRoutingDeps, agent: RoutedBotAgent | undefined): Target {
  let host: string | null = null;
  try {
    host = agent ? cardFleetHost(agent.adapterConfig) : null;
    return { host, driver: host === null ? deps.local : hostDriver(deps, agent, host) };
  } catch (error) {
    return { host, error };
  }
}

async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

/**
 * Asks every driver for its own bots only and joins the answers (see the header). The local driver
 * is first in the result, then the sites in the order their first bot appears.
 */
async function listAcrossHosts(
  deps: FleetRoutingDeps,
  agentOf: (botKey: string) => RoutedBotAgent | undefined | Promise<RoutedBotAgent | undefined>,
  botKeys: readonly string[],
  ask: (driver: BotContainerDriver, keys: readonly string[]) => Promise<BotContainerStatus[]>,
): Promise<BotContainerStatus[]> {
  await awaitReady(deps);
  const looked = await mapWithLimit(botKeys, AGENT_LOOKUP_CONCURRENCY, async (botKey) => {
    try {
      return { botKey, agent: await agentOf(botKey) } as const;
    } catch (error) {
      return { botKey, error } as const;
    }
  });
  const failures: KeyFailure[] = [];
  const byDriver = new Map<BotContainerDriver, KeyGroup>();
  for (const entry of looked) {
    if ("error" in entry) {
      failures.push({ host: null, botKeys: [entry.botKey], error: entry.error });
      continue;
    }
    const target = targetOf(deps, entry.agent);
    if ("error" in target) {
      failures.push({ host: target.host, botKeys: [entry.botKey], error: target.error });
      continue;
    }
    const group = byDriver.get(target.driver);
    if (group) group.botKeys.push(entry.botKey);
    else byDriver.set(target.driver, { host: target.host, driver: target.driver, botKeys: [entry.botKey] });
  }
  const groups = [...byDriver.values()].sort((a, b) => Number(b.driver === deps.local) - Number(a.driver === deps.local));

  const settled = await Promise.allSettled(groups.map((group) => ask(group.driver, group.botKeys)));
  const found: BotContainerStatus[] = [];
  let answered = 0;
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      answered += 1;
      found.push(...outcome.value);
    } else {
      const group = groups[index] as KeyGroup;
      failures.push({ host: group.host, botKeys: group.botKeys, error: outcome.reason });
    }
  });
  for (const failure of failures) {
    try {
      deps.onHostError?.(failure);
    } catch {
      // a broken reporter must not turn a partial list into a failed one
    }
  }
  if (answered === 0 && failures.length > 0) {
    const first = (failures[0] as KeyFailure).error;
    throw first instanceof Error ? first : new Error(String(first));
  }
  return found;
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
      // A routed list is the union of each host's list of its own bots.
      return listAcrossHosts(deps, agentOf, botKeys, (driver, keys) => driver.list(keys));
    },
    async listRunning(botKeys: readonly string[]): Promise<BotContainerStatus[]> {
      // The union of each host's running bots; a host without the probe (fleetd) is asked
      // through `list` and filtered, which is what the caller does with a driver lacking it.
      return listAcrossHosts(deps, agentOf, botKeys, async (driver, keys) =>
        driver.listRunning ? driver.listRunning(keys) : (await driver.list(keys)).filter((bot) => bot.state === "running"),
      );
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
    async cleanup(botKey: string): Promise<void> {
      const driver = await driverFor(deps, agentOf(botKey));
      if (!driver.cleanup) throw new Error(CLEANUP_UNSUPPORTED_MESSAGE);
      await driver.cleanup(botKey);
    },
    async decommission(botKey: string): Promise<void> {
      const driver = await driverFor(deps, agentOf(botKey));
      // myrmidon(OPE-12654): a host without the decommission route (fleetd) removes the
      // container and the bot directory in its own cleanup.
      if (driver.decommission) await driver.decommission(botKey);
      else if (driver.cleanup) await driver.cleanup(botKey);
      else throw new Error(DECOMMISSION_UNSUPPORTED_MESSAGE);
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

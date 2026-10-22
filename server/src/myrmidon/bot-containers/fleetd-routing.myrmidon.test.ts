import { describe, expect, it } from "vitest";

import { fleetRoutingDriver, type FleetRoutingDeps, type RoutedBotAgent } from "./fleetd-routing.js";
import type { BotContainerDriver, BotContainerSpec, BotContainerStatus } from "./driver.js";
import type { CompiledProfile } from "./types.js";

// Everything here is placeholder data: fake bot keys and statuses.

const spec = (botKey: string): BotContainerSpec => ({
  botKey,
  image: "example.com/bot@sha256:aa",
  memoryMb: 1024,
  cpus: 1,
  pidsLimit: 256,
  network: "net-a",
});

const profile: CompiledProfile = {
  botKey: "bot-a",
  files: [{ path: "hermes/config.yaml", content: "gateway: {}\n", mode: 0o644, secret: false }],
  restartHash: "r1",
  filesHash: "f1",
};

/** A driver that records every call and answers with a fixed status. */
function recordingDriver(name: string): BotContainerDriver & { calls: string[] } {
  const calls: string[] = [];
  const status: BotContainerStatus = { botKey: "bot-a", state: "running" };
  const driver: BotContainerDriver = {
    async status(botKey) {
      calls.push(`${name}:status:${botKey}`);
      return { ...status, botKey };
    },
    async list() {
      calls.push(`${name}:list`);
      return [status];
    },
    async templateDrift(s) {
      calls.push(`${name}:templateDrift:${s.botKey}`);
      return { drifted: false, fields: [] };
    },
    async create(s) {
      calls.push(`${name}:create:${s.botKey}`);
    },
    async recreate(s) {
      calls.push(`${name}:recreate:${s.botKey}`);
    },
    async writeProfile(botKey, p) {
      calls.push(`${name}:writeProfile:${botKey}:${p.restartHash}`);
    },
    async start(botKey) {
      calls.push(`${name}:start:${botKey}`);
    },
    async restart(botKey) {
      calls.push(`${name}:restart:${botKey}`);
    },
    async stop(botKey) {
      calls.push(`${name}:stop:${botKey}`);
    },
  };
  return Object.assign(driver, { calls });
}

function deps(): FleetRoutingDeps & { local: ReturnType<typeof recordingDriver>; fleetA: ReturnType<typeof recordingDriver> } {
  const local = recordingDriver("local");
  const fleetA = recordingDriver("fleet-a");
  return { local, fleetA, fleet: new Map([["host-a", fleetA]]) };
}

const agent = (host: string | null): RoutedBotAgent =>
  host === null ? { adapterConfig: {} } : { adapterConfig: { container: { host } } };

describe("myrmidon(FLEETD-VMEXEC) fleet routing — every driver call goes by the card's host", () => {
  it("routes to the local driver when the card names no host", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => agent(null));
    await routed.start("bot-a");
    await routed.stop("bot-a");
    expect(d.local.calls).toEqual(["local:start:bot-a", "local:stop:bot-a"]);
    expect(d.fleetA.calls).toEqual([]);
  });

  it("routes site-pinned cards to the named fleet client", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => ({ adapterConfig: { container: { site: "host-a", hostPinned: true } } }));
    await routed.start("bot-a");
    expect(d.fleetA.calls).toEqual(["fleet-a:start:bot-a"]);
    expect(d.local.calls).toEqual([]);
  });

  it("prefers a site slug over the legacy host field", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => ({ adapterConfig: { container: { site: "host-a", host: "host-b" } } }));
    await routed.stop("bot-a");
    expect(d.fleetA.calls).toEqual(["fleet-a:stop:bot-a"]);
  });

  it("routes legacy host cards to the configured fleet client", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => agent("host-a"));
    await routed.start("bot-a");
    expect(d.fleetA.calls).toEqual(["fleet-a:start:bot-a"]);
  });

  it("does not proxy optional driver methods that may be absent remotely", () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => agent("host-a"));
    expect(routed.listRunning).toBeUndefined();
    expect(routed.statusWithDrift).toBeUndefined();
    expect(routed.readCloneReport).toBeUndefined();
    expect(routed.readBotSkills).toBeUndefined();
  });

  it("routes to the named host's client", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => agent("host-a"));
    await routed.create(spec("bot-a"));
    await routed.writeProfile("bot-a", profile);
    await routed.restart("bot-a");
    expect(d.fleetA.calls).toEqual([
      "fleet-a:create:bot-a",
      "fleet-a:writeProfile:bot-a:r1",
      "fleet-a:restart:bot-a",
    ]);
    expect(d.local.calls).toEqual([]);
  });

  it("status and templateDrift route the same way", async () => {
    const d = deps();
    const agents = new Map<string, RoutedBotAgent>([
      ["bot-local", agent(null)],
      ["bot-fleet", agent("host-a")],
    ]);
    const routed = fleetRoutingDriver(d, (botKey) => agents.get(botKey));
    expect((await routed.status("bot-local")).state).toBe("running");
    expect((await routed.status("bot-fleet")).state).toBe("running");
    await routed.templateDrift(spec("bot-fleet"));
    expect(d.local.calls).toEqual(["local:status:bot-local"]);
    expect(d.fleetA.calls).toEqual(["fleet-a:status:bot-fleet", "fleet-a:templateDrift:bot-fleet"]);
  });

  it("an unknown agent record routes to the local driver (a missing card cannot strand a bot)", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => undefined);
    await routed.start("bot-a");
    expect(d.local.calls).toEqual(["local:start:bot-a"]);
  });

  it("a card naming a host that is not configured is an error, never a local fallback", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => agent("host-b"));
    await expect(routed.start("bot-a")).rejects.toThrow(/names no configured fleet host/);
    expect(d.local.calls).toEqual([]);
    expect(d.fleetA.calls).toEqual([]);
  });

  it("list is the union over the local driver and every fleet host", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => agent(null));
    const bots = await routed.list(["bot-a"]);
    expect(bots).toHaveLength(2);
    expect(d.local.calls).toEqual(["local:list"]);
    expect(d.fleetA.calls).toEqual(["fleet-a:list"]);
  });

  it("supports dynamic fleet map provider (hot-reload)", async () => {
    const local = recordingDriver("local");
    const fleetA = recordingDriver("fleet-a");
    const fleetB = recordingDriver("fleet-b");
    let currentMap = new Map<string, BotContainerDriver>([["host-a", fleetA]]);

    const routed = fleetRoutingDriver({ local, fleet: () => currentMap }, () => agent("host-b"));

    // host-b is not in currentMap yet
    await expect(routed.start("bot-b")).rejects.toThrow(/names no configured fleet host/);

    // hot-reload updates the map
    currentMap = new Map<string, BotContainerDriver>([["host-a", fleetA], ["host-b", fleetB]]);
    await routed.start("bot-b");
    expect(fleetB.calls).toEqual(["fleet-b:start:bot-b"]);
  });

  it("supports async agentOf resolution", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, async (botKey) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return agent(botKey === "remote" ? "host-a" : null);
    });

    await routed.start("remote");
    await routed.start("local");

    expect(d.fleetA.calls).toEqual(["fleet-a:start:remote"]);
    expect(d.local.calls).toEqual(["local:start:local"]);
  });
  it("an error reading the card propagates: no local fallback", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, async () => {
      throw new Error("card read failed");
    });
    await expect(routed.create(spec("bot-a"))).rejects.toThrow("card read failed");
    await expect(routed.start("bot-a")).rejects.toThrow("card read failed");
    expect(d.local.calls).toEqual([]);
    expect(d.fleetA.calls).toEqual([]);
  });

  it("a card naming an unknown site is an error that names the site registry", async () => {
    const d = deps();
    const routed = fleetRoutingDriver(d, () => ({ adapterConfig: { container: { site: "site-x" } } }));
    await expect(routed.start("bot-a")).rejects.toThrow(/container\.site "site-x" names no active site/);
    expect(d.local.calls).toEqual([]);
  });

  it("passes the company of the card to a fleet map provider", async () => {
    const d = deps();
    const seen: Array<string | undefined> = [];
    const routed = fleetRoutingDriver(
      {
        local: d.local,
        fleet: (companyId) => {
          seen.push(companyId);
          return companyId === "company-1" ? new Map([["host-a", d.fleetA]]) : new Map();
        },
      },
      (botKey) => ({ adapterConfig: { container: { site: "host-a" } }, companyId: botKey === "bot-1" ? "company-1" : "company-2" }),
    );
    await routed.start("bot-1");
    expect(d.fleetA.calls).toEqual(["fleet-a:start:bot-1"]);
    await expect(routed.start("bot-2")).rejects.toThrow(/names no active site/);
    expect(seen).toEqual(["company-1", "company-2"]);
  });

  it("waits for the registry's first load (ready) before routing", async () => {
    const d = deps();
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const routed = fleetRoutingDriver({ ...d, ready }, () => agent("host-a"));
    const pending = routed.start("bot-a");
    await Promise.resolve();
    expect(d.fleetA.calls).toEqual([]);
    release();
    await pending;
    expect(d.fleetA.calls).toEqual(["fleet-a:start:bot-a"]);
  });
});

describe("myrmidon(1.6.6 T3) fleet routing — optional driver methods", () => {
  function withOptional(name: string) {
    const base = recordingDriver(name);
    const calls = base.calls;
    return Object.assign(base, {
      async listRunning() {
        calls.push(`${name}:listRunning`);
        return [];
      },
      async statusWithDrift(s: BotContainerSpec) {
        calls.push(`${name}:statusWithDrift:${s.botKey}`);
        return { status: { botKey: s.botKey, state: "running" as const }, drift: { drifted: false, fields: [] } };
      },
      async readCloneReport(botKey: string) {
        calls.push(`${name}:readCloneReport:${botKey}`);
        return "report";
      },
      async readBotSkills(botKey: string) {
        calls.push(`${name}:readBotSkills:${botKey}`);
        return [];
      },
    });
  }

  it("keeps them for local bots", async () => {
    const local = withOptional("local");
    const fleetA = recordingDriver("fleet-a");
    const routed = fleetRoutingDriver({ local, fleet: new Map([["host-a", fleetA]]) }, () => agent(null));
    expect(await routed.readCloneReport?.("bot-a")).toBe("report");
    expect(await routed.readBotSkills?.("bot-a")).toEqual([]);
    await routed.statusWithDrift?.(spec("bot-a"));
    await routed.listRunning?.(["bot-a"]);
    expect(local.calls).toEqual([
      "local:readCloneReport:bot-a",
      "local:readBotSkills:bot-a",
      "local:statusWithDrift:bot-a",
      "local:listRunning",
    ]);
    expect(fleetA.calls).toEqual([]);
  });

  it("does not hand a remote bot to the local driver's optional methods: skills and clone report are skipped and logged, drift uses status + templateDrift", async () => {
    const local = withOptional("local");
    const fleetA = recordingDriver("fleet-a");
    const skipped: string[] = [];
    const routed = fleetRoutingDriver(
      { local, fleet: new Map([["host-a", fleetA]]), onRemoteUnsupported: (method) => skipped.push(method) },
      () => agent("host-a"),
    );
    expect(await routed.readCloneReport?.("bot-a")).toBeNull();
    expect(await routed.readBotSkills?.("bot-a")).toBeNull();
    const probed = await routed.statusWithDrift?.(spec("bot-a"));
    expect(probed?.status.state).toBe("running");
    expect(skipped).toEqual(["readCloneReport", "readBotSkills"]);
    expect(local.calls).toEqual([]);
    expect(fleetA.calls).toEqual(["fleet-a:status:bot-a", "fleet-a:templateDrift:bot-a"]);
  });
});

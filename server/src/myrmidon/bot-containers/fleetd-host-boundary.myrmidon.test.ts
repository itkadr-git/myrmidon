import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FLEETD_PACKAGE_CACHE_NOTICE,
  FleetdDriverError,
  fleetdBotContainerDriver,
  parseFleetdEndpoint,
  type FleetdDriverConfig,
} from "./fleetd-driver.js";
import {
  fleetRoutingDriver,
  type FleetRoutingDeps,
  type RoutedBotAgent,
} from "./fleetd-routing.js";
import { fleetGatewayApiBaseUrl } from "./fleetd-placement.js";
import {
  FLEET_HOSTS_ENV,
  cardFleetHost,
  parseFleetHosts,
  type FleetHostConfig,
} from "./fleetd-hosts.js";
import {
  BOT_MOUNT_SOURCES_ENV,
  BotContainerTemplateError,
  devbuildContainerEnv,
  devbuildKeyMount,
  parseDevbuildSettings,
  parseMountSourceAllowlist,
  validateExtraMounts,
} from "./template.js";
import {
  BOT_CONTAINERS_ENV,
  isBotContainersEnabled,
} from "./agent-config.js";
import { startBotContainers } from "./startup.js";
import {
  applyBotContainerNow,
  type BotContainerAgent,
  type BotContainerRuntimeDeps,
} from "./index.js";
import { listEnabledServerAdapters } from "../../adapters/registry.js";
import type {
  BotContainerDriver,
  BotContainerSpec,
  BotContainerStatus,
  BotExtraMount,
} from "./driver.js";
import type { CompiledProfile } from "./types.js";

// Placeholder data for isolated tests: fake keys, hashes, and specs.

const SPEC: BotContainerSpec = {
  botKey: "bot-reg-test",
  image: "example.com/bot@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  memoryMb: 1024,
  cpus: 1,
  pidsLimit: 256,
  network: "net-fleet",
};

const PROFILE: CompiledProfile = {
  botKey: "bot-reg-test",
  files: [
    { path: "hermes/config.yaml", content: "gateway: {}\n", mode: 0o644, secret: false },
    { path: "hermes/.env", content: 'API_KEY="test-val"\n', mode: 0o600, secret: true },
  ],
  restartHash: "rh-1",
  filesHash: "fh-1",
};

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body?: unknown;
}

function createFakeFleetdServer(
  handler: (req: CapturedRequest, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; baseUrl: string; calls: CapturedRequest[] }> {
  const calls: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const captured: CapturedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      };
      calls.push(captured);
      handler(captured, res);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Expected TCP address");
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        calls,
      });
    });
  });
}

describe("OPE-8137: board/fleetd path operates without /host or docker.sock", () => {
  it("fleetdBotContainerDriver executes all lifecycle operations via pure HTTP without local docker.sock or /host", async () => {
    const { server, baseUrl, calls } = await createFakeFleetdServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/v1/bots/bot-reg-test/status") {
        res.end(JSON.stringify({ botKey: "bot-reg-test", state: "running", restartHash: "rh-1", filesHash: "fh-1" }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/bots") {
        res.end(JSON.stringify([{ botKey: "bot-reg-test", state: "running" }]));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/bots/bot-reg-test/template-drift") {
        res.end(JSON.stringify({ drift: false, fields: [] }));
        return;
      }
      if (req.method === "POST" && (req.url === "/v1/bots" || req.url?.includes("/recreate") || req.url?.includes("/start") || req.url?.includes("/restart") || req.url?.includes("/stop"))) {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "PUT" && req.url === "/v1/bots/bot-reg-test/profile") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const config: FleetdDriverConfig = { baseUrl, token: "test-fleetd-auth-token-32-chars-long" };
      const driver = fleetdBotContainerDriver(config);

      // Status
      const status = await driver.status("bot-reg-test");
      expect(status).toEqual({ botKey: "bot-reg-test", state: "running", restartHash: "rh-1", filesHash: "fh-1" });

      // List
      const list = await driver.list(["bot-reg-test"]);
      expect(list).toEqual([{ botKey: "bot-reg-test", state: "running" }]);

      // Template drift
      const drift = await driver.templateDrift(SPEC);
      expect(drift).toEqual({ drifted: false, fields: [] });

      // Create & Recreate
      await driver.create(SPEC);
      await driver.recreate(SPEC);

      // Write Profile
      await driver.writeProfile("bot-reg-test", PROFILE);

      // Start, Restart, Stop
      await driver.start("bot-reg-test");
      await driver.restart("bot-reg-test");
      await driver.stop("bot-reg-test");

      // Verify each call went over HTTP with bearer authorization
      expect(calls.length).toBe(9);
      for (const call of calls) {
        expect(call.headers.authorization).toBe("Bearer test-fleetd-auth-token-32-chars-long");
      }
    } finally {
      server.close();
    }
  });

  it("fleetdBotContainerDriver explicitly skips mounting board-host shared package cache and logs notice", async () => {
    const { server, baseUrl } = await createFakeFleetdServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });

    const loggedWarns: string[] = [];
    const mockLog = {
      warn: (_fields: Record<string, unknown>, msg: string) => {
        loggedWarns.push(msg);
      },
    };

    try {
      const config: FleetdDriverConfig = { baseUrl, token: "test-fleetd-auth-token-32-chars-long" };
      const driver = fleetdBotContainerDriver(config, {
        readSharedPackageCachePath: async () => "/srv/cache/pnpm",
        log: mockLog,
      });

      await driver.create(SPEC);

      // Verify that board-host filesystem path is NOT forwarded, and advisory notice is logged
      expect(loggedWarns).toContain(FLEETD_PACKAGE_CACHE_NOTICE);
    } finally {
      server.close();
    }
  });

  it("fleetdBotContainerDriver masks error bodies and rejects non-http baseUrls without filesystem checks", async () => {
    const { server, baseUrl } = await createFakeFleetdServer((_req, res) => {
      res.statusCode = 403;
      res.end("bot_not_enrolled\n");
    });

    try {
      const config: FleetdDriverConfig = { baseUrl, token: "test-token-at-least-32-characters" };
      const driver = fleetdBotContainerDriver(config);

      await expect(driver.status("unknown-bot")).rejects.toThrow(FleetdDriverError);
      await expect(driver.status("unknown-bot")).rejects.toThrow("fleetd 403 bot_not_enrolled");
    } finally {
      server.close();
    }

    // Protocol validation: rejects unix sockets, https, file URLs
    expect(() => parseFleetdEndpoint("unix:///var/run/docker.sock")).toThrow(/must be http:\/\//);
    expect(() => parseFleetdEndpoint("file:///host/dev")).toThrow(/must be http:\/\//);
    expect(() => parseFleetdEndpoint("https://fleetd.example.com")).toThrow(/must be http:\/\//);
    expect(() => parseFleetdEndpoint("http://fleetd.example.com:99999")).toThrow(/port is invalid/);
  });
});

describe("OPE-8137: fleet routing completely isolates fleet-placed bots from local Docker and /host", () => {
  it("routes fleet-placed bots to fleetd without ever invoking local Docker or requiring docker.sock", async () => {
    // Local driver explicitly throws if touched (simulating absent /var/run/docker.sock)
    const localDriver: BotContainerDriver = {
      status: vi.fn(async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      }),
      list: vi.fn(async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      }),
      templateDrift: vi.fn(async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      }),
      create: vi.fn(async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      }),
      recreate: vi.fn(async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      }),
      writeProfile: vi.fn(async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      }),
      start: vi.fn(async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      }),
      restart: vi.fn(async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      }),
      stop: vi.fn(async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      }),
    };

    const fleetCalls: string[] = [];
    const fleetDriver: BotContainerDriver = {
      status: vi.fn(async (botKey) => {
        fleetCalls.push(`status:${botKey}`);
        return { botKey, state: "running" };
      }),
      list: vi.fn(async () => {
        fleetCalls.push("list");
        return [{ botKey: "bot-fleet", state: "running" }];
      }),
      templateDrift: vi.fn(async (spec) => {
        fleetCalls.push(`drift:${spec.botKey}`);
        return { drifted: false, fields: [] };
      }),
      create: vi.fn(async (spec) => {
        fleetCalls.push(`create:${spec.botKey}`);
      }),
      recreate: vi.fn(async (spec) => {
        fleetCalls.push(`recreate:${spec.botKey}`);
      }),
      writeProfile: vi.fn(async (botKey) => {
        fleetCalls.push(`writeProfile:${botKey}`);
      }),
      start: vi.fn(async (botKey) => {
        fleetCalls.push(`start:${botKey}`);
      }),
      restart: vi.fn(async (botKey) => {
        fleetCalls.push(`restart:${botKey}`);
      }),
      stop: vi.fn(async (botKey) => {
        fleetCalls.push(`stop:${botKey}`);
      }),
    };

    const deps: FleetRoutingDeps = {
      local: localDriver,
      fleet: new Map([["vmexec", fleetDriver]]),
    };

    // Agent is explicitly placed on the fleet host "vmexec"
    const routedAgent: RoutedBotAgent = {
      adapterConfig: { container: { host: "vmexec" } },
    };

    const routed = fleetRoutingDriver(deps, () => routedAgent);

    // Perform all driver calls for the fleet-placed bot
    await routed.status("bot-fleet");
    await routed.templateDrift({ ...SPEC, botKey: "bot-fleet" });
    await routed.create({ ...SPEC, botKey: "bot-fleet" });
    await routed.recreate({ ...SPEC, botKey: "bot-fleet" });
    await routed.writeProfile("bot-fleet", { ...PROFILE, botKey: "bot-fleet" });
    await routed.start("bot-fleet");
    await routed.restart("bot-fleet");
    await routed.stop("bot-fleet");

    // All calls reached the fleet driver
    expect(fleetCalls).toEqual([
      "status:bot-fleet",
      "drift:bot-fleet",
      "create:bot-fleet",
      "recreate:bot-fleet",
      "writeProfile:bot-fleet",
      "start:bot-fleet",
      "restart:bot-fleet",
      "stop:bot-fleet",
    ]);

    // Local driver was NEVER called; no docker.sock error occurred
    expect(localDriver.status).not.toHaveBeenCalled();
    expect(localDriver.create).not.toHaveBeenCalled();
    expect(localDriver.start).not.toHaveBeenCalled();
    expect(localDriver.stop).not.toHaveBeenCalled();
  });

  it("throws clear configuration error when an unknown fleet host is requested, without fallback or host probes", async () => {
    const localDriver: BotContainerDriver = {
      status: vi.fn(async () => ({ botKey: "b", state: "running" })),
      list: vi.fn(async () => []),
      templateDrift: vi.fn(async () => ({ drifted: false, fields: [] })),
      create: vi.fn(async () => {}),
      recreate: vi.fn(async () => {}),
      writeProfile: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };

    const deps: FleetRoutingDeps = {
      local: localDriver,
      fleet: new Map([["vmexec", localDriver]]),
    };

    const routedAgent: RoutedBotAgent = {
      adapterConfig: { container: { host: "non-existent-host" } },
    };

    const routed = fleetRoutingDriver(deps, () => routedAgent);

    await expect(routed.status("bot-a")).rejects.toThrow(
      'container.host "non-existent-host" names no configured fleet host (check MYRMIDON_FLEET_HOSTS)',
    );
    expect(localDriver.status).not.toHaveBeenCalled();
  });
});

describe("OPE-8137: fleet placement and host parsing boundaries", () => {
  it("fleetGatewayApiBaseUrl derives gateway URL purely in memory without socket or filesystem access", () => {
    expect(fleetGatewayApiBaseUrl("http://fleetd.internal:9100", 8080)).toBe("http://fleetd.internal:8080");
    expect(fleetGatewayApiBaseUrl("http://192.168.1.50:9100", 3001)).toBe("http://192.168.1.50:3001");

    expect(() => fleetGatewayApiBaseUrl("http://fleetd.internal:9100", undefined)).toThrow(
      /fleetd did not report a gateway port/,
    );
    expect(() => fleetGatewayApiBaseUrl("http://fleetd.internal:9100", 0)).toThrow(
      /fleetd reported an invalid gateway port/,
    );
    expect(() => fleetGatewayApiBaseUrl("http://fleetd.internal:9100", 70000)).toThrow(
      /fleetd reported an invalid gateway port/,
    );
    expect(() => fleetGatewayApiBaseUrl("https://fleetd.internal:9100", 8080)).toThrow(
      /fleetd url must be http:\/\//,
    );
  });

  it("parseFleetHosts safely parses entries and rejects non-http URLs", () => {
    for (const empty of [undefined, "", "   "]) {
      expect(parseFleetHosts(empty).size).toBe(0);
    }

    const parsed = parseFleetHosts(
      JSON.stringify([
        {
          name: "site-worker",
          url: "http://site-worker.internal:9100",
          tokenSecret: "site-token",
        },
      ]),
    );
    expect(parsed.get("site-worker")).toEqual({
      name: "site-worker",
      url: "http://site-worker.internal:9100",
      tokenSecret: "site-token",
    });

    expect(() =>
      parseFleetHosts(
        JSON.stringify([
          {
            name: "bad-protocol",
            url: "https://site-worker.internal:9100",
            tokenSecret: "site-token",
          },
        ]),
      ),
    ).toThrow(/url must be http/);
  });
});

describe("OPE-8137: disabled flags and fail-safe boundaries", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("MYRMIDON_BOT_CONTAINERS disabled is a safe no-op that never touches docker.sock or /host", async () => {
    for (const val of [undefined, "", "0", "false", "no"]) {
      const env = val === undefined ? {} : { [BOT_CONTAINERS_ENV]: val };
      expect(isBotContainersEnabled(env)).toBe(false);

      // startBotContainers must return a clean no-op without reading driver config or touching Docker
      const mockReadDriverConfig = vi.fn(() => {
        throw new Error("readDriverConfig must not be called when feature is disabled");
      });

      const stop = startBotContainers(null as any, {
        env,
        ports: { readDriverConfig: mockReadDriverConfig as any },
      });
      expect(typeof stop).toBe("function");
      stop();
      expect(mockReadDriverConfig).not.toHaveBeenCalled();

      // applyBotContainerNow returns not_applicable without invoking driver or compiler
      const dummyDriver: BotContainerDriver = {
        status: vi.fn(async () => {
          throw new Error("must not be called");
        }),
        list: vi.fn(async () => []),
        templateDrift: vi.fn(async () => ({ drifted: false, fields: [] })),
        create: vi.fn(async () => {}),
        recreate: vi.fn(async () => {}),
        writeProfile: vi.fn(async () => {}),
        start: vi.fn(async () => {}),
        restart: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      };

      const outcome = await applyBotContainerNow(
        { id: "agent-1", companyId: "comp-1", adapterConfig: {} } as any,
        {
          driver: dummyDriver,
          compile: vi.fn(async () => {
            throw new Error("compile must not be called");
          }) as any,
          maintenance: {
            enter: async () => ({ state: "on", runningRuns: 0, owned: true }),
            status: async () => ({ state: "on", runningRuns: 0 }),
            exit: async () => {},
          },
          network: "net",
          lock: { withLock: async (_key: string, fn: any) => fn() } as any,
        },
        { env },
      );
      expect(outcome).toEqual({
        kind: "not_applicable",
        reason: `${BOT_CONTAINERS_ENV} is not enabled`,
      });
      expect(dummyDriver.status).not.toHaveBeenCalled();
    }
  });

  it("MYRMIDON_FLEET_HOSTS disabled / unset returns empty configuration safely", () => {
    vi.stubEnv(FLEET_HOSTS_ENV, "");
    expect(parseFleetHosts(process.env[FLEET_HOSTS_ENV]).size).toBe(0);
    expect(cardFleetHost({})).toBeNull();
    expect(cardFleetHost({ container: {} })).toBeNull();
  });

  it("MYRMIDON_DISABLE_HERMES_LOCAL suppresses local hermes adapter when set to 1", () => {
    vi.stubEnv("MYRMIDON_DISABLE_HERMES_LOCAL", "");
    expect(listEnabledServerAdapters().some((a) => a.type === "hermes_local")).toBe(true);

    vi.stubEnv("MYRMIDON_DISABLE_HERMES_LOCAL", "1");
    expect(listEnabledServerAdapters().some((a) => a.type === "hermes_local")).toBe(false);
  });

  it("MYRMIDON_BOT_MOUNT_SOURCES unset / empty rejects /host, docker.sock, and root paths", () => {
    expect(parseMountSourceAllowlist(undefined)).toEqual([]);
    expect(parseMountSourceAllowlist("")).toEqual([]);
    expect(parseMountSourceAllowlist("   ")).toEqual([]);

    const dangerousMounts: BotExtraMount[] = [
      { source: "/host", containerPath: "/mnt/host", readOnly: true },
      { source: "/var/run/docker.sock", containerPath: "/var/run/docker.sock", readOnly: true },
      { source: "/", containerPath: "/mnt/root", readOnly: true },
      { source: "/host/../etc", containerPath: "/mnt/etc", readOnly: true },
    ];

    for (const mount of dangerousMounts) {
      expect(() => validateExtraMounts([mount], [])).toThrow(BotContainerTemplateError);
    }

    // Even if an operator allows a specific folder (/srv/allowed), /host and docker.sock remain forbidden
    const allowedSources = ["/srv/allowed"];
    expect(() =>
      validateExtraMounts([{ source: "/host", containerPath: "/mnt/host", readOnly: true }], allowedSources),
    ).toThrow(/is not listed in MYRMIDON_BOT_MOUNT_SOURCES/);

    expect(() =>
      validateExtraMounts([{ source: "/var/run/docker.sock", containerPath: "/mnt/sock", readOnly: true }], allowedSources),
    ).toThrow(/is not listed in MYRMIDON_BOT_MOUNT_SOURCES/);

    // Writable extra mount is forbidden
    expect(() =>
      validateExtraMounts([{ source: "/srv/allowed", containerPath: "/mnt/allowed", readOnly: false }], allowedSources),
    ).toThrow(/must be read-only/);

    // Reserved paths cannot be overridden
    expect(() =>
      validateExtraMounts([{ source: "/srv/allowed", containerPath: "/data", readOnly: true }], allowedSources),
    ).toThrow(/is reserved/);
    expect(() =>
      validateExtraMounts([{ source: "/srv/allowed", containerPath: "/tmp", readOnly: true }], allowedSources),
    ).toThrow(/is reserved/);
  });

  it("MYRMIDON_DEVBUILD_HOST unset or blank attaches no devbuild env or SSH key mount", () => {
    for (const host of [undefined, "", "   "]) {
      const env = host === undefined ? {} : { MYRMIDON_DEVBUILD_HOST: host };
      const settings = parseDevbuildSettings(env);
      expect(settings.host).toBeNull();
      expect(devbuildContainerEnv(settings, "bot-a")).toBeNull();
      expect(devbuildKeyMount(settings, ["/srv/mounts/devbuild-ssh"])).toBeNull();
    }
  });
});

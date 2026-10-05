// myrmidon(BOT-DISK-F): the bot container driver with isolation scopes: what a
// member of a shared scope instance gets mounted, that different instances never
// share a directory, and what a recreate does when the layout changes (pause,
// migration, recreate; nothing happens when the migration would conflict).
//
// The Docker side is a tiny scripted daemon on a unix socket (it only records
// requests and answers the few the flows read); the full volume emulation lives
// in docker-driver.myrmidon.test.ts.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scopeInstanceDirName, type ScopeLayout } from "@paperclipai/shared";
import {
  buildCreateContainerRequestBody,
  buildHelperContainerRequestBody,
  buildPrepareVolumesScript,
  dockerBotContainerDriver,
  type DockerDriverConfig,
} from "./docker-driver.js";
import type { BotContainerSpec } from "./driver.js";
import {
  botRealRootFromBinds,
  BOT_RUNTIME_CONTRACT_LABEL,
  BOT_RUNTIME_SCOPE_LABEL,
  BOT_SCOPE_DATA_TMPFS,
  BotContainerTemplateError,
  buildBinds,
  buildHelperBinds,
  scopeDirNameFromBinds,
} from "./template.js";

const COMPANY = "00000000-0000-4000-8000-0000000000c0";
const CONFIG: Pick<DockerDriverConfig, "volumeRoot" | "network" | "allowlist" | "mountSources" | "devbuild"> & { scopeRoot: string } = {
  volumeRoot: "/srv/bots",
  scopeRoot: "/srv/bots/.scopes",
  network: "myrmidon-bots",
  allowlist: ["myrmidon-hermes:*"],
  mountSources: [],
  devbuild: { host: null, user: "", base: "" },
};
const ENGINEER = scopeInstanceDirName("caste", COMPANY, "engineer");
const MARKETING = scopeInstanceDirName("caste", COMPANY, "marketing");

function spec(botKey = "agent-a"): BotContainerSpec {
  return { botKey, image: "myrmidon-hermes:2", memoryMb: 1024, cpus: 1, pidsLimit: 256, network: "myrmidon-bots" };
}

describe("mounts of a shared scope instance", () => {
  const mount = (dirName: string) => ({ scopeRoot: CONFIG.scopeRoot, dirName });

  it("a member binds ONE directory, the instance's, and no per-bot /bot bind", () => {
    const body = buildCreateContainerRequestBody(spec("agent-a"), CONFIG, undefined, false, mount(ENGINEER));
    expect(body.HostConfig.Binds).toEqual([`/srv/bots/.scopes/${ENGINEER}:/bot-scope`]);
    expect(body.Env).toEqual(["MYRMIDON_BOT_SCOPE_SUBDIR=agent-a"]);
    expect(body.HostConfig.Tmpfs).toEqual({ "/tmp": "", "/data": BOT_SCOPE_DATA_TMPFS });
    // key order is part of the contract with dockergate (it rebuilds the body byte for byte)
    expect(Object.keys(body)).toEqual(["Image", "Labels", "Env", "HostConfig"]);
  });

  it("an isolated bot's body is unchanged: its own directory, no Env, one tmpfs", () => {
    const body = buildCreateContainerRequestBody(spec("agent-a"), CONFIG);
    expect(body.HostConfig.Binds).toEqual(["/srv/bots/agent-a:/bot"]);
    expect(body.Env).toBeUndefined();
    expect(Object.keys(body)).toEqual(["Image", "Labels", "HostConfig"]);
    expect(body.HostConfig.Tmpfs).toEqual({ "/tmp": "" });
  });

  it("different instances never share a host directory, and members of one instance bind the same one", () => {
    const a = buildBinds(CONFIG.volumeRoot, "agent-a", { scope: mount(ENGINEER) })[0]!.split(":")[0]!;
    const a2 = buildBinds(CONFIG.volumeRoot, "agent-b", { scope: mount(ENGINEER) })[0]!.split(":")[0]!;
    const m = buildBinds(CONFIG.volumeRoot, "agent-c", { scope: mount(MARKETING) })[0]!.split(":")[0]!;
    const own = buildBinds(CONFIG.volumeRoot, "agent-d")[0]!.split(":")[0]!;
    expect(a).toBe(a2);
    const dirs = [a, m, own];
    for (const x of dirs) for (const y of dirs) if (x !== y) expect(`${x}/`.startsWith(`${y}/`)).toBe(false);
  });

  it("the helpers of a member work inside its own subdirectory only; the prepare helper also hands over the instance directory", () => {
    const narrow = buildHelperBinds(CONFIG.volumeRoot, "agent-a", mount(ENGINEER));
    expect(narrow).toEqual([
      `/srv/bots/.scopes/${ENGINEER}/agent-a/hermes:/data/hermes`,
      `/srv/bots/.scopes/${ENGINEER}/agent-a/workspace:/workspace`,
      `/srv/bots/.scopes/${ENGINEER}/agent-a/scratch:/scratch`,
    ]);
    const prepare = buildHelperContainerRequestBody({
      botKey: "agent-a", image: "i", role: "prepare-volumes", script: buildPrepareVolumesScript({ scope: true }), volumeRoot: CONFIG.volumeRoot, scope: mount(ENGINEER),
    });
    expect(prepare.HostConfig.Binds).toEqual([...narrow, `/srv/bots/.scopes/${ENGINEER}:/scope`]);
    const apply = buildHelperContainerRequestBody({
      botKey: "agent-a", image: "i", role: "apply-profile", script: "s", volumeRoot: CONFIG.volumeRoot, scope: mount(ENGINEER),
    });
    expect(apply.HostConfig.Binds).toEqual(narrow);
    expect(buildPrepareVolumesScript({ scope: true })).toContain("data/hermes workspace scratch scope");
    expect(buildPrepareVolumesScript()).not.toContain("scope");
  });

  it("refuses an instance name or root that is not a plain one, and a card mount onto the instance mount point", () => {
    expect(() => buildBinds(CONFIG.volumeRoot, "agent-a", { scope: mount("../etc") })).toThrow(BotContainerTemplateError);
    expect(() => buildBinds(CONFIG.volumeRoot, "agent-a", { scope: mount("caste-a/b") })).toThrow(BotContainerTemplateError);
    expect(() => buildBinds(CONFIG.volumeRoot, "agent-a", { scope: { scopeRoot: "relative", dirName: ENGINEER } })).toThrow(BotContainerTemplateError);
    expect(() =>
      buildBinds(CONFIG.volumeRoot, "agent-a", {
        scope: mount(ENGINEER),
        mounts: [{ source: "/srv/x", containerPath: "/bot-scope", readOnly: true }],
        allowedSources: ["/srv/x"],
      }),
    ).toThrow(/reserved/);
  });

  it("reads a container's layout and real root off its binds", () => {
    const shared = [`/srv/bots/.scopes/${ENGINEER}:/bot-scope`];
    expect(scopeDirNameFromBinds(shared, CONFIG.scopeRoot)).toBe(ENGINEER);
    expect(botRealRootFromBinds(shared, "agent-a")).toBe("/bot-scope/agent-a");
    expect(scopeDirNameFromBinds(["/srv/bots/agent-a:/bot"], CONFIG.scopeRoot)).toBeNull();
    expect(botRealRootFromBinds(["/srv/bots/agent-a:/bot"], "agent-a")).toBe("/bot");
    expect(botRealRootFromBinds(undefined, "agent-a")).toBe("/bot");
  });
});

// ---- a scripted daemon -------------------------------------------------------

interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
}

function startDaemon(state: { binds: string[]; imageLabels: Record<string, string>; failStart?: boolean; refuseCreate?: boolean }) {
  const requests: Req[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-drv-"));
  const socketPath = path.join(dir, "d.sock");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://d");
    const p = url.pathname.replace(/^\/v1\.\d+/, "");
    requests.push({ method: req.method ?? "", path: p, query: url.searchParams });
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    req.resume();
    req.on("end", () => {
      if (p.startsWith("/images/")) return json(200, { Config: { Labels: state.imageLabels } });
      if (p === "/containers/create") return state.refuseCreate ? json(403, { message: "dockergate: denied (mount_source_not_allowed)" }) : json(201, { Id: "new" });
      if (req.method === "GET" && p === "/containers/myrmidon-bot-agent-a/json") {
        return json(200, {
          Image: "sha256:aa",
          Config: { Image: "myrmidon-hermes:2", Labels: {} },
          State: { Status: "running", Health: { Status: "healthy" } },
          HostConfig: { Memory: 1024 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 256, NetworkMode: "myrmidon-bots", Binds: state.binds },
        });
      }
      if (p.endsWith(".helper/wait")) return json(200, { StatusCode: 0 });
      if (p.endsWith("/archive") && req.method === "GET") return json(404, { message: "no marker" });
      if (p.endsWith("/json")) return json(404, { message: "no such container" });
      if (p.endsWith("/start") && state.failStart) return json(500, { message: "no" });
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise<{ requests: Req[]; close: () => Promise<void>; socketPath: string }>((resolve) => {
    server.listen(socketPath, () =>
      resolve({
        requests,
        socketPath,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              fs.rmSync(dir, { recursive: true, force: true });
              done();
            });
          }),
      }),
    );
  });
}

describe("recreate onto another layout", () => {
  const SHARED: ScopeLayout = { kind: "shared", dirName: ENGINEER };
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  const state = {
    binds: ["/srv/bots/agent-a:/bot"],
    imageLabels: { [BOT_RUNTIME_CONTRACT_LABEL]: "1", [BOT_RUNTIME_SCOPE_LABEL]: "1" } as Record<string, string>,
    failStart: false,
    refuseCreate: false,
  };

  beforeEach(async () => {
    state.binds = ["/srv/bots/agent-a:/bot"];
    state.imageLabels = { [BOT_RUNTIME_CONTRACT_LABEL]: "1", [BOT_RUNTIME_SCOPE_LABEL]: "1" };
    state.failStart = false;
    state.refuseCreate = false;
    daemon = await startDaemon(state);
  });
  afterEach(() => daemon.close());

  const driverFor = (layout: ScopeLayout, migration?: { check: () => Promise<void>; run: () => Promise<void> }) =>
    dockerBotContainerDriver(
      { ...CONFIG, socketPath: daemon.socketPath },
      { readScopeLayout: async () => layout, scopeMigration: migration, sleep: async () => undefined },
    );
  const trail = () => daemon.requests.map((r) => `${r.method} ${r.path}`);

  it("checks first, builds everything the gate may refuse while the bot runs, then pauses, migrates and swaps", async () => {
    const calls: string[] = [];
    const driver = driverFor(SHARED, {
      check: async () => void calls.push(`check@${trail().length}`),
      run: async () => void calls.push(`run@${trail().length}`),
    });
    await driver.recreate(spec());
    const t = trail();
    const stop = t.indexOf("POST /containers/myrmidon-bot-agent-a/stop");
    const createNext = t.findIndex((line, i) => line === "POST /containers/create" && daemon.requests[i]!.query.get("name") === "myrmidon-bot-agent-a.next");
    const prepare = t.findIndex((line, i) => line === "POST /containers/create" && daemon.requests[i]!.query.get("name") === "myrmidon-bot-agent-a.helper");
    expect(calls).toHaveLength(2);
    // check before anything is created or stopped
    expect(Number(calls[0]!.split("@")[1])).toBeLessThanOrEqual(prepare);
    // the volumes of the new layout and the replacement exist before the old container is paused
    expect(prepare).toBeGreaterThan(0);
    expect(createNext).toBeGreaterThan(prepare);
    expect(stop).toBeGreaterThan(createNext);
    // the move runs right after the stop and before the old container is removed
    expect(Number(calls[1]!.split("@")[1])).toBe(stop + 1);
    expect(t.indexOf("DELETE /containers/myrmidon-bot-agent-a")).toBeGreaterThan(stop);
    expect(t).toContain("POST /containers/myrmidon-bot-agent-a.next/rename");
    // the replacement carries the instance bind, the old one is not recreated with /bot
    const created = daemon.requests[createNext]!;
    expect(created.query.get("name")).toBe("myrmidon-bot-agent-a.next");
  });

  it("a refusal while the replacement is built (gate or daemon) leaves the old container running and nothing moved", async () => {
    state.refuseCreate = true;
    let ran = false;
    const driver = driverFor(SHARED, { check: async () => undefined, run: async () => void (ran = true) });
    await expect(driver.recreate(spec())).rejects.toThrow();
    expect(ran).toBe(false);
    expect(trail().some((line) => line.includes("/stop") || line === "DELETE /containers/myrmidon-bot-agent-a")).toBe(false);
  });

  it("does not stop anything when the migration check refuses", async () => {
    const driver = driverFor(SHARED, {
      check: async () => {
        throw new Error("conflict: target already holds data");
      },
      run: async () => undefined,
    });
    await expect(driver.recreate(spec())).rejects.toThrow(/conflict/);
    expect(trail().some((line) => line.includes("/stop") || line.startsWith("DELETE"))).toBe(false);
    expect(daemon.requests.some((r) => r.path === "/containers/create")).toBe(false);
  });

  it("starts the old container again when the move itself fails", async () => {
    const driver = driverFor(SHARED, {
      check: async () => undefined,
      run: async () => {
        throw new Error("EXDEV");
      },
    });
    await expect(driver.recreate(spec())).rejects.toThrow("EXDEV");
    const t = trail();
    expect(t.indexOf("POST /containers/myrmidon-bot-agent-a/start")).toBeGreaterThan(t.indexOf("POST /containers/myrmidon-bot-agent-a/stop"));
    // the replacement was built beforehand, but the old container is neither removed nor swapped out
    expect(t).not.toContain("DELETE /containers/myrmidon-bot-agent-a");
    expect(t).not.toContain("POST /containers/myrmidon-bot-agent-a.next/rename");
  });

  it("refuses a layout change when no migration is configured, before touching the container", async () => {
    await expect(driverFor(SHARED).recreate(spec())).rejects.toThrow(/no disk migration is configured/);
    expect(trail().some((line) => line.includes("/stop"))).toBe(false);
  });

  it("refuses an image that cannot run as a member of a shared instance", async () => {
    delete state.imageLabels[BOT_RUNTIME_SCOPE_LABEL];
    const driver = driverFor(SHARED, { check: async () => undefined, run: async () => undefined });
    await expect(driver.recreate(spec())).rejects.toThrow(/cannot run as a member/);
    expect(trail().some((line) => line.includes("/stop"))).toBe(false);
  });

  it("an unchanged layout recreates exactly as before: no migration, no early stop", async () => {
    let called = false;
    const driver = driverFor(
      { kind: "isolated" },
      { check: async () => void (called = true), run: async () => void (called = true) },
    );
    await driver.recreate(spec());
    expect(called).toBe(false);
    const t = trail();
    const createNext = t.indexOf("POST /containers/create", t.indexOf("POST /containers/create") + 1);
    expect(t.indexOf("POST /containers/myrmidon-bot-agent-a/stop")).toBeGreaterThan(createNext - 1);
  });

  it("reads a member's marker at its own subdirectory of the instance mount", async () => {
    state.binds = [`/srv/bots/.scopes/${ENGINEER}:/bot-scope`];
    await driverFor(SHARED).status("agent-a");
    const marker = daemon.requests.find((r) => r.path.endsWith("/archive"));
    expect(marker?.query.get("path")).toBe("/bot-scope/agent-a/hermes/.myrmidon/applied.json");
  });

  it("sees a drift when only the layout changed (a bind difference) and none when it matches", async () => {
    expect((await driverFor(SHARED).templateDrift(spec())).fields.map((f) => f.field)).toContain("HostConfig.Binds");
    state.binds = [`/srv/bots/.scopes/${ENGINEER}:/bot-scope`];
    expect((await driverFor(SHARED).templateDrift(spec())).drifted).toBe(false);
  });
});

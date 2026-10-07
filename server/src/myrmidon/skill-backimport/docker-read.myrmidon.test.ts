// server/src/myrmidon/skill-backimport/docker-read.myrmidon.test.ts
//
// myrmidon(1.6.5-SKILL-BACKIMPORT): the docker read port against a fake
// driver — no docker, no container. The points: the running set comes from
// the driver's per-bot reads (never a global listing), the skills path is
// derived from the status's own inspect (one inspect per bot per pass), the
// archive is parsed with the shared ustar reader, and a bot without a skills
// directory reads as "nothing", not as a failure.

import { describe, expect, it } from "vitest";
import type { BotContainerStatus } from "../bot-containers/driver.js";
import { buildUstarArchive } from "../bot-containers/ustar.js";
import { dockerSkillReadPort, listRunningBotKeys, type SkillBackImportDriver } from "./docker-read.js";

const BOT = "10000000-0000-4000-8000-0000000000b1";

function fakeDriver(overrides: Partial<SkillBackImportDriver> = {}): SkillBackImportDriver {
  const status: BotContainerStatus = {
    botKey: BOT,
    state: "running",
    inspect: { HostConfig: { Binds: [] } },
  };
  return {
    status: async () => status,
    list: async (botKeys: readonly string[]) => botKeys.map((botKey) => ({ ...status, botKey })),
    templateDrift: async () => ({ drifted: false, fields: [] }),
    create: async () => {},
    recreate: async () => {},
    writeProfile: async () => {},
    start: async () => {},
    restart: async () => {},
    stop: async () => {},
    readContainerPath: async function* () {},
    ...overrides,
  } as unknown as SkillBackImportDriver;
}

describe("listRunningBotKeys", () => {
  it("asks the driver's listRunning and returns the running bot keys", async () => {
    const driver = fakeDriver({
      listRunning: async (botKeys: readonly string[]) =>
        botKeys.map((botKey) => ({ botKey, state: "running" }) as BotContainerStatus),
    });
    const running = await listRunningBotKeys(driver, [BOT]);
    expect([...running]).toEqual([BOT]);
  });

  it("falls back to list + a state filter for a driver without listRunning", async () => {
    const driver = fakeDriver();
    const running = await listRunningBotKeys(driver, [BOT]);
    expect([...running]).toEqual([BOT]);
  });
});

describe("dockerSkillReadPort", () => {
  it("reads the skills root of a running bot and parses the archive", async () => {
    const archive = buildUstarArchive([
      {
        path: "vendor-triage/SKILL.md",
        content: Buffer.from("---\nname: Vendor Triage\n---\nbody\n", "utf8"),
        mode: 0o644,
        uid: 0,
        gid: 0,
      },
    ]);
    const paths: string[] = [];
    const driver = fakeDriver({
      readContainerPath: async function* (botKey: string, containerPath: string) {
        paths.push(containerPath);
        yield { kind: "file" as const, content: archive };
      },
    });
    const port = dockerSkillReadPort(driver);
    const files = await port.readBotSkillFiles(BOT);
    expect(paths).toEqual(["/bot/hermes/skills"]);
    expect(files).toEqual([
      { path: "vendor-triage/SKILL.md", content: "---\nname: Vendor Triage\n---\nbody\n" },
    ]);
  });

  it("derives the skills path from the status's inspect (binds), once per bot", async () => {
    let statusCalls = 0;
    const driver = fakeDriver({
      status: async () => {
        statusCalls += 1;
        return {
          botKey: BOT,
          state: "running",
          inspect: { HostConfig: { Binds: ["/srv/bot-scope:/bot-scope"] } },
        } as BotContainerStatus;
      },
      readContainerPath: async function* () {},
    });
    const port = dockerSkillReadPort(driver);
    await port.readBotSkillFiles(BOT);
    await port.readBotSkillFiles(BOT);
    expect(statusCalls).toBe(1);
  });

  it("answers null for a bot that is not running", async () => {
    const driver = fakeDriver({
      status: async () => ({ botKey: BOT, state: "missing" }) as BotContainerStatus,
    });
    const port = dockerSkillReadPort(driver);
    expect(await port.readBotSkillFiles(BOT)).toBeNull();
  });

  it("answers null when the skills directory cannot be read (bot without skills)", async () => {
    const driver = fakeDriver({
      readContainerPath: async function* () {
        throw new Error("no such file or directory");
      },
    });
    const port = dockerSkillReadPort(driver);
    expect(await port.readBotSkillFiles(BOT)).toBeNull();
  });
});

// myrmidon(1.6.4-BOT-CONTAINER-CARD): clone-hygiene reports are collected per known
// bot (from the agent cards) with calls dockergate allows, never by listing
// containers. Placeholder data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectCloneReports, readContainerBotKeys } from "./bot-disk-service.js";
import { cloneHygieneSignals, resetCloneHygieneStateForTests } from "./clone-hygiene.js";
import { setBotContainerRuntime } from "./routes-wiring.js";
import type { BotContainerDriver, BotContainerStatus } from "./driver.js";
import type { BotContainerRuntimeDeps } from "./index.js";

const KEY_A = "0a1b2c3d-1111-2222-3333-444455556666";
const KEY_B = "9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff";
const KEY_C = "11111111-2222-3333-4444-555555555555";

const REPORT = JSON.stringify({
  version: 1,
  inspectedAt: new Date(Date.now() - 60_000).toISOString(),
  repos: [
    {
      path: "/workspace/proj",
      dirty: false,
      inProgress: false,
      stashCount: 0,
      unpushedCommits: 2,
      hasRemote: true,
      linkedWorktrees: 0,
      referencedBy: 0,
      branch: "feature",
      mergedIntoDefault: false,
      idleSeconds: 7200,
      error: null,
    },
  ],
});

function driverOf(states: Record<string, BotContainerStatus["state"]>, reports: Record<string, string | null | Error>) {
  const list = vi.fn(async (keys: readonly string[]) =>
    keys.filter((k) => states[k] && states[k] !== "missing").map((botKey) => ({ botKey, state: states[botKey]! })),
  );
  const readCloneReport = vi.fn(async (botKey: string) => {
    const r = reports[botKey];
    if (r instanceof Error) throw r;
    return r ?? null;
  });
  const driver = { list, readCloneReport } as unknown as BotContainerDriver;
  return { driver, list, readCloneReport };
}

beforeEach(() => resetCloneHygieneStateForTests());
afterEach(() => {
  setBotContainerRuntime(null);
  resetCloneHygieneStateForTests();
});

describe("collectCloneReports", () => {
  it("asks for exactly the bots the cards name and reads reports of running ones only", async () => {
    const { driver, list, readCloneReport } = driverOf(
      { [KEY_A]: "running", [KEY_B]: "stopped" },
      { [KEY_A]: REPORT, [KEY_B]: REPORT },
    );
    setBotContainerRuntime({ driver } as unknown as BotContainerRuntimeDeps);
    await collectCloneReports(3_600_000, async () => [KEY_A, KEY_B, KEY_C]);
    expect(list).toHaveBeenCalledWith([KEY_A, KEY_B, KEY_C]);
    expect(readCloneReport.mock.calls.map((c) => c[0])).toEqual([KEY_A]);
    expect(cloneHygieneSignals().map((s) => [s.botKey, s.path])).toEqual([[KEY_A, "/workspace/proj"]]);
  });

  it("one bot's failing read does not stop the others, and a bot without a report is skipped", async () => {
    const { driver } = driverOf(
      { [KEY_A]: "running", [KEY_B]: "running", [KEY_C]: "running" },
      { [KEY_A]: new Error("boom"), [KEY_B]: REPORT, [KEY_C]: null },
    );
    setBotContainerRuntime({ driver } as unknown as BotContainerRuntimeDeps);
    await collectCloneReports(3_600_000, async () => [KEY_A, KEY_B, KEY_C]);
    expect(cloneHygieneSignals().map((s) => s.botKey)).toEqual([KEY_B]);
  });

  it("does nothing without a runtime", async () => {
    const readKeys = vi.fn(async () => [KEY_A]);
    await collectCloneReports(1, readKeys);
    expect(readKeys).not.toHaveBeenCalled();
  });
});

describe("readContainerBotKeys", () => {
  it("returns the bots whose cards are enabled, complete container configs", async () => {
    const rows = [
      { id: KEY_A, adapterType: "hermes_gateway", adapterConfig: { container: { enabled: true, image: "i", memoryMb: 1, cpus: 1, pidsLimit: 1 } } },
      { id: KEY_B, adapterType: "hermes_gateway", adapterConfig: { container: { image: "i" } } }, // legacy: not applicable
      { id: KEY_C, adapterType: "hermes_gateway", adapterConfig: {} },
    ];
    const db = { select: () => ({ from: () => ({ where: async () => rows }) }) };
    expect(await readContainerBotKeys(db as never)).toEqual([KEY_A]);
  });
});

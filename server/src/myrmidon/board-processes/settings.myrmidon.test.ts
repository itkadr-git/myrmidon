import { describe, expect, it, vi } from "vitest";
import { BoardProcessesRefusedError } from "@paperclipai/shared";
import {
  assertBoardProcessesStartableFromSettings,
  preserveBoardProcessesGeneralKey,
  readResolvedBoardProcesses,
  type BoardProcessesSettingsService,
} from "./settings.js";

const serviceWith = (general: { processes?: unknown }): BoardProcessesSettingsService => ({
  getGeneral: vi.fn(async () => general),
});

describe("board processes startup settings", () => {
  it("resolves today's single process when the key is not stored", async () => {
    const resolution = await readResolvedBoardProcesses(serviceWith({}));
    expect(resolution.settings).toEqual({ api: 1, worker: 0 });
    expect(resolution.sources).toEqual({ api: "default", worker: "default" });
    expect(resolution.problems).toEqual([]);
  });

  it("resolves today's single process when the settings row has no counts", async () => {
    // The row is shared with the rest of the feature (mode, apiCount, ...).
    const resolution = await readResolvedBoardProcesses(
      serviceWith({ processes: { mode: "single", apiCount: 1 } }),
    );
    expect(resolution.settings).toEqual({ api: 1, worker: 0 });
    expect(resolution.problems).toEqual([]);
  });

  it("returns the stored counts when there are some", async () => {
    const resolution = await assertBoardProcessesStartableFromSettings(
      serviceWith({ processes: { api: 2, worker: 1 } }),
    );
    expect(resolution.settings).toEqual({ api: 2, worker: 1 });
    expect(resolution.sources).toEqual({ api: "settings", worker: "settings" });
  });

  it("refuses a stored composition with no process at all", async () => {
    const service = serviceWith({ processes: { api: 0, worker: 0 } });
    await expect(assertBoardProcessesStartableFromSettings(service)).rejects.toThrow(
      BoardProcessesRefusedError,
    );
    await expect(assertBoardProcessesStartableFromSettings(service)).rejects.toThrow(
      /general\.processes .*api \+ worker must be >= 1/,
    );
  });

  it("refuses a stored count that is not a whole number >= 0", async () => {
    await expect(
      assertBoardProcessesStartableFromSettings(serviceWith({ processes: { api: -1 } })),
    ).rejects.toThrow(/api must be a whole number >= 0/);
  });

  it("keeps the stored row across vendor writes of general", () => {
    expect(preserveBoardProcessesGeneralKey({ processes: { api: 2, worker: 1 } })).toEqual({
      processes: { api: 2, worker: 1 },
    });
    expect(preserveBoardProcessesGeneralKey({})).toEqual({});
    expect(preserveBoardProcessesGeneralKey({ processes: undefined })).toEqual({});
    expect(preserveBoardProcessesGeneralKey(null)).toEqual({});
    expect(preserveBoardProcessesGeneralKey({ enablePipelines: true })).toEqual({});
  });
});
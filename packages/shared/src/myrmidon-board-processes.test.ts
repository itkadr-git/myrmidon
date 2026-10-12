import { describe, expect, it } from "vitest";
import {
  BOARD_PROCESSES_SETTINGS_KEY,
  BoardProcessesRefusedError,
  DEFAULT_BOARD_PROCESSES,
  assertBoardProcessesStartable,
  boardProcessesRefusalMessage,
  formatBoardProcessesComposition,
  readStoredBoardProcessesCounts,
  resolveBoardProcesses,
  storedBoardProcessesSettingsSchema,
} from "./myrmidon-board-processes.js";

describe("board processes settings", () => {
  it("keeps the settings key of the design (design OPE-5394 §7.2)", () => {
    expect(BOARD_PROCESSES_SETTINGS_KEY).toBe("processes");
    expect(DEFAULT_BOARD_PROCESSES).toEqual({ api: 1, worker: 0 });
  });

  it("runs today's single process when nothing is stored (the regression case)", () => {
    const resolution = resolveBoardProcesses(undefined);
    expect(resolution.settings).toEqual({ api: 1, worker: 0 });
    expect(resolution.sources).toEqual({ api: "default", worker: "default" });
    expect(resolution.problems).toEqual([]);
    expect(assertBoardProcessesStartable(resolution)).toEqual({ api: 1, worker: 0 });
  });

  it("treats a null row as the default", () => {
    const resolution = resolveBoardProcesses(null);
    expect(resolution.settings).toEqual({ api: 1, worker: 0 });
    expect(resolution.problems).toEqual([]);
  });

  it("reads the stored counts and defaults only what is missing", () => {
    expect(resolveBoardProcesses({ api: 3, worker: 2 })).toEqual({
      settings: { api: 3, worker: 2 },
      sources: { api: "settings", worker: "settings" },
      problems: [],
    });
    expect(resolveBoardProcesses({ api: 2 })).toEqual({
      settings: { api: 2, worker: 0 },
      sources: { api: "settings", worker: "default" },
      problems: [],
    });
    expect(resolveBoardProcesses({ worker: 1 })).toEqual({
      settings: { api: 1, worker: 1 },
      sources: { api: "default", worker: "settings" },
      problems: [],
    });
  });

  it("accepts an explicit zero where another process still exists", () => {
    expect(resolveBoardProcesses({ api: 0, worker: 1 }).problems).toEqual([]);
    expect(resolveBoardProcesses({ api: 1, worker: 0 }).problems).toEqual([]);
    expect(resolveBoardProcesses({ api: 4, worker: 2 }).problems).toEqual([]);
    expect(resolveBoardProcesses({ api: 0, worker: 1 }).settings).toEqual({ api: 0, worker: 1 });
  });

  it("shares the key with the rest of the feature: a sibling row is left alone", () => {
    const siblingRow = {
      mode: "single",
      apiCount: 1,
      leaderLeaseTtlSec: 30,
      liveEventsBus: "database",
      admissionStore: "database",
      singletonProxy: true,
    };
    // The counts are absent, so the row resolves to the default and nothing of
    // the sibling row is reported as a problem — the other part of the feature
    // owns those fields.
    expect(resolveBoardProcesses(siblingRow)).toEqual({
      settings: { api: 1, worker: 0 },
      sources: { api: "default", worker: "default" },
      problems: [],
    });
    // And a row that carries both is readable as well.
    expect(resolveBoardProcesses({ ...siblingRow, api: 2, worker: 1 }).settings).toEqual({
      api: 2,
      worker: 1,
    });
  });

  it("refuses a row that asks for no process at all", () => {
    const resolution = resolveBoardProcesses({ api: 0, worker: 0 });
    expect(resolution.settings).toEqual({ api: 0, worker: 0 });
    expect(resolution.problems).toHaveLength(1);
    expect(resolution.problems[0]).toContain("api + worker must be >= 1");
    expect(() => assertBoardProcessesStartable(resolution)).toThrow(BoardProcessesRefusedError);
    // `{ api: 0 }` leaves the worker on its default of 0, so it is the same refusal.
    expect(resolveBoardProcesses({ api: 0 }).problems[0]).toContain("api + worker must be >= 1");
  });

  it("refuses counts that are not whole numbers >= 0 instead of defaulting them", () => {
    for (const badRow of [{ api: -1 }, { worker: -1, api: 1 }, { api: 1.5 }, { worker: "2" }]) {
      const resolution = resolveBoardProcesses(badRow);
      expect(resolution.problems.length).toBeGreaterThan(0);
      expect(() => assertBoardProcessesStartable(resolution)).toThrow(/whole number >= 0/);
    }
    expect(resolveBoardProcesses({ api: 1, worker: "2" }).problems[0]).toContain("worker must be");
  });

  it("refuses a row that is not an object", () => {
    expect(resolveBoardProcesses("split").problems).toEqual(["processes must be an object"]);
    expect(resolveBoardProcesses([1, 0]).problems).toEqual(["processes must be an object"]);
  });

  it("names the key, the problem and the fix in the refusal", () => {
    const message = boardProcessesRefusalMessage(["api + worker must be >= 1 (got api=0, worker=0)"]);
    expect(message).toContain("general.processes");
    expect(message).toContain("api + worker must be >= 1 (got api=0, worker=0)");
    expect(message).toContain("api and worker are whole numbers >= 0");
    expect(message).toContain("refuses to start");
  });

  it("keeps the refusal message free of values it cannot explain", () => {
    const error = new BoardProcessesRefusedError(["api must be a whole number >= 0 (got \"2\")"]);
    expect(error.name).toBe("BoardProcessesRefusedError");
    expect(error.problems).toEqual(['api must be a whole number >= 0 (got "2")']);
    expect(error.message).toContain('api must be a whole number >= 0 (got "2")');
  });

  it("reads the counts it owns out of a stored row and reports none of the others", () => {
    expect(readStoredBoardProcessesCounts({ api: 2, worker: 1, mode: "split" })).toEqual({
      counts: { api: 2, worker: 1 },
      problems: [],
    });
    expect(readStoredBoardProcessesCounts({})).toEqual({ counts: {}, problems: [] });
  });

  it("formats the composition as one log line", () => {
    expect(formatBoardProcessesComposition({ api: 2, worker: 1 })).toBe("api=2 worker=1");
  });

  it("keeps the stored schema accepting what the validator of the row allows", () => {
    expect(storedBoardProcessesSettingsSchema.safeParse({ api: 1, worker: 0 }).success).toBe(true);
    expect(storedBoardProcessesSettingsSchema.safeParse({}).success).toBe(true);
    expect(storedBoardProcessesSettingsSchema.safeParse({ api: 1, mode: "split" }).success).toBe(true);
    expect(storedBoardProcessesSettingsSchema.safeParse({ api: -1 }).success).toBe(false);
    expect(storedBoardProcessesSettingsSchema.safeParse({ api: 1.5 }).success).toBe(false);
  });
});
import {
  assertBoardProcessesStartable,
  BOARD_PROCESSES_SETTINGS_KEY,
  resolveBoardProcesses,
  type BoardProcessesResolution,
} from "@paperclipai/shared";

/**
 * myrmidon(1.6.6 PROCS-J): reading the board's process composition out of
 * `instance_settings.general.processes`.
 *
 * The contract — the counts `api`/`worker`, the default `{ api: 1, worker: 0 }`
 * and what makes a row unusable — lives in
 * `packages/shared/src/myrmidon-board-processes.ts`; this module only reaches the
 * row through the vendor settings service, so the key is read where every other
 * part of the board reads its settings and shares the row with the rest of the
 * multi-process feature (design OPE-5394 §7.2).
 */

/**
 * The one method this module needs: `instanceSettingsService(db)` satisfies it
 * structurally, and a test can hand in a two-line fake.
 */
export type BoardProcessesSettingsService = {
  getGeneral: () => Promise<{ processes?: unknown }>;
};

/** Reads the stored row and resolves it to the composition to run. */
export async function readResolvedBoardProcesses(
  settings: BoardProcessesSettingsService,
): Promise<BoardProcessesResolution> {
  const general = await settings.getGeneral();
  return resolveBoardProcesses(general?.processes);
}

/**
 * The startup gate: the resolution to log, or the refusal that stops the board.
 * One call for the caller, so the "where does the row live" question stays here.
 */
export async function assertBoardProcessesStartableFromSettings(
  settings: BoardProcessesSettingsService,
): Promise<BoardProcessesResolution> {
  const resolution = await readResolvedBoardProcesses(settings);
  assertBoardProcessesStartable(resolution);
  return resolution;
}

/**
 * Keep the stored counts across vendor writes of `instance_settings.general` —
 * the same contract every other myrmidon general key follows.
 */
export function preserveBoardProcessesGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[BOARD_PROCESSES_SETTINGS_KEY];
  return value === undefined ? {} : { [BOARD_PROCESSES_SETTINGS_KEY]: value };
}
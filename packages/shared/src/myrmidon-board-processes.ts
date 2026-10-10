import { z } from "zod";

/**
 * myrmidon(1.6.6 PROCS-J): the board's process composition as an instance
 * settings key.
 *
 * The key is `instance_settings.general.processes` — the one settings row the
 * multi-process feature uses for "how many board processes exist and what each
 * of them does" (design OPE-5394 §7.2). This module owns the *counts* of that
 * row: how many HTTP processes (`api`) and how many scheduler processes
 * (`worker`) the deployment asks for. The mode and the per-role gates of
 * PROCS-1.1 live in the same row; the stored shape below therefore accepts a row
 * that carries them (and any field a later part adds) and reads the counts on
 * their own, so neither part of the feature can refuse the other's row while
 * both are in flight.
 *
 * The default is today's behaviour, byte for byte: one process that does
 * everything — `{ api: 1, worker: 0 }` — and nothing has to be stored for it.
 * An absent key, or an absent count inside a present row, resolves to the
 * default (`resolveBoardProcesses`).
 *
 * A composition that cannot be read is refused instead of guessed: counts that
 * are not whole numbers >= 0, or a row that asks for no process at all
 * (`api + worker < 1`), stop the board at startup with the fix in the message
 * (`assertBoardProcessesStartable`) — a mangled composition is a configuration
 * mistake, not a topology.
 */

/** The key inside `instance_settings.general`. */
export const BOARD_PROCESSES_SETTINGS_KEY = "processes";

/** The counts of the composition: HTTP processes and scheduler processes. */
export type BoardProcessesCounts = { api: number; worker: number };

/** The composition the board runs today: one process that does everything. */
export const DEFAULT_BOARD_PROCESSES: BoardProcessesCounts = { api: 1, worker: 0 };

/** The smallest composition the board can run: at least one process. */
export const BOARD_PROCESSES_MIN_TOTAL = 1;

const boardProcessesCountSchema = z.number().int().min(0);

/**
 * The stored shape of the key. Both counts are optional — a row may carry only
 * one of them, and a row written by another part of the feature carries none of
 * them — and every other field of the same row is accepted and left untouched.
 */
export const storedBoardProcessesSettingsSchema = z
  .object({
    api: boardProcessesCountSchema.optional(),
    worker: boardProcessesCountSchema.optional(),
  })
  .passthrough();

export type StoredBoardProcessesSettings = z.infer<typeof storedBoardProcessesSettingsSchema>;

/** Where a resolved count comes from. */
export type BoardProcessesSource = "settings" | "default";

/** Per field, where the resolved value came from. */
export type BoardProcessesSources = { api: BoardProcessesSource; worker: BoardProcessesSource };

export type BoardProcessesResolution = {
  /** The composition the board should run: stored counts, defaults for the rest. */
  settings: BoardProcessesCounts;
  /** Where each count came from (`settings` — stored, `default` — today's run). */
  sources: BoardProcessesSources;
  /** Everything that makes the row unusable; empty means the row is fine. */
  problems: string[];
};

/**
 * Reads the counts out of a stored `general.processes` row. Every field the
 * module does not own is ignored; a field it does own but cannot read becomes a
 * problem instead of a silent default (a stored `-1` must not start the board
 * as one process without saying so).
 */
export function readStoredBoardProcessesCounts(stored: unknown): {
  counts: Partial<BoardProcessesCounts>;
  problems: string[];
} {
  const problems: string[] = [];
  if (stored === undefined || stored === null) return { counts: {}, problems };
  if (typeof stored !== "object" || Array.isArray(stored)) {
    return {
      counts: {},
      problems: [`${BOARD_PROCESSES_SETTINGS_KEY} must be an object`],
    };
  }
  const record = stored as Record<string, unknown>;
  const counts: Partial<BoardProcessesCounts> = {};
  for (const field of ["api", "worker"] as const) {
    const raw = record[field];
    if (raw === undefined || raw === null) continue;
    const parsed = boardProcessesCountSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(
        `${field} must be a whole number >= 0 (got ${JSON.stringify(raw)})`,
      );
      continue;
    }
    counts[field] = parsed.data;
  }
  return { counts, problems };
}

/**
 * Resolves the composition to run: the stored counts where they are readable,
 * the default for every count that is not stored, and the list of problems that
 * makes the row unusable.
 */
export function resolveBoardProcesses(stored: unknown): BoardProcessesResolution {
  const { counts, problems } = readStoredBoardProcessesCounts(stored);
  const settings: BoardProcessesCounts = {
    api: counts.api ?? DEFAULT_BOARD_PROCESSES.api,
    worker: counts.worker ?? DEFAULT_BOARD_PROCESSES.worker,
  };
  const sources: BoardProcessesSources = {
    api: counts.api === undefined ? "default" : "settings",
    worker: counts.worker === undefined ? "default" : "settings",
  };
  const total = settings.api + settings.worker;
  if (problems.length === 0 && total < BOARD_PROCESSES_MIN_TOTAL) {
    problems.push(
      `api + worker must be >= ${BOARD_PROCESSES_MIN_TOTAL} (got api=${settings.api}, worker=${settings.worker})`,
    );
  }
  return { settings, sources, problems };
}

/**
 * The error a startup refusal carries: the message is what lands in the log and
 * names the key, the problem and the fix, so an operator does not have to
 * reverse-engineer the composition.
 */
export class BoardProcessesRefusedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(boardProcessesRefusalMessage(problems));
    this.name = "BoardProcessesRefusedError";
    this.problems = [...problems];
  }
}

export function boardProcessesRefusalMessage(problems: readonly string[]): string {
  return [
    `instance settings key general.${BOARD_PROCESSES_SETTINGS_KEY} (board processes) is not usable: ${problems.join("; ")}.`,
    `Fix the stored row, or remove it: api and worker are whole numbers >= 0 and at least one process must exist (the default is { api: ${DEFAULT_BOARD_PROCESSES.api}, worker: ${DEFAULT_BOARD_PROCESSES.worker} } — today's single process).`,
    "The board refuses to start instead of guessing a process composition.",
  ].join(" ");
}

/**
 * The startup gate: returns the composition to run, or throws the refusal that
 * stops the board. Called once, before anything is created, so a deployment
 * never runs a topology nobody asked for.
 */
export function assertBoardProcessesStartable(
  resolution: BoardProcessesResolution,
): BoardProcessesCounts {
  if (resolution.problems.length > 0) {
    throw new BoardProcessesRefusedError(resolution.problems);
  }
  return resolution.settings;
}

/** The composition as one log line: `api=1 worker=0`. */
export function formatBoardProcessesComposition(settings: BoardProcessesCounts): string {
  return `api=${settings.api} worker=${settings.worker}`;
}
// myrmidon(BOARD-JANITOR): configuration and environment settings
//
// Governs the daily board janitor routine (08:00 Irkutsk, or on-demand).
// In Irkutsk (UTC+8), 08:00 is 00:00 UTC.

export const BOARD_JANITOR_ENABLED_ENV = "MYRMIDON_BOARD_JANITOR_ENABLED";
export const BOARD_JANITOR_RUN_HOUR_IRKUTSK_ENV = "MYRMIDON_BOARD_JANITOR_RUN_HOUR_IRKUTSK";
export const BOARD_JANITOR_SERVICE_TICKET_ID_ENV = "MYRMIDON_BOARD_JANITOR_SERVICE_TICKET_ID";
export const BOARD_JANITOR_SERVICE_AGENT_ID_ENV = "MYRMIDON_BOARD_JANITOR_SERVICE_AGENT_ID";

/** Default service ticket for the janitor report document (OPE-9758). */
export const DEFAULT_BOARD_JANITOR_SERVICE_TICKET_ID = "a8529883-ab02-4998-a5ab-d70cd81560f8";

/** Default service agent ID (adm infra lead). */
export const DEFAULT_BOARD_JANITOR_SERVICE_AGENT_ID = "b018f9bf-3f76-48d5-9530-aa9b0bf917f9";

/** 08:00 Irkutsk time is 00:00 UTC. */
export const DEFAULT_BOARD_JANITOR_RUN_HOUR_IRKUTSK = 8;

export interface BoardJanitorSettings {
  enabled: boolean;
  runHourIrkutsk: number;
  serviceTicketId: string;
  serviceAgentId: string;
}

export function readBoardJanitorSettings(
  env: NodeJS.ProcessEnv = process.env,
): BoardJanitorSettings {
  const rawEnabled = env[BOARD_JANITOR_ENABLED_ENV];
  const enabled = rawEnabled === undefined
    ? true
    : !["0", "false", "no", "off"].includes(rawEnabled.trim().toLowerCase());

  const rawHour = env[BOARD_JANITOR_RUN_HOUR_IRKUTSK_ENV];
  const parsedHour = rawHour !== undefined ? Number.parseInt(rawHour, 10) : NaN;
  const runHourIrkutsk = Number.isInteger(parsedHour) && parsedHour >= 0 && parsedHour <= 23
    ? parsedHour
    : DEFAULT_BOARD_JANITOR_RUN_HOUR_IRKUTSK;

  const serviceTicketId = env[BOARD_JANITOR_SERVICE_TICKET_ID_ENV]?.trim() || DEFAULT_BOARD_JANITOR_SERVICE_TICKET_ID;
  const serviceAgentId = env[BOARD_JANITOR_SERVICE_AGENT_ID_ENV]?.trim() || DEFAULT_BOARD_JANITOR_SERVICE_AGENT_ID;

  return {
    enabled,
    runHourIrkutsk,
    serviceTicketId,
    serviceAgentId,
  };
}

/**
 * Checks whether the daily run should trigger at the given time.
 * Irkutsk is UTC+8. Hour in Irkutsk = (UTC hour + 8) % 24.
 */
export function isDueForDailyRun(now: Date, lastRunAt: Date | null, targetHourIrkutsk: number): boolean {
  if (!lastRunAt) return true;

  // Calculate current date in Irkutsk timezone
  const utcMs = now.getTime();
  const irkutskOffsetMs = 8 * 60 * 60 * 1000;
  const irkutskNow = new Date(utcMs + irkutskOffsetMs);
  const irkutskLastRun = new Date(lastRunAt.getTime() + irkutskOffsetMs);

  const isSameDay =
    irkutskNow.getUTCFullYear() === irkutskLastRun.getUTCFullYear() &&
    irkutskNow.getUTCMonth() === irkutskLastRun.getUTCMonth() &&
    irkutskNow.getUTCDate() === irkutskLastRun.getUTCDate();

  if (isSameDay) return false;

  // Has the target hour in Irkutsk arrived today?
  return irkutskNow.getUTCHours() >= targetHourIrkutsk;
}

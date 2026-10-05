// server/src/myrmidon/telegram-voice-stt-intake/settings.ts
//
// myrmidon(1.6.1 VOICE-STT B): switch and contract seam for transcribing
// Telegram voice/audio messages at inbound intake.
//
// The vendor intake path is unchanged unless this feature is enabled. Until the
// shared STT core (module `server/src/myrmidon/stt/`) is merged, the
// transcription hook is optional: the wiring in chat-channels passes one when
// the module is available, and the setting is read per delivery, so the same
// seam works with a mock in tests and with the real core after it lands.
//
// The env shape mirrors the other myrmidon switches (for example
// telegram-dm-status-settings.ts): off by default, truthy values enable,
// anything else keeps the vendor behavior byte for byte.

export const TELEGRAM_VOICE_STT_ENV = "MYRMIDON_TELEGRAM_VOICE_STT";

/**
 * myrmidon(1.6.5 VOICE-STT A): the environment master switch as three states
 * — `true`, `false` (an explicit off is the operator's kill switch) and
 * `null` for "not set here" (unset, empty or an unrecognised value), which
 * lets the caller fall back to the company's stored setting.
 */
export function readTelegramVoiceSttSwitch(
  env?: Record<string, string | undefined>,
): boolean | null {
  const source =
    env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env ??
    {};
  const raw = source[TELEGRAM_VOICE_STT_ENV]?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on")
    return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off")
    return false;
  return null;
}

/**
 * Whether inbound Telegram voice/audio turns get their transcript written into
 * the task comment next to the attachment. Off by default: with the setting
 * unset the vendor intake path makes no transcription call and produces the
 * same comment body as before.
 *
 * myrmidon(1.6.5 VOICE-STT A): the environment variable is the instance
 * master switch and wins in both directions when it is set; when it is unset
 * the company's own stored switch (the board's STT settings screen, part C)
 * decides — so the feature can be turned on per company without a restart.
 * `companyEnabled` is undefined for callers that do not read the stored
 * setting at all (tests, other providers): the result is then exactly the
 * pre-1.6.5 env-only behaviour.
 */
export function telegramVoiceSttEnabled(
  env?: Record<string, string | undefined>,
  companyEnabled?: boolean | null,
): boolean {
  const master = readTelegramVoiceSttSwitch(env);
  if (master !== null) return master;
  return companyEnabled === true;
}

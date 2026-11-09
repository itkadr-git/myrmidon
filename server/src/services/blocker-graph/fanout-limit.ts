import { instanceGeneralSettingsSchema } from "@myrmidon/shared";
import { DEFAULT_ROOT_FANOUT_LIMIT } from "./evaluate-alert.js";

/**
 * myrmidon(1.6.6 P1.10): read the persisted root fan-out alert limit from an
 * `instance_settings.general` row (the exact stored shape the settings
 * contract defines). An absent, unparsable, or out-of-range value means the
 * default (10) — the same "absent means default, invalid row still parses"
 * posture the neighbouring general keys use, so a hand-edited row cannot
 * break alert evaluation.
 */
export function blockerRootFanoutAlertLimitFromSettings(
  generalRow: unknown,
): number {
  const parsed = instanceGeneralSettingsSchema.strip().safeParse(generalRow ?? {});
  if (!parsed.success) return DEFAULT_ROOT_FANOUT_LIMIT;
  const limit = parsed.data.blockerRootFanoutAlertLimit;
  return typeof limit === "number" && Number.isInteger(limit) && limit >= 1
    ? limit
    : DEFAULT_ROOT_FANOUT_LIMIT;
}

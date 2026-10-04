// server/src/myrmidon/telegram-dm-progress/sweep.ts
//
// myrmidon(DM-PROGRESS): the settings reader the chat milestone sweep uses —
// the instance settings row of `db`, with the short cache of settings.ts.
// Kept apart from service.ts so the sweep (a vendor service module) does not
// pull the services barrel in.

import type { Db } from "@paperclipai/db";
import type { ResolvedTelegramDmProgress } from "@paperclipai/shared";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { readTelegramDmProgressSettings } from "./settings.js";

export function readTelegramDmProgressForSweep(db: Db): Promise<ResolvedTelegramDmProgress> {
  const settings = instanceSettingsService(db);
  return readTelegramDmProgressSettings({ getGeneral: () => settings.getGeneral() });
}

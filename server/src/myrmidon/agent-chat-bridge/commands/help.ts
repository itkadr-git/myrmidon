// myrmidon(X8c): /help, /start, /commands.
// myrmidon(1.7-TG-LOCALE): the intro and footer render from the locale
// catalogs in the chat owner's language.

import { t, type BridgeLocale } from "../locales/index.js";
import type { BridgedCommandSpec } from "./index.js";

export function buildHelpText(
  agentName: string,
  commands: readonly BridgedCommandSpec[],
  locale: BridgeLocale,
): string {
  const lines = [
    t(locale, "help.intro", { agent: agentName }),
    "",
  ];
  for (const command of commands) {
    lines.push(t(locale, "help.menuLine", { command: command.command, description: command.description }));
  }
  lines.push("");
  lines.push(t(locale, "help.footer"));
  return lines.join("\n");
}

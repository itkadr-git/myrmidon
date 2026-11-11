// myrmidon(UI-0a): the ui2 tree root. Contract with UI-0b: its language
// provider mounts HERE as ONE line (first merge wins) — the tree is otherwise
// self-contained. The root carries the lang attribute the theme keys the RU
// display-font switch on ([lang="ru"] swaps --myr-font-display to Exo 2),
// defaulted to the active i18next language.
import type { ReactNode } from "react";
import { i18n } from "@/i18n";
import { Ui2Shell } from "./shell/Ui2Shell";
import { Ui2I18nProvider } from "./i18n/Ui2I18n";

export function Ui2Root({ children }: { children?: ReactNode }) {
  // Keep the UI2 provider above the shell so navigation chrome shares the locale.
  return (
    <Ui2I18nProvider>
      <Ui2Shell>
        {children}
      </Ui2Shell>
    </Ui2I18nProvider>
  );
}

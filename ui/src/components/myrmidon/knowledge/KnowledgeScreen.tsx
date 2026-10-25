// myrmidon(1.6.6 KNOWLEDGE, OPE-9222): the "Knowledge" screen of the current
// interface (not UI2). It mounts the finished UI2 reader (search, page tree,
// sources, backlinks, revisions) at `/wiki` and `/wiki/:spaceKey/:slug`; the
// data comes from the knowledge module REST facade through the same client the
// UI2 screen uses. The UI2 screen reads its texts through a Ui2I18nProvider, so
// the provider is seeded here from the language of the current interface.
import { useEffect } from "react";
import { useTranslation } from "@/i18n";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Ui2I18nProvider } from "@/ui2/i18n/Ui2I18n";
import { isUi2Locale } from "@/ui2/i18n/Ui2I18n";
import { UI2_DEFAULT_LOCALE } from "@/ui2/i18n/locales";
import { Ui2Knowledge } from "@/ui2/screens/knowledge/Ui2Knowledge";

export const KNOWLEDGE_BASE_PATH = "/wiki";

export function KnowledgeScreen() {
  const { t, i18n } = useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const language = (i18n?.language ?? "").slice(0, 2).toLowerCase();
  const locale = isUi2Locale(language) ? language : UI2_DEFAULT_LOCALE;

  useEffect(() => {
    setBreadcrumbs([{ label: t("nav.knowledge") }]);
  }, [setBreadcrumbs, t]);

  return (
    <Ui2I18nProvider key={locale} initialLocale={locale}>
      <Ui2Knowledge basePath={KNOWLEDGE_BASE_PATH} />
    </Ui2I18nProvider>
  );
}
